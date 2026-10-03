// A-P4-OUTBOX · 真实本地 D1，MailProvider 一律替身；合成身份/验证码不代表真实发送。
import { env } from "cloudflare:test";
import {
  BUDGET_PERIOD_KIND,
  EXECUTOR_BATCH_WALL_LIMIT,
  OTP_DIGITS,
  OTP_TTL,
  SECRET_BITS,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearExpiredOtpPayloads } from "../../auth/challenges/cleanup";
import { encryptOtpPayload, OTP_PAYLOAD_KIND } from "../../auth/challenges/payload";
import { DeliveryRuntime } from "../../executors/delivery/runtime";
import { seedOperationalControls } from "../../shell/observability/test-support";
import { Keyring } from "../../storage/crypto/keyring";
import { readMailDayLedger, reserveMailBudget } from "../../storage/ledger/mail-ledger";
import { splitSqlStatements } from "../../storage/split-sql";
import { withMailAdmission } from "../provider/admission";
import {
  MAIL_AVAILABILITY_KEY,
  mailAvailable,
  pauseMail,
  requireMailAvailable,
} from "../provider/availability";
import { NativeMailProvider } from "../provider/native";
import { authTemplate, digestTemplate } from "../provider/templates";
import type { MailResult, ServerMail } from "../provider/types";
import { type SendDeps, sendOneMail, tryAuthMailFastPath } from "./send";
import {
  claimMail,
  MAIL_CLAIM_CANDIDATE_SQL,
  recordMailReceipt,
  repairMailPage,
  transitionMail,
} from "./state";
import { type MailRow, mailJobId } from "./types";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T = Date.parse("2026-09-30T12:00:00Z");
let now = T,
  serial = 0;
const id = () => `synthetic403_${++serial}`;
let keys: Keyring;
const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
const row = (outboxId: string) =>
  env.DB.prepare("SELECT * FROM mail_outbox WHERE id=?").bind(outboxId).first<MailRow>();
