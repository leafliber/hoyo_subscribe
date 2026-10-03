// A-P4-OUTBOX · 合成账户/事实；本地 workerd + D1，无邮件服务调用。
import { env } from "cloudflare:test";
import {
  CHANGE_TTL,
  MAIL_SEAT_LEASE,
  SUBSCRIPTION_SCHEMA_VERSION,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_ADDRESS_RECORD_TYPE } from "../../auth/challenges/delivery";
import { seedOperationalControls } from "../../shell/observability/test-support";
import { testKeyring } from "../../shell/test-support";
import { conditionalCommit } from "../../storage/cas";
import { encryptField } from "../../storage/crypto/aead";
import { readMailDayLedger, reserveMailBudget } from "../../storage/ledger/mail-ledger";
import { splitSqlStatements } from "../../storage/split-sql";
import { expandDispatchBatchPage, startDispatchBatch } from "../dispatch/batch";
import { planDispatchAttempt, selectDispatchCandidate } from "../dispatch/dispatch";
import type { DispatchProposal } from "../dispatch/types";
import type { ServerMail } from "../provider/types";
import { type SendDeps, sendOneMail } from "./send";
import { claimMail } from "./state";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T = 1_800_000_000_000;
let serial = 0;
const id = () => `synthetic_p402_${++serial}`;
const run = async (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
const rows = async <A = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<A>()
  ).results;