let sent: ServerMail[], result: MailResult;
function deps(extra: Partial<SendDeps> = {}): SendDeps {
  return {
    db: env.DB,
    now: () => now,
    origin: "https://synthetic.example",
    fieldKey: async () => keys.fieldEncryption(),
    available: async () => true,
    pause: async () => {},
    provider: {
      send: async (mail) => {
        sent.push(mail);
        return result;
      },
    },
    ...extra,
  };
}
async function seed(reserved = true, at = T) {
  const oid = id(),
    cid = id();
  const payload = await encryptOtpPayload(keys.fieldEncryption(), oid, {
    challengeId: cid,
    generation: 0,
    code: "2".repeat(OTP_DIGITS),
    address: "Synthetic.User@example.com",
  });
  await run(
    `INSERT INTO auth_challenges(id,purpose,email_key,address_version,preauth_id,mac,generation,deadline,created_at,updated_at)
    VALUES (?,'signup',?,0,?,'synthetic-mac',0,?,?,?)`,
    cid,
    id(),
    id(),
    at + OTP_TTL * 1000,
    at,
    at,
  );
  await run(
    `INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,payload_ref,payload_ciphertext,status,created_at,updated_at)
    VALUES (?,'new_registration',0,'',0,?,?,?,'pending',?,?)`,
    oid,
    OTP_PAYLOAD_KIND,
    cid,
    payload,
    at,
    at,
  );
  if (reserved)
    expect(
      (
        await reserveMailBudget(env.DB, {
          intent: "signup_auth",
          period: utcDayPeriod(at),
          now: at,
          outboxId: oid,
        })
      ).outcome,
    ).toBe("committed");
  return oid;
}
async function budget() {
  return (await readMailDayLedger(env.DB, utcDayPeriod(T).key)).pools.new_registration;
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  keys = await Keyring.create({
    masterSecret: new Uint8Array(SECRET_BITS / 8).fill(3),
    otpPepper: new Uint8Array(SECRET_BITS / 8).fill(7),
    unsubscribeMacCurrentKeyId: "synthetic",
  });
});
beforeEach(async () => {
  for (const table of [
    "deliveries",
    "recent_auth_challenges",
    "auth_challenges",
    "mail_outbox",
    "jobs",
    "usage_periods",
    "suppressions",
    "sessions",
    "users",
    "system_state",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
  now = T;
  sent = [];
  result = { kind: "accepted", messageId: `<${id()}>` };
  await seedOperationalControls(env.DB);
});
describe("A-P4-OUTBOX 租约与外部不确定边界", () => {
  it("P5 全部外发关闭阻断认证；业务关闭不影响认证", async () => {
    const oid = await seed();
    await run(
      "UPDATE system_state SET value_json='false' WHERE key IN ('business_mail_enabled','email_routine_enabled')",
    );
    await sendOneMail(deps(), "background", oid);
    expect(sent).toHaveLength(1);
    const closed = await seed();
    await run("UPDATE system_state SET value_json='false' WHERE key='outbound_enabled'");
    await sendOneMail(deps(), "background", closed);
    expect(sent).toHaveLength(1);
    expect((await row(closed))?.status).toBe("retry_wait");
    expect((await row(closed))?.attempts).toBe(0);
  });
  it("P5 准备期间关全部外发不得调用供应商", async () => {
    const oid = await seed();
    await sendOneMail(
      deps({
        fieldKey: async () => {
          await run("UPDATE system_state SET value_json='false' WHERE key='outbound_enabled'");
          return keys.fieldEncryption();
        },
      }),
      "background",
      oid,
    );
    expect(sent).toHaveLength(0);
    expect((await row(oid))?.status).toBe("retry_wait");
    expect(await budget()).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
  });

  it("A-P5-OBS 最终 calling_provider batch 前关全部外发，拒绝外调且保留预留", async () => {
    const oid = await seed();
    const callingStatements = new WeakSet<D1PreparedStatement>();
    const beforeFinalBatch: {
      outbound: string | null;
      mail: MailRow | null;
      budget: Awaited<ReturnType<typeof budget>>;
    }[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("UPDATE mail_outbox SET status = ?")) return statement;
            return new Proxy(statement, {
              get(stmt, prop) {
                if (prop === "bind")
                  return (...params: unknown[]) => {
                    const bound = stmt.bind(...params);
                    if (params[0] === "calling_provider") callingStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(stmt, prop);
                return typeof value === "function" ? value.bind(stmt) : value;
              },
            });
          };
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => callingStatements.has(statement))) {
              // 仅在最终 batch 真正执行前插入并发关闸；prepare/bind 和预检查均不改开关。
              beforeFinalBatch.push({
                outbound: await target
                  .prepare("SELECT value_json FROM system_state WHERE key='outbound_enabled'")
                  .first<string>("value_json"),
                mail: await row(oid),
                budget: await budget(),
              });
              await run("UPDATE system_state SET value_json='false' WHERE key='outbound_enabled'");
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await sendOneMail(deps({ db }), "background", oid);
    expect(beforeFinalBatch).toHaveLength(1);
    expect(beforeFinalBatch[0]).toMatchObject({
      outbound: "true",
      mail: { status: "leased", attempts: 0 },
      budget: { reserved: 1, settled: 0, uncertain: 0 },
    });
    expect(sent).toHaveLength(0);
    expect(await row(oid)).toMatchObject({ status: "retry_wait", attempts: 0 });
    expect(await budget()).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
  });

  it("HTTP 与后台真实并发竞争同一租约，只外调一次；accepted 结算并清除载荷", async () => {
    const oid = await seed();
    const d = deps();
    await Promise.all([sendOneMail(d, "background"), tryAuthMailFastPath(d, oid)]);
    expect(sent).toHaveLength(1);
    expect(await row(oid)).toMatchObject({
      status: "accepted",
      attempts: 1,
      message_id: result.kind === "accepted" ? result.messageId : "",
      payload_ciphertext: null,
    });
    expect(await budget()).toEqual({ reserved: 0, settled: 1, uncertain: 0 });
    expect(
      (
        await env.DB.prepare("SELECT payload_json FROM jobs WHERE id=?")
          .bind(mailJobId(oid))
          .first<{ payload_json: string }>()
      )?.payload_json,
    ).toContain("submitted");
  });
  it("不领取未预留预算、旧日预算、superseded 行", async () => {
    const unreserved = await seed(false),
      old = await seed(true, T - 24 * 60 * 60 * 1000),
      superseded = await seed();
    await run("UPDATE mail_outbox SET status='superseded' WHERE id=?", superseded);
    expect(await sendOneMail(deps(), "background")).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await row(unreserved))?.status).toBe("pending");
    expect((await row(old))?.status).toBe("pending");
  });
  it("过期 leased 可恢复；旧租约不能调用或覆盖新进度", async () => {
    const oid = await seed(),
      first = await claimMail(env.DB, "first", now, oid);
    expect(first).not.toBeNull();
    if (!first) return;
    now += EXECUTOR_BATCH_WALL_LIMIT * 1000;
    await repairMailPage(env.DB, now);
    const next = await claimMail(env.DB, "next", now, oid);
    expect(next?.lease_version).toBeGreaterThan(first.lease_version);
    expect(
      await transitionMail(env.DB, first, now, {
        status: "calling_provider",
        budget: { from: "reserved", to: "uncertain" },
      }),
    ).toBe(false);
    expect((await row(oid))?.lease_owner).toBe("next");
    expect(await budget()).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
  });
  it("外部接受后本地未落账的崩溃恢复成 unknown，不退款、不盲重发", async () => {
    const oid = await seed(),
      leased = await claimMail(env.DB, "crashed", now, oid);
    if (!leased) throw Error("lease");
    expect(
      await transitionMail(env.DB, leased, now, {
        status: "calling_provider",
        budget: { from: "reserved", to: "uncertain" },
      }),
    ).toBe(true);
    now += EXECUTOR_BATCH_WALL_LIMIT * 1000;
    await repairMailPage(env.DB, now);
    await repairMailPage(env.DB, now);
    expect((await row(oid))?.status).toBe("unknown");
    expect(await budget()).toEqual({ reserved: 0, settled: 0, uncertain: 1 });
    expect(await sendOneMail(deps(), "watchdog")).toBe(false);
    expect(sent).toHaveLength(0);
    expect(
      await transitionMail(env.DB, { ...leased, status: "calling_provider" }, now, {
        status: "accepted",
        messageId: "late",
        budget: { from: "uncertain", to: "settled" },
      }),
    ).toBe(false);
  });
  it.each(["generation", "consumed", "expired"])(
    "认证发送前 %s 失效：不调用并原子释放预留",
    async (kind) => {
      const oid = await seed();
      await run(
        `UPDATE auth_challenges SET ${kind === "generation" ? "generation=1" : kind === "consumed" ? "consumed_at=1" : "deadline=0"} WHERE id=(SELECT payload_ref FROM mail_outbox WHERE id=?)`,
        oid,
      );
      await sendOneMail(deps(), "worker");
      expect(sent).toHaveLength(0);
      expect((await row(oid))?.status).toBe(kind === "expired" ? "expired" : "superseded");
      expect(await budget()).toEqual({ reserved: 0, settled: 0, uncertain: 0 });
    },
  );
  it("复核读取之后挑战被消费，calling_provider 事务守卫拒绝外调", async () => {
    const oid = await seed();
    let reads = 0;
    await sendOneMail(
      deps({
        available: async () => {
          if (++reads === 2) await run("UPDATE auth_challenges SET consumed_at=?", now);
          return true;
        },
      }),
      "worker",
    );
    expect(sent).toHaveLength(0);
    expect((await row(oid))?.status).toBe("retry_wait");
    expect((await budget()).reserved).toBe(1);
  });
  it("未知结果保留不确定占用、不暂停后续发送；明确失败消耗预算", async () => {
    const oid = await seed();
    let paused = 0;
    result = { kind: "unknown", reason: "synthetic_network", pause: false };
    await sendOneMail(
      deps({
        pause: async () => {
          paused++;
        },
      }),
      "worker",
    );
    expect((await row(oid))?.status).toBe("unknown");
    expect((await budget()).uncertain).toBe(1);
    expect(paused).toBe(0);
    result = { kind: "rejected", retryable: false, reason: "synthetic_rejection", pause: false };
    const second = await seed();
    await sendOneMail(deps(), "worker");
    expect((await row(second))?.status).toBe("rejected");
    expect((await budget()).settled).toBe(1);
  });
  it("明确可重试拒绝停 retry_wait；不会复用已经消耗的预算自动外调", async () => {
    const oid = await seed();
    result = { kind: "rejected", retryable: true, reason: "synthetic_rate", pause: true };
    await sendOneMail(deps(), "worker");
    now += WATCHDOG_INTERVAL * 1000;
    await repairMailPage(env.DB, now);
    expect((await row(oid))?.status).toBe("retry_wait");
    expect(await sendOneMail(deps(), "worker")).toBe(false);
    expect(sent).toHaveLength(1);
    expect((await budget()).settled).toBe(1);
  });
  it("外调前暂时故障下一 watchdog 才重试，确定性坏载荷终止并释放", async () => {
    const oid = await seed();
    await sendOneMail(
      deps({
        fieldKey: async () => {
          throw new Error("temporary");
        },
      }),
      "worker",
    );
    expect((await row(oid))?.status).toBe("retry_wait");
    expect(await repairMailPage(env.DB, now)).toBe(0);
    now += WATCHDOG_INTERVAL * 1000;
    await repairMailPage(env.DB, now);
    expect((await row(oid))?.status).toBe("pending");
    await run("UPDATE mail_outbox SET payload_kind='invalid' WHERE id=?", oid);
    await sendOneMail(deps(), "worker");
    expect((await row(oid))?.status).toBe("failed");
    expect(sent).toHaveLength(0);
    expect((await budget()).reserved).toBe(0);
  });
  it("守卫零行无副作用；SQL 错误回滚 outbox、预算及 jobs", async () => {
    const oid = await seed(),
      leased = await claimMail(env.DB, "test", now, oid);
    if (!leased) throw Error("lease");
    await env.DB.exec(
      `CREATE TRIGGER synthetic_abort_job BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'synthetic_abort'); END`,
    );
    try {
      await expect(
        transitionMail(env.DB, leased, now, {
          status: "calling_provider",
          budget: { from: "reserved", to: "uncertain" },
        }),
      ).rejects.toThrow();
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_abort_job");
    }
    expect((await row(oid))?.status).toBe("leased");
    expect(await budget()).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
  });
  it("deferred 不重投；delivered 与 submitted 分开，投诉/退信不被晚到成功覆盖", async () => {
    const oid = await seed();
    await sendOneMail(deps(), "worker");
    const mid = (await row(oid))?.message_id;
    if (!mid) throw new Error("missing_message_id");
    expect(await recordMailReceipt(env.DB, mid, "deferred", now)).toBe(true);
    expect(await sendOneMail(deps(), "worker")).toBe(false);
    expect(await recordMailReceipt(env.DB, mid, "delivered", now)).toBe(true);
    expect(await recordMailReceipt(env.DB, mid, "deferred", now)).toBe(false);
    expect(await recordMailReceipt(env.DB, mid, "complained", now)).toBe(true);
    expect(await recordMailReceipt(env.DB, mid, "delivered", now)).toBe(false);
    expect((await row(oid))?.status).toBe("complained");
    expect(sent).toHaveLength(1);
  });
  it("暂停/缺配置不建挑战，提交成功后唤醒失败不撤销结果", async () => {
    expect(await mailAvailable(env.DB)).toBe(false);
    const create = vi.fn(async () => seed());
    await expect(
      withMailAdmission(
        env,
        { check: async () => requireMailAvailable(env.DB), committed: async () => {} },
        create,
        { waitUntil() {} },
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'true',?)",
      MAIL_AVAILABILITY_KEY,
      now,
    );
    expect(await mailAvailable(env.DB)).toBe(true);
    await expect(
      withMailAdmission(
        env,
        {
          check: async () => requireMailAvailable(env.DB),
          committed: async () => {
            throw Error("wake");
          },
        },
        async () => "committed",
        { waitUntil() {} },
      ),
    ).resolves.toBe("committed");
    await pauseMail(env.DB, now);
    expect(await mailAvailable(env.DB)).toBe(false);
    const oid = await seed();
    expect(await sendOneMail(deps({ available: async () => false }), "worker")).toBe(false);
    expect((await row(oid))?.status).toBe("pending");
  });
  it("执行器到墙钟即停，仍保留待办；暂停时不安排发送热循环", async () => {
    await seed();
    await seed();
    const d = deps({
      provider: {
        send: async (mail) => {
          sent.push(mail);
          now += EXECUTOR_BATCH_WALL_LIMIT * 1000;
          return result;
        },
      },
    });
    const runtime = new DeliveryRuntime(d);
    await runtime.tick();
    expect(sent).toHaveLength(1);
    expect(await runtime.nextAlarm()).toBe(now);
    expect(
      await new DeliveryRuntime(deps({ available: async () => false })).nextAlarm(),
    ).toBeNull();
  });
});
describe("A-P4-OUTBOX 原生适配器与固定模板", () => {
  it("按用途选 binding/from，单收件人；认证主题不含 OTP、不附业务头", async () => {
    const a = vi.fn(async (_mail: unknown) => ({ messageId: "<auth>" })),
      b = vi.fn(async () => ({ messageId: "<biz>" }));
    const p = new NativeMailProvider({
      auth: { send: a },
      business: { send: b },
      authSender: "auth@example.com",
      businessSender: "biz@example.com",
    });
    const mail = authTemplate(
      "recipient@example.com",
      "2".repeat(OTP_DIGITS),
      now + OTP_TTL * 1000,
    );
    expect(
      await p.send({
        ...mail,
        unsubscribe: {
          page: "https://synthetic.example/unsub",
          oneClick: "https://synthetic.example/one",
        },
      }),
    ).toEqual({ kind: "accepted", messageId: "<auth>" });
    expect(a.mock.calls[0]?.[0]).toMatchObject({
      from: "auth@example.com",
      to: "recipient@example.com",
    });
    expect(a.mock.calls[0]?.[0]).not.toHaveProperty("headers");
    expect(mail.subject).not.toContain("2".repeat(OTP_DIGITS));
    expect(b).not.toHaveBeenCalled();
  });
  it.each([
    "E_RECIPIENT_SUPPRESSED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_DAILY_LIMIT_EXCEEDED",
    "E_SENDER_NOT_VERIFIED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_INTERNAL_SERVER_ERROR",
    "unrecognized",
  ])("供应商 %s 不会误判成功且不泄露错误原文", async (code) => {
    const binding = {
      send: async () => {
        throw Object.assign(new Error("sensitive provider message"), { code });
      },
    };
    const p = new NativeMailProvider({
      auth: binding,
      business: binding,
      authSender: "auth@example.com",
      businessSender: "biz@example.com",
    });
    const r = await p.send(authTemplate("recipient@example.com", "2".repeat(OTP_DIGITS), now));
    expect(r.kind).toBe(
      code === "E_INTERNAL_SERVER_ERROR" || code === "unrecognized" ? "unknown" : "rejected",
    );
    expect(r).toMatchObject({
      pause: [
        "E_RATE_LIMIT_EXCEEDED",
        "E_DAILY_LIMIT_EXCEEDED",
        "E_SENDER_NOT_VERIFIED",
        "E_SENDER_DOMAIN_NOT_AVAILABLE",
      ].includes(code),
    });
    expect(JSON.stringify(r)).not.toContain("sensitive");
  });
  it("缺 messageId 归 unknown；模板转义文字、保留精度和链接、拒绝脚本 URL", async () => {
    const binding = { send: async () => ({ messageId: "" }) };
    expect(
      (
        await new NativeMailProvider({
          auth: binding,
          business: binding,
          authSender: "auth@example.com",
          businessSender: "biz@example.com",
        }).send(authTemplate("recipient@example.com", "2".repeat(OTP_DIGITS), now))
      ).kind,
    ).toBe("unknown");
    const node = {
      event_title: "<img src=x>",
      node_title: "合成截止",
      node_type: "end",
      kind: "important_change",
      time_exact_ms: null,
      time_date: "2026-10-01",
      time_precision: "date",
      source_timezone: "Asia/Shanghai",
      time_basis: "official_estimate",
      raw_expression: "某日",
      reason: "官方调整",
      official_url: "https://official.example/info",
      detail_path: "/events/synthetic",
    };
    const m = digestTemplate("recipient@example.com", [node], "https://synthetic.example", {
      page: "https://synthetic.example/unsubscribe/synthetic",
      oneClick: "https://synthetic.example/email/one-click/synthetic",
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
    expect(m.text).toContain("2026-10-01");
    expect(m.text).not.toContain("T00:00");
    expect(m.text).toContain("Asia/Shanghai");
    expect(m.text).toContain("官方调整");
    expect(() =>
      digestTemplate(
        "recipient@example.com",
        [{ ...node, official_url: "javascript:alert(1)" }],
        "https://synthetic.example",
        m.unsubscribe ?? { page: "", oneClick: "" },
      ),
    ).toThrow();
  });
});

// 让清理 SELECT 与写入之间实际插入发送器提交，复现两个执行器的合法交错。
it("A-P4-OUTBOX 过期清理与 calling_provider 竞争不能退掉另一封信的预算", async () => {
  const oid = await seed();
  const other = await seed();
  await run(
    "UPDATE auth_challenges SET deadline=deadline+? WHERE id=(SELECT payload_ref FROM mail_outbox WHERE id=?)",
    OTP_TTL * 1000,
    other,
  );
  const leased = await claimMail(env.DB, "racing", T + OTP_TTL * 1000 - 1, oid);
  if (!leased) throw Error("lease");
  const late = T + OTP_TTL * 1000;
  let intercepted = false;
  const raced = new Proxy(env.DB, {
    get(target, prop) {
      if (prop !== "prepare") {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(stmt, key) {
              if (key === "bind") return (...params: unknown[]) => wrap(stmt.bind(...params));
              if (key === "all" && sql.includes("UNION") && sql.includes("recent_auth_challenges"))
                return async () => {
                  const result = await stmt.all();
                  if (!intercepted) {
                    intercepted = true;
                    await transitionMail(env.DB, leased, late - 1, {
                      status: "calling_provider",
                      budget: { from: "reserved", to: "uncertain" },
                    });
                  }
                  return result;
                };
              const value = Reflect.get(stmt, key);
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        return wrap(target.prepare(sql));
      };
    },
  });
  await clearExpiredOtpPayloads(raced, late);
  expect(intercepted).toBe(true);
  // 第二封尚未过期，reserved 必须保留；第一封已经越过调用边界，uncertain 保留。
  expect((await row(oid))?.status).toBe("calling_provider");
  expect(await budget()).toEqual({ reserved: 1, settled: 0, uncertain: 1 });
});

it.each([false, true])(
  "A-P4-OUTBOX 最近认证新地址邮件读取独立挑战，撤销会话=%s",
  async (revoked) => {
    const oid = await seed(false),
      original = await row(oid);
    if (!original) throw Error("outbox");
    const uid = id(),
      sid = id(),
      binding = id();
    await run(
      `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,1,'active',?,?,?,1,?,?)`,
      uid,
      id(),
      binding,
      new Uint8Array([1]),
      T,
      T,
    );
    await run(
      `INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at)
    VALUES (?,?,?,?,'synthetic','desktop',?,?,?,?,0,0,?,?)`,
      sid,
      uid,
      id(),
      revoked ? "revoked" : "active",
      T,
      T + OTP_TTL * 1000,
      T + OTP_TTL * 1000,
      T,
      T,
      T,
    );
    await run("DELETE FROM auth_challenges WHERE id=?", original.payload_ref);
    await run(
      "UPDATE mail_outbox SET recipient_user_id=?,address_version=1,purpose='existing_auth' WHERE id=?",
      uid,
      oid,
    );
    await run(
      `INSERT INTO recent_auth_challenges(id,user_id,session_id,idempotency_key,action,role,target_digest,email_key,address_version,mac,deadline,outbox_id,created_at,updated_at)
    VALUES (?,?,?,?,'email_change','new_address','synthetic',?,1,'synthetic',?,?,?,?)`,
      original.payload_ref,
      uid,
      sid,
      id(),
      id(),
      T + OTP_TTL * 1000,
      oid,
      T,
      T,
    );
    await run(
      "INSERT INTO suppressions(id,address_key,email_binding_id,kind,created_at) VALUES (?,?,?,'hard_bounce',?)",
      id(),
      id(),
      binding,
      T,
    );
    await reserveMailBudget(env.DB, {
      intent: "account_change_auth",
      period: utcDayPeriod(T),
      now: T,
      outboxId: oid,
    });
    await sendOneMail(deps(), "worker");
    expect(sent).toHaveLength(revoked ? 0 : 1);
    expect((await row(oid))?.status).toBe(revoked ? "skipped" : "accepted");
  },
);
it("A-P4-OUTBOX 供应商一直不返回时受批次剩余墙钟限制，unknown 保留预算", async () => {
  const oid = await seed();
  await sendOneMail(
    deps({ batchDeadline: T + 1, provider: { send: () => new Promise(() => {}) } }),
    "worker",
  );
  expect((await row(oid))?.status).toBe("unknown");
  expect((await budget()).uncertain).toBe(1);
});

it("A-P4-OUTBOX 领取热查询加入大量终态历史后 rows_read 不增长", async () => {
  await seed();
  const read = () =>
    env.DB.prepare(MAIL_CLAIM_CANDIDATE_SQL)
      .bind(utcDayPeriod(T).key, null, null, BUDGET_PERIOD_KIND)
      .all();
  const before = (await read()).meta.rows_read;
  await env.DB.batch(
    Array.from({ length: 500 }, (_, n) =>
      env.DB.prepare(`INSERT INTO mail_outbox
    (id,purpose,priority,period_key,address_version,payload_kind,status,created_at,updated_at)
    VALUES (?,'existing_auth',0,'synthetic-history',0,'synthetic','accepted',?,?)`).bind(
        `synthetic_history_${n}`,
        T - n,
        T - n,
      ),
    ),
  );
  expect((await read()).meta.rows_read).toBe(before);
});

it.each(["bounced", "failed", "rejected"] as const)(
  "A-P4-OUTBOX accepted → %s 后晚到成功不得覆盖",
  async (receipt) => {
    const oid = await seed();
    await sendOneMail(deps(), "worker");
    const mid = (await row(oid))?.message_id;
    if (!mid) throw Error("message");
    expect(await recordMailReceipt(env.DB, mid, receipt, now)).toBe(true);
    expect(await recordMailReceipt(env.DB, mid, "delivered", now)).toBe(false);
    expect((await row(oid))?.status).toBe(receipt);
    expect((await budget()).settled).toBe(1);
  },
);
it("A-P4-OUTBOX 缺失业务收件人的坏数据终止，不会将聚合预算退款两次", async () => {
  const oid = await seed(false);
  await run(
    "UPDATE mail_outbox SET purpose='base_business',payload_kind='notification_digest',payload_ref=id WHERE id=?",
    oid,
  );
  await reserveMailBudget(env.DB, {
    intent: "base_routine_or_announce",
    period: utcDayPeriod(T),
    now: T,
    outboxId: oid,
  });
  await sendOneMail(deps(), "worker");
  expect(sent).toHaveLength(0);
  expect((await row(oid))?.status).toBe("failed");
  expect((await readMailDayLedger(env.DB, utcDayPeriod(T).key)).pools.base_business).toEqual({
    reserved: 0,
    settled: 0,
    uncertain: 0,
  });
});

// 返工第 4 项：在领取后改变条件；不能让领取时校验掩盖调用边界缺守卫。
it.each(["lease_expired", "utc_day_changed"] as const)(
  "A-P4-OUTBOX calling_provider 前 %s 拒绝外调且不消耗预算",
  async (change) => {
    const at = change === "utc_day_changed" ? Date.parse("2026-09-30T23:59:59Z") : T;
    now = at;
    const oid = await seed(true, at);
    const period = utcDayPeriod(at);
    let checks = 0;
    await sendOneMail(
      deps({
        available: async () => {
          if (++checks === 2) {
            if (change === "lease_expired")
              await run("UPDATE mail_outbox SET lease_expires_at=? WHERE id=?", now, oid);
            else now += 1000;
          }
          return true;
        },
      }),
      "worker",
    );
    expect(sent).toHaveLength(0);
    expect(await row(oid)).toMatchObject({ status: "retry_wait", attempts: 0, sent_at: null });
    const ledger = await readMailDayLedger(env.DB, period.key);
    expect(ledger.pools.new_registration).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
  },
);
it("A-P4-OUTBOX 当前绑定已抑制的登录认证信不外调并释放预留", async () => {
  const oid = await seed(false),
    uid = id(),
    binding = id(),
    emailKey = id();
  await run(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,1,'active',?,?,?,1,?,?)`,
    uid,
    emailKey,
    binding,
    new Uint8Array([1]),
    T,
    T,
  );
  await run(
    "UPDATE auth_challenges SET purpose='login',email_key=?,address_version=1 WHERE id=(SELECT payload_ref FROM mail_outbox WHERE id=?)",
    emailKey,
    oid,
  );
  await run(
    "UPDATE mail_outbox SET recipient_user_id=?,address_version=1,purpose='existing_auth' WHERE id=?",
    uid,
    oid,
  );
  await run(
    "INSERT INTO suppressions(id,address_key,email_binding_id,kind,created_at) VALUES (?,?,?,'hard_bounce',?)",
    id(),
    id(),
    binding,
    T,
  );
  await reserveMailBudget(env.DB, {
    intent: "existing_auth_first_login",
    period: utcDayPeriod(T),
    now: T,
    outboxId: oid,
  });
  await sendOneMail(deps(), "worker");
  expect(sent).toHaveLength(0);
  expect(await row(oid)).toMatchObject({
    status: "skipped",
    attempts: 0,
    payload_ciphertext: null,
  });
  expect((await readMailDayLedger(env.DB, utcDayPeriod(T).key)).pools.existing_auth).toEqual({
    reserved: 0,
    settled: 0,
    uncertain: 0,
  });
});
it("A-P4-OUTBOX 一封坏邮件只终止自己，同批后续认证邮件继续发送", async () => {
  const bad = await seed(),
    good = await seed();
  await run("UPDATE mail_outbox SET payload_kind='invalid',created_at=? WHERE id=?", T - 1, bad);
  await new DeliveryRuntime(deps()).tick();
  expect(await row(bad)).toMatchObject({ status: "failed", attempts: 0 });
  expect(await row(good)).toMatchObject({ status: "accepted", attempts: 1 });
  expect(sent).toHaveLength(1);
  expect(await budget()).toEqual({ reserved: 0, settled: 1, uncertain: 0 });
  expect(
    await env.DB.prepare("SELECT id FROM jobs WHERE id='delivery:backoff'").first(),
  ).toBeNull();
});
it.each([false, true])(
  "A-P4-OUTBOX 业务扫描失败 terminal=%s 不停止下一轮认证发信",
  async (terminal) => {
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("AS start_version"))
              throw Error(terminal ? "too many SQL variables" : "temporary D1 failure");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = new DeliveryRuntime(deps({ db }));
    await runtime.tick();
    expect(
      await env.DB.prepare(
        "SELECT status FROM jobs WHERE id='delivery:occurrence-backoff'",
      ).first(),
    ).toEqual({ status: terminal ? "failed" : "pending" });
    const oid = await seed();
    expect(await runtime.nextAlarm()).toBe(T);
    await runtime.tick();
    expect(await row(oid)).toMatchObject({ status: "accepted" });
    expect(sent).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT id FROM jobs WHERE id='delivery:backoff'").first(),
    ).toBeNull();
  },
);

it.each(["timeout", "throw", "missing_id"] as const)(
  "A-P4-OUTBOX %s 仅该封 unknown，开关保持开放且下一封能发",
  async (failure) => {
    const first = await seed();
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
      T,
    );
    const binding = { send: async () => ({ messageId: "" }) };
    const provider =
      failure === "missing_id"
        ? new NativeMailProvider({
            auth: binding,
            business: binding,
            authSender: "auth@example.com",
            businessSender: "biz@example.com",
          })
        : {
            send: async () => {
              if (failure === "throw") throw Error("synthetic network");
              return new Promise<MailResult>(() => {});
            },
          };
    const pause = vi.fn(() => pauseMail(env.DB, now));
    await sendOneMail(
      deps({ provider, pause, ...(failure === "timeout" ? { batchDeadline: T + 1 } : {}) }),
      "worker",
    );
    expect(await row(first)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(await budget()).toEqual({ reserved: 0, settled: 0, uncertain: 1 });
    expect(pause).not.toHaveBeenCalled();
    expect(await mailAvailable(env.DB)).toBe(true);
    const next = await seed();
    await sendOneMail(deps({ available: () => mailAvailable(env.DB), pause }), "worker");
    expect(await row(next)).toMatchObject({ status: "accepted" });
    expect(sent).toHaveLength(1);
  },
);
it.each([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
])("A-P4-OUTBOX %s 仍关闭开关并拒绝新验证码", async (code) => {
  await seed();
  await run(
    "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
    T,
  );
  const binding = {
    send: async () => {
      throw { code };
    },
  };
  const provider = new NativeMailProvider({
    auth: binding,
    business: binding,
    authSender: "auth@example.com",
    businessSender: "biz@example.com",
  });
  await sendOneMail(deps({ provider, pause: () => pauseMail(env.DB, now) }), "worker");
  expect(await mailAvailable(env.DB)).toBe(false);
  await expect(requireMailAvailable(env.DB)).rejects.toThrow();
});

it("A-P4-OUTBOX 单封外调结果写回失败只落 unknown，下一封认证照发", async () => {
  const bad = await seed(),
    good = await seed();
  await run("UPDATE mail_outbox SET created_at=? WHERE id=?", T - 1, bad);
  await env.DB.exec(
    `CREATE TRIGGER synthetic_result_error BEFORE UPDATE ON mail_outbox WHEN NEW.status='accepted' AND NEW.id='${bad}' BEGIN SELECT RAISE(ABORT,'synthetic result persistence'); END;`,
  );
  try {
    await new DeliveryRuntime(deps()).tick();
    expect(await row(bad)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(await row(good)).toMatchObject({ status: "accepted", attempts: 1 });
    expect(sent).toHaveLength(2);
    expect(await budget()).toEqual({ reserved: 0, settled: 1, uncertain: 1 });
    expect(
      await env.DB.prepare("SELECT id FROM jobs WHERE id='delivery:backoff'").first(),
    ).toBeNull();
  } finally {
    await env.DB.exec("DROP TRIGGER synthetic_result_error");
  }
});