async function user(order: number) {
  const uid = id();
  const binding = id();
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,?,'active',?,?,?,1,?,?)`,
    uid,
    order,
    id(),
    binding,
    await encryptField(
      (await testKeyring).fieldEncryption(),
      { type: DELIVERY_ADDRESS_RECORD_TYPE, id: uid },
      "Synthetic.User@example.com",
    ),
    T,
    T,
  );
  await run(
    `INSERT INTO user_subscriptions (user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at)
    VALUES (?,'initialized',?,1,?,?,?,?,?)`,
    uid,
    SUBSCRIPTION_SCHEMA_VERSION,
    JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
    JSON.stringify({ event_types: ["limited_event"], node_types: [], alarms_enabled: false }),
    JSON.stringify({
      rule_ids: ["limited_start_1h"],
      new_event: true,
      important_change: true,
      cancelled_or_retracted: true,
      late_discovery: true,
    }),
    T,
    T,
  );
  await run(
    `INSERT INTO email_channels (user_id,enabled,routine_enabled,consent_version,address_version,lease_expires_at,created_at,updated_at)
    VALUES (?,1,1,1,1,?,?,?)`,
    uid,
    T + MAIL_SEAT_LEASE * 24 * 60 * 60 * 1000,
    T,
    T,
  );
  for (const layer of ["seat", "routine"])
    await run(
      `INSERT INTO consent_events (id,user_id,email_binding_id,layer,action,consent_version,created_at)
    VALUES (?,?,?,?,'enable',1,?)`,
      id(),
      uid,
      binding,
      layer,
      T - 1,
    );
  for (const interest of [
    "limited_start_1h",
    "new_event",
    "important_change",
    "cancelled_or_retracted",
    "late_discovery",
  ])
    await run(
      `INSERT INTO subscription_interests (id,user_id,game,region,interest_kind,interest_id,enabled_at)
    VALUES (?,?,'genshin','CN',?,?,?)`,
      id(),
      uid,
      interest === "limited_start_1h" ? "rule" : "change_switch",
      interest,
      T - 1,
    );
  return uid;
}
interface Fact {
  eid: string;
  nid: string;
  oid: string;
  kind: string;
  due: number;
  expiry: number;
}
async function fact(kind = "limited_start_1h", due = T, base?: Fact): Promise<Fact> {
  const eid = base?.eid ?? id();
  const nid = base?.nid ?? id();
  const oid = id();
  if (!base) {
    await run(
      `INSERT INTO events (id,game,region,event_type,status,title,event_revision,schedule_revision,created_at,updated_at)
      VALUES (?,'genshin','CN','limited_event','scheduled','合成日程',1,1,?,?)`,
      eid,
      T,
      T,
    );
    await run(
      `INSERT INTO milestones (id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
      VALUES (?,?,'start','start','合成节点',?,'Asia/Shanghai','合成时刻','official_explicit','datetime',?,?)`,
      nid,
      eid,
      due + CHANGE_TTL * 1000,
      T,
      T,
    );
  }
  const expiry = due + CHANGE_TTL * 1000;
  await run(
    `INSERT INTO occurrences (id,event_id,milestone_id,schedule_revision,kind,due_at,expires_at,created_at)
    VALUES (?,?,?,1,?,?,?,?)`,
    oid,
    eid,
    nid,
    kind,
    due,
    expiry,
    T,
  );
  await run(
    "UPDATE events SET official_url='https://official.example/event',detail_path='/events/synthetic' WHERE id=?",
    eid,
  );
  return { eid, nid, oid, kind, due, expiry };
}
async function batch(now = T) {
  const b = await startDispatchBatch(env.DB, id(), now);
  for (let i = 0; i < 1000; i++)
    if ((await expandDispatchBatchPage(env.DB, b.id, now)) === "ready") return b;
  throw new Error("合成批次未完成");
}
async function select(bid: string, now = T): Promise<DispatchProposal> {
  for (let i = 0; i < 1000; i++) {
    const result = await selectDispatchCandidate(env.DB, bid, now);
    if (result.outcome === "advanced") continue;
    if (result.outcome !== "candidate") throw new Error(`需要候选，实际 ${result.outcome}`);
    return result.proposal;
  }
  throw new Error("未取得合成候选");
}
async function approve(p: DispatchProposal, now = T) {
  const planned = await planDispatchAttempt(env.DB, p, now);
  expect(planned).not.toBeNull();
  if (!planned) throw new Error("无批准计划");
  expect(await conditionalCommit(env.DB, planned.plan)).toEqual({ outcome: "committed" });
  return planned.outboxId;
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(splitSqlStatements(migrations[path] ?? "").map((s) => env.DB.prepare(s)));
});
beforeEach(async () => {
  for (const table of [
    "usage_periods",
    "suppressions",
    "deliveries",
    "mail_outbox",
    "dispatch_cursors",
    "jobs",
    "occurrences",
    "milestones",
    "events",
    "consent_events",
    "email_channels",
    "subscription_interests",
    "user_subscriptions",
    "users",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
  await seedOperationalControls(env.DB);
});

let sent: ServerMail[] = [];
function sender(extra: Partial<SendDeps> = {}): SendDeps {
  return {
    db: env.DB,
    now: () => T,
    available: async () => true,
    pause: async () => {},
    fieldKey: async () => (await testKeyring).fieldEncryption(),
    origin: "https://synthetic.example",
    unsubscribe: async () => ({
      page: "https://synthetic.example/unsubscribe/synthetic",
      oneClick: "https://synthetic.example/email/one-click/synthetic",
    }),
    provider: {
      send: async (mail) => {
        sent.push(mail);
        return { kind: "accepted", messageId: `<${id()}>` };
      },
    },
    ...extra,
  };
}
async function digest(uid: string) {
  const oid = await approve(await select((await batch()).id));
  expect(
    (
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: utcDayPeriod(T),
        now: T,
        outboxId: oid,
        userId: uid,
      })
    ).outcome,
  ).toBe("committed");
  return oid;
}
beforeEach(() => {
  sent = [];
});
describe("A-P4-OUTBOX 合并通知发送前复核", () => {
  it.each(["outbound_enabled", "business_mail_enabled", "email_routine_enabled"])(
    "P5 关闭 %s 后已批准业务也不外调",
    async (control) => {
      const uid = await user(1);
      await fact();
      const oid = await digest(uid);
      await env.DB.prepare("UPDATE system_state SET value_json='false' WHERE key=?")
        .bind(control)
        .run();
      await sendOneMail(sender(), "test", oid);
      expect(sent).toHaveLength(0);
      expect(
        await env.DB.prepare("SELECT status FROM mail_outbox WHERE id=?").bind(oid).first("status"),
      ).toBe("retry_wait");
    },
  );

  it("真实批准的未预算 outbox 不发送；预留后合并全体 Delivery，一封一位收件人", async () => {
    const uid = await user(1);
    await fact();
    await fact();
    const oid = await approve(await select((await batch()).id));
    expect(await sendOneMail(sender(), "test")).toBe(false);
    await reserveMailBudget(env.DB, {
      intent: "base_routine_or_announce",
      period: utcDayPeriod(T),
      now: T,
      outboxId: oid,
      userId: uid,
    });
    await sendOneMail(sender(), "test");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.match(/合成节点/g)).toHaveLength(2);
    expect(await rows("SELECT status FROM deliveries")).toEqual([
      { status: "accepted" },
      { status: "accepted" },
    ]);
    const ledger = await readMailDayLedger(env.DB, utcDayPeriod(T).key, uid);
    expect(ledger.pools.base_business).toEqual({ reserved: 0, settled: 1, uncertain: 0 });
    expect(ledger.userBase).toEqual(ledger.pools.base_business);
  });
  it.each(["account", "interest", "channel", "binding", "schedule", "expiry"])(
    "发送前 %s 变更阻断供应商，保留逐条终态",
    async (kind) => {
      const uid = await user(1),
        f = await fact();
      const oid = await digest(uid);
      if (kind === "account")
        await run("UPDATE users SET status='recovery_restricted' WHERE id=?", uid);
      if (kind === "interest") await run("DELETE FROM subscription_interests WHERE user_id=?", uid);
      if (kind === "channel")
        await run("UPDATE email_channels SET enabled=0,routine_enabled=0 WHERE user_id=?", uid);
      if (kind === "binding") await run("UPDATE mail_outbox SET address_version=0 WHERE id=?", oid);
      if (kind === "schedule") await run("UPDATE events SET schedule_revision=2 WHERE id=?", f.eid);
      if (kind === "expiry") await run("UPDATE deliveries SET expires_at=?", T);
      await sendOneMail(sender(), "test");
      expect(sent).toHaveLength(0);
      expect(
        (await rows<{ status: string }>("SELECT status FROM mail_outbox WHERE id=?", oid))[0]
          ?.status,
      ).toBe(kind === "schedule" ? "superseded" : kind === "expiry" ? "expired" : "skipped");
      expect(
        (await readMailDayLedger(env.DB, utcDayPeriod(T).key, uid)).pools.base_business.reserved,
      ).toBe(0);
    },
  );
  it("合并信中一条改期只作废该条，其他条目仍发送", async () => {
    const uid = await user(1),
      old = await fact();
    await fact();
    await digest(uid);
    await run("UPDATE events SET schedule_revision=2 WHERE id=?", old.eid);
    await sendOneMail(sender(), "test");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.match(/合成节点/g)).toHaveLength(1);
    expect(
      (await rows<{ status: string }>("SELECT status FROM deliveries ORDER BY status")).map(
        (d) => d.status,
      ),
    ).toEqual(["accepted", "superseded"]);
  });
  it("复核读取后关闭通道，原子调用守卫挡住外调", async () => {
    const uid = await user(1);
    await fact();
    await digest(uid);
    let n = 0;
    await sendOneMail(
      sender({
        available: async () => {
          if (++n === 2)
            await run("UPDATE email_channels SET enabled=0,routine_enabled=0 WHERE user_id=?", uid);
          return true;
        },
      }),
      "test",
    );
    expect(sent).toHaveLength(0);
    expect((await rows<{ status: string }>("SELECT status FROM mail_outbox"))[0]?.status).toBe(
      "retry_wait",
    );
  });
  it("认证优先于已预留的业务合并信", async () => {
    const uid = await user(1);
    await fact();
    await digest(uid);
    const oid = id();
    await run(
      `INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,status,created_at,updated_at)
      VALUES (?,'new_registration',0,'',0,'synthetic','pending',?,?)`,
      oid,
      T + 1,
      T + 1,
    );
    await reserveMailBudget(env.DB, {
      intent: "signup_auth",
      period: utcDayPeriod(T),
      now: T,
      outboxId: oid,
    });
    expect((await claimMail(env.DB, "priority", T))?.id).toBe(oid);
  });
});
