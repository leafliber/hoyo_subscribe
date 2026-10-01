// A-P4-FEEDBACK：仅 P0-05 实测形状的合成事件，真实本地 D1；无真实地址或外发。
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import {
  API_BODY_MAX_BYTES,
  BUDGET_PERIOD_KIND,
  EXECUTOR_BATCH_WALL_LIMIT,
  FEEDBACK_BATCH,
  FEEDBACK_MAX_RETRIES,
  MAIL_FEEDBACK_MAX,
  MAIL_FEEDBACK_TTL,
  MAIL_UNMATCHED_MAX,
  SECRET_BITS,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";

const config = Object.values(
  import.meta.glob("../../../wrangler.jsonc", { query: "?raw", import: "default", eager: true }),
)[0] as string;

import { encryptField } from "../../storage/crypto/aead";
import { Keyring } from "../../storage/crypto/keyring";
import { splitSqlStatements } from "../../storage/split-sql";
import { recordMailReceipt } from "../outbox/state";
import { mailJobId } from "../outbox/types";
import { suppressionAddressKey } from "../suppression";
import { consumeFeedback, queue } from "./index";
import { FEEDBACK_DLQ, FEEDBACK_QUEUE, parseFeedback, type Receipt } from "./schema";
import {
  compactFeedbackPage,
  FEEDBACK_LOOKUP_SQL,
  type FeedbackKeys,
  ingestFeedback,
  pruneFeedbackPage,
  reconcileFeedbackPage,
} from "./store";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T = Date.parse("2026-09-30T12:00:00Z");
const recipient = "Synthetic.User@example.com";
const trust = {
  accountId: "synthetic-account",
  subscriptions: [
    { id: "synthetic-biz", domain: "mail.example.com" },
    { id: "synthetic-auth", domain: "auth.example.com" },
  ],
};
let keys: FeedbackKeys;
let serial = 0;
const id = () => `synthetic407_${++serial}`;
const run = (sql: string, ...p: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...p)
    .run();
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...p)
    .first<T>();
function event(receipt: Receipt = "delivered", mid = "<synthetic-message@mail.example.com>") {
  return {
    type: `cf.email.sending.message.${receipt}`,
    source: { type: "email.sending", domain: "mail.example.com", zoneId: "synthetic-zone" },
    metadata: {
      accountId: trust.accountId,
      eventSubscriptionId: "synthetic-biz",
      eventSchemaVersion: 1,
      eventTimestamp: new Date(T).toISOString(),
    },
    payload: {
      eventId: id(),
      messageId: mid,
      sender: "sender@mail.example.com",
      recipient,
      subject: "synthetic subject",
      terminal: receipt !== "deferred",
      delivery: {
        status: receipt,
        smtpStatusCode: receipt === "deferred" ? "400" : "250",
        deliveryTimeMs: 8898,
      },
      bounce: {
        type: receipt === "bounced" ? "hard" : "soft",
        classification: receipt === "bounced" ? "permanent_failure" : "temporary_failure",
      },
    },
  };
}
function batch(bodies: unknown[], queueName = FEEDBACK_QUEUE, attempts = 1) {
  const messages = bodies.map((body) => ({
    id: id(),
    timestamp: new Date(T),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    queue: queueName,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}
const deps = () => ({ db: env.DB, trust, keys: async () => keys, now: () => T });
async function seed(mid = "<synthetic-message@mail.example.com>", status = "accepted") {
  const uid = id(),
    binding = id(),
    oid = id();
  const cipher = await encryptField(
    keys.field,
    { type: "delivery-email-address", id: uid },
    recipient,
  );
  await run(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,?,'active',?,?,?,1,?,?)`,
    uid,
    serial,
    id(),
    binding,
    cipher,
    T,
    T,
  );
  await run(
    `INSERT INTO email_channels(user_id,enabled,routine_enabled,address_version,created_at,updated_at) VALUES (?,1,1,1,?,?)`,
    uid,
    T,
    T,
  );
  await run(
    `INSERT INTO mail_outbox(id,purpose,priority,period_key,recipient_user_id,email_binding_id,address_version,payload_kind,status,message_id,created_at,updated_at)
    VALUES (?,'existing_auth',0,?,?,?,1,'synthetic',?,?,?,?)`,
    oid,
    utcDayPeriod(T).key,
    uid,
    binding,
    status,
    mid,
    T,
    T,
  );
  await run(
    `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES (?,'mail_send','{"provider_status":"submitted"}',?,'done',?,?)`,
    mailJobId(oid),
    T,
    T,
    T,
  );
  if (status === "unknown")
    await run(
      `INSERT INTO usage_periods(id,pool,period_kind,period_key,uncertain,period_start,period_end,created_at,updated_at)
    VALUES (?,'existing_auth',?,?,1,?,?,?,?)`,
      id(),
      BUDGET_PERIOD_KIND,
      utcDayPeriod(T).key,
      T,
      T,
      T,
      T,
    );
  return { uid, binding, oid, mid };
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  const ring = await Keyring.create({
    masterSecret: new Uint8Array(SECRET_BITS / 8).fill(3),
    otpPepper: new Uint8Array(SECRET_BITS / 8).fill(7),
    unsubscribeMacCurrentKeyId: "synthetic",
  });
  keys = { lookup: ring.emailLookup(), field: ring.fieldEncryption() };
});
beforeEach(async () => {
  for (const table of [
    "mail_feedback",
    "suppressions",
    "email_channels",
    "mail_outbox",
    "jobs",
    "usage_periods",
    "users",
    "system_state",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
});
describe("A-P4-FEEDBACK", () => {
  it("Queue 配置由注册表约束，小批/重试/DLQ 不漂移", () => {
    const parsed = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
    expect(parsed.queues.producers).toBeUndefined();
    expect(parsed.queues.consumers).toHaveLength(1);
    expect(
      parsed.queues.consumers.find((c: { queue: string }) => c.queue === FEEDBACK_QUEUE),
    ).toEqual({
      queue: FEEDBACK_QUEUE,
      max_batch_size: FEEDBACK_BATCH,
      max_retries: FEEDBACK_MAX_RETRIES,
      dead_letter_queue: FEEDBACK_DLQ,
    });
  });
  it("P0-05 四次 deferred soft bounce 后 delivered；无抑制、不重投、不等于已读", async () => {
    const { oid } = await seed();
    for (let n = 0; n < 4; n++) {
      const b = batch([event("deferred")]);
      await consumeFeedback(b, deps());
      expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
      expect(await one("SELECT status FROM mail_outbox WHERE id=?", oid)).toEqual({
        status: "deferred",
      });
      expect(await one("SELECT COUNT(*) AS n FROM suppressions")).toEqual({ n: 0 });
    }
    const b = batch([event()]);
    await consumeFeedback(b, deps());
    expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(await one("SELECT status,attempts FROM mail_outbox WHERE id=?", oid)).toEqual({
      status: "accepted",
      attempts: 0,
    });
    expect(await one("SELECT payload_json FROM jobs WHERE id=?", mailJobId(oid))).toEqual({
      payload_json: '{"provider_status":"delivered"}',
    });
    const late = batch([event("deferred")]);
    await consumeFeedback(late, deps());
    expect(late.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(await one("SELECT status FROM mail_outbox WHERE id=?", oid)).toEqual({
      status: "accepted",
    });
  });
  it.each(["complained", "bounced"] as const)(
    "%s 优先于晚到成功，两层关闭且既有只读抑制不被解除",
    async (kind) => {
      const { uid, binding, oid } = await seed();
      const addressKey = await suppressionAddressKey(keys.lookup, recipient);
      await run(
        "INSERT INTO suppressions(id,address_key,email_binding_id,kind,read_only,created_at) VALUES (?,?,?,'policy',1,?)",
        id(),
        addressKey,
        binding,
        T,
      );
      await consumeFeedback(batch([event(kind), event()]), deps());
      expect(
        await one("SELECT enabled,routine_enabled FROM email_channels WHERE user_id=?", uid),
      ).toEqual({ enabled: 0, routine_enabled: 0 });
      expect(await one("SELECT read_only,expires_at FROM suppressions")).toEqual({
        read_only: 1,
        expires_at: null,
      });
      expect(await one("SELECT status FROM mail_outbox WHERE id=?", oid)).toEqual({ status: kind });
    },
  );
  it("旧绑定投诉只冻结旧地址，认证历史缺失 binding 不猜成新地址", async () => {
    const { uid, binding, oid } = await seed();
    const next = id();
    await run("UPDATE users SET email_binding_id=?,email_version=2 WHERE id=?", next, uid);
    await run(
      "UPDATE email_channels SET address_version=2,enabled=1,routine_enabled=1 WHERE user_id=?",
      uid,
    );
    await consumeFeedback(batch([event("complained")]), deps());
    expect(await one("SELECT email_binding_id FROM suppressions")).toEqual({
      email_binding_id: binding,
    });
    expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
      enabled: 1,
    });
    await run("DELETE FROM suppressions");
    await run("UPDATE mail_outbox SET email_binding_id=NULL WHERE id=?", oid);
    await consumeFeedback(batch([event("bounced")]), deps());
    expect(
      (await one<{ email_binding_id: string }>("SELECT email_binding_id FROM suppressions"))
        ?.email_binding_id,
    ).toMatch(/^unbound:/);
    expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
      enabled: 1,
    });
  });
  it("当前认证 outbox 缺失 binding 时按版本和精确地址补关联", async () => {
    const { oid, uid, binding } = await seed();
    await run("UPDATE mail_outbox SET email_binding_id=NULL WHERE id=?", oid);
    await consumeFeedback(batch([event("complained")]), deps());
    expect(await one("SELECT email_binding_id FROM suppressions")).toEqual({
      email_binding_id: binding,
    });
    expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
      enabled: 0,
    });
    expect(await suppressionAddressKey(keys.lookup, recipient.toLowerCase())).not.toBe(
      await suppressionAddressKey(keys.lookup, recipient),
    );
  });
  it("eventId 并发去重与重复投递，unknown 预算只结算一次", async () => {
    await seed(undefined, "unknown");
    const e = event();
    const a = batch([e]),
      b = batch([e]);
    await Promise.all([consumeFeedback(a, deps()), consumeFeedback(b, deps())]);
    await consumeFeedback(batch([e]), deps());
    expect(await one("SELECT COUNT(*) AS n FROM mail_feedback")).toEqual({ n: 1 });
    expect(await one("SELECT uncertain,settled FROM usage_periods")).toEqual({
      uncertain: 0,
      settled: 1,
    });
    expect(await one("SELECT attempts FROM jobs")).toEqual({ attempts: 1 });
  });
  it("反馈先到保留后 retry，精确 messageId 后到自动重试关联；不按主题猜", async () => {
    const e = event();
    const first = batch([e]);
    await consumeFeedback(first, deps());
    expect(first.messages[0]?.ack).not.toHaveBeenCalled();
    expect(first.messages[0]?.retry).toHaveBeenCalledWith({ delaySeconds: WATCHDOG_INTERVAL });
    await seed(e.payload.messageId.slice(1, -1));
    const wrong = batch([e]);
    await consumeFeedback(wrong, deps());
    expect(wrong.messages[0]?.ack).not.toHaveBeenCalled();
    await seed(e.payload.messageId);
    const retry = batch([e]);
    await consumeFeedback(retry, deps());
    expect(retry.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(
      await one("SELECT COUNT(*) AS n FROM mail_feedback WHERE mail_outbox_id IS NULL"),
    ).toEqual({ n: 0 });
  });
  it("回执已提交但抑制事务失败，不 ack；重试补齐抑制和完成标记", async () => {
    const { oid, uid } = await seed();
    const e = event("complained");
    await env.DB.exec(
      "CREATE TRIGGER synthetic_feedback_fail BEFORE UPDATE ON email_channels BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    try {
      const b = batch([e]);
      await consumeFeedback(b, deps());
      expect(b.messages[0]?.ack).not.toHaveBeenCalled();
      expect(await one("SELECT status FROM mail_outbox WHERE id=?", oid)).toEqual({
        status: "complained",
      });
      expect(await one("SELECT COUNT(*) AS n FROM suppressions")).toEqual({ n: 0 });
      expect(await one("SELECT mail_outbox_id FROM mail_feedback")).toEqual({
        mail_outbox_id: oid,
      });
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_feedback_fail");
    }
    const retry = batch([e]);
    await consumeFeedback(retry, deps());
    expect(retry.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
      enabled: 0,
    });
  });
  it.each([
    "account",
    "subscription",
    "domain",
    "sender",
    "version",
    "type",
    "terminal",
    "size",
    "shape",
    "recipient",
  ])("拒绝错误 %s，日志不泄露载荷，最终 retry 交平台 DLQ", async (bad) => {
    const e = event("deferred");
    switch (bad) {
      case "account":
        e.metadata.accountId = "wrong";
        break;
      case "subscription":
        e.metadata.eventSubscriptionId = "synthetic-auth";
        break;
      case "domain":
        e.source.domain = "evil.example.com";
        break;
      case "sender":
        e.payload.sender = "sender@evil.example.com";
        break;
      case "version":
        e.metadata.eventSchemaVersion++;
        break;
      case "type":
        e.type = "cf.email.sending.message.delivered";
        break;
      case "terminal":
        e.payload.terminal = true;
        break;
      case "size":
        e.payload.subject = "密".repeat(API_BODY_MAX_BYTES);
        break;
      case "shape":
        e.payload.messageId = "";
        break;
      case "recipient":
        e.payload.recipient = "not-an-address";
        break;
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const b = batch([e], FEEDBACK_QUEUE, FEEDBACK_MAX_RETRIES + 1);
      await consumeFeedback(b, deps());
      expect(b.messages[0]?.ack).not.toHaveBeenCalled();
      expect(b.messages[0]?.retry).toHaveBeenCalledOnce();
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(recipient);
      expect(output).not.toContain(e.payload.subject);
      expect(await one("SELECT COUNT(*) AS n FROM mail_feedback")).toEqual({ n: 0 });
    } finally {
      log.mockRestore();
    }
  });
  it("未知 Queue、超批量、缺失部署配置失败关闭", async () => {
    const wrong = batch([event()], "other");
    await consumeFeedback(wrong, deps());
    expect(wrong.retryAll).toHaveBeenCalledOnce();
    const large = batch(Array.from({ length: FEEDBACK_BATCH + 1 }, () => event()));
    await consumeFeedback(large, deps());
    expect(large.retryAll).toHaveBeenCalledOnce();
    const missing = batch([event()]);
    await queue(missing, env);
    expect(missing.retryAll).toHaveBeenCalledOnce();
  });
  it("同批坏事件不影响有效事件；failed/rejected 不凭空推断地址投诉", async () => {
    await seed();
    const b = batch([{}, event("failed")]);
    await consumeFeedback(b, deps());
    expect(b.messages[0]?.retry).toHaveBeenCalledOnce();
    expect(b.messages[1]?.ack).toHaveBeenCalledOnce();
    expect(await one("SELECT COUNT(*) AS n FROM suppressions")).toEqual({ n: 0 });
  });
  it("未关联容量并发边界拒绝溢出，不删除未决反馈腾位", async () => {
    await run(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
      INSERT INTO mail_feedback(id,provider_event_id,kind,feedback_at,raw_ref,created_at)
      SELECT 'history-'||x,'history-'||x,'deferred',?,'{}',? FROM n`,
      MAIL_UNMATCHED_MAX - 1,
      T,
      T,
    );
    const a = batch([event()]),
      b = batch([event()]);
    await Promise.all([consumeFeedback(a, deps()), consumeFeedback(b, deps())]);
    expect(await one("SELECT COUNT(*) AS n FROM mail_feedback")).toEqual({ n: MAIL_UNMATCHED_MAX });
    expect(a.messages[0]?.ack).not.toHaveBeenCalled();
    expect(b.messages[0]?.ack).not.toHaveBeenCalled();
    expect(await pruneFeedbackPage(env.DB, T + MAIL_FEEDBACK_TTL * 1000 + 1)).toBe(FEEDBACK_BATCH);
  });
  it("总容量被待重试占满时不删除它们，也不突破硬上限", async () => {
    await seed();
    const e = event();
    await consumeFeedback(batch([e]), deps());
    await run(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
      INSERT INTO mail_feedback(id,provider_event_id,mail_outbox_id,kind,feedback_at,raw_ref,created_at)
      SELECT 'history-'||x,'history-'||x,'synthetic-history','delivered',?,'{"stage":"pending"}',? FROM n`,
      MAIL_FEEDBACK_MAX - 1,
      T,
      T,
    );
    // 唯一完成行可被压力回收；第一封进来后改为待重试，第二封才真正无可回收行。
    await run(
      "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.stage','pending') WHERE provider_event_id=?",
      e.payload.eventId,
    );
    const b = batch([event()]);
    await consumeFeedback(b, deps());
    expect(b.messages[0]?.retry).toHaveBeenCalledOnce();
    expect(await one("SELECT COUNT(*) AS n FROM mail_feedback")).toEqual({ n: MAIL_FEEDBACK_MAX });
  });
  it("孤儿反馈维护关联与完成元数据 TTL，未决异常保持有界保留", async () => {
    const e = event();
    await consumeFeedback(batch([e]), deps());
    await seed();
    expect(await reconcileFeedbackPage(env.DB, keys, T)).toBe(1);
    expect(await pruneFeedbackPage(env.DB, T + MAIL_FEEDBACK_TTL * 1000 - 1)).toBe(0);
    expect(await pruneFeedbackPage(env.DB, T + MAIL_FEEDBACK_TTL * 1000)).toBe(1);
  });
  it("处理者崩溃租约到期后可恢复，租约期间不 ack", async () => {
    const e = event();
    await consumeFeedback(batch([e]), deps());
    await seed();
    await run(
      "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.leaseUntil',?,'$.token','synthetic-crash')",
      T + EXECUTOR_BATCH_WALL_LIMIT * 1000,
    );
    const b = batch([e]);
    await consumeFeedback(b, deps());
    expect(b.messages[0]?.ack).not.toHaveBeenCalled();
    expect(
      await ingestFeedback(
        env.DB,
        parseFeedback(e, trust),
        keys,
        T + EXECUTOR_BATCH_WALL_LIMIT * 1000,
      ),
    ).toBe(true);
  });
  it("eventId 热查询加入大量无关历史后 rows_read 不增长", async () => {
    await seed();
    const e = event();
    await consumeFeedback(batch([e]), deps());
    const read = () => env.DB.prepare(FEEDBACK_LOOKUP_SQL).bind(e.payload.eventId).all();
    const before = (await read()).meta.rows_read;
    await run(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO mail_feedback(id,provider_event_id,kind,feedback_at,raw_ref,created_at)
      SELECT 'history-'||x,'history-'||x,'deferred',?,'{}',? FROM n`,
      T,
      T,
    );
    expect((await read()).meta.rows_read).toBe(before);
  });
  it("不同 eventId 乱序并发投诉与成功仍以投诉为终态", async () => {
    const { oid } = await seed();
    await Promise.all([
      consumeFeedback(batch([event("complained")]), deps()),
      consumeFeedback(batch([event()]), deps()),
    ]);
    expect(await one("SELECT status FROM mail_outbox WHERE id=?", oid)).toEqual({
      status: "complained",
    });
    expect(await recordMailReceipt(env.DB, "unmatched", "delivered", T)).toBe(false);
  });
});

it("A-P4-FEEDBACK Worker 默认导出接线，原生测试批次只 ack 已提交事件", async () => {
  await seed();
  const e = event();
  const b = createMessageBatch(FEEDBACK_QUEUE, [
    { id: "synthetic-wire", timestamp: new Date(T), attempts: 1, body: e },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(b, {
    ...env,
    MAIL_FEEDBACK_ACCOUNT_ID: trust.accountId,
    MAIL_FEEDBACK_SUBSCRIPTIONS: JSON.stringify(trust.subscriptions),
    CRYPTO_MASTER_SECRET: "03".repeat(SECRET_BITS / 8),
    CRYPTO_OTP_PEPPER: "07".repeat(SECRET_BITS / 8),
    CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
  });
  const result = await getQueueResult(b, ctx);
  expect(result.explicitAcks).toEqual(["synthetic-wire"]);
  expect(result.retryMessages).toEqual([]);
  expect(
    await one("SELECT COUNT(*) AS n FROM mail_feedback WHERE mail_outbox_id IS NOT NULL"),
  ).toEqual({ n: 1 });
});
it("A-P4-FEEDBACK 完成 TTL 清理并发汇总只计一次", async () => {
  await seed();
  await consumeFeedback(batch([event()]), deps());
  const at = T + MAIL_FEEDBACK_TTL * 1000 + 1;
  await Promise.all([pruneFeedbackPage(env.DB, at), pruneFeedbackPage(env.DB, at)]);
  expect(
    await one("SELECT value_json FROM system_state WHERE key='mail_feedback:archived:delivered'"),
  ).toEqual({ value_json: "1" });
});
it("A-P4-FEEDBACK 完成提交前租约已被接管，旧处理者不关闭通道或写抑制", async () => {
  const { uid } = await seed();
  const e = event("complained");
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          // 只在 feedback 已取得租约时模拟其他消费者接管；outbox 原语的 batch 不被拦截。
          const active = await one<{ raw_ref: string }>(
            "SELECT raw_ref FROM mail_feedback WHERE provider_event_id=?",
            e.payload.eventId,
          );
          if (active && JSON.parse(active.raw_ref).stage === "pending" && statements.length === 3) {
            await run(
              "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.token','synthetic-new-owner') WHERE provider_event_id=?",
              e.payload.eventId,
            );
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const b = batch([e]);
  await consumeFeedback(b, { ...deps(), db });
  expect(b.messages[0]?.ack).not.toHaveBeenCalled();
  expect(await one("SELECT COUNT(*) AS n FROM suppressions")).toEqual({ n: 0 });
  expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
    enabled: 1,
  });
});
it("A-P4-FEEDBACK 认证域必须匹配自己的订阅；两个白名单不能交叉组合", async () => {
  await seed();
  const e = event();
  e.source.domain = "auth.example.com";
  e.payload.sender = "sender@auth.example.com";
  const bad = batch([e]);
  await consumeFeedback(bad, deps());
  expect(bad.messages[0]?.ack).not.toHaveBeenCalled();
  e.metadata.eventSubscriptionId = "synthetic-auth";
  const good = batch([e]);
  await consumeFeedback(good, deps());
  expect(good.messages[0]?.ack).toHaveBeenCalledOnce();
});
it("A-P4-FEEDBACK 明确 suppressed 拒绝冻结，普通 rejected 不推断抑制", async () => {
  await seed();
  await consumeFeedback(batch([event("rejected")]), deps());
  expect(await one("SELECT COUNT(*) AS n FROM suppressions")).toEqual({ n: 0 });
  const rejected = event("rejected");
  const b = batch([
    {
      ...rejected,
      payload: { ...rejected.payload, rejection: { reason: "suppressed", party: "recipient" } },
    },
  ]);
  await consumeFeedback(b, deps());
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(await one("SELECT kind FROM suppressions")).toEqual({ kind: "policy" });
});
it("A-P4-FEEDBACK 相同 eventId 内容冲突不能覆盖已有记录或伪造关联", async () => {
  await seed();
  const e = event();
  await consumeFeedback(batch([e]), deps());
  const beforeConflict = await one("SELECT * FROM mail_feedback");
  const changed = { ...e, payload: { ...e.payload, messageId: "<another-synthetic>" } };
  const b = batch([changed]);
  await consumeFeedback(b, deps());
  expect(b.messages[0]?.ack).not.toHaveBeenCalled();
  expect(await one("SELECT * FROM mail_feedback")).toEqual(beforeConflict);
});

async function seedFeedbackHistory(count: number, createdAt: number, completed: boolean) {
  await run(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO mail_feedback(id,provider_event_id,message_id,mail_outbox_id,kind,feedback_at,raw_ref,created_at)
    SELECT 'probe-'||x,'probe-'||x,'<probe-'||x||'>',?,'deferred',?, ?,? FROM n`,
    count,
    completed ? "synthetic-history" : null,
    createdAt,
    JSON.stringify({ stage: completed ? "done" : "pending", leaseUntil: 0, token: null }),
    createdAt,
  );
}
it("A-P4-FEEDBACK 探针一：1000 条过期未关联不阻挡可关联投诉，异常到期汇总", async () => {
  const { uid, binding } = await seed();
  await seedFeedbackHistory(MAIL_UNMATCHED_MAX, T - MAIL_FEEDBACK_TTL * 1000, false);
  const b = batch([event("complained")]);
  await consumeFeedback(b, deps());
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(
    await one("SELECT enabled,routine_enabled FROM email_channels WHERE user_id=?", uid),
  ).toEqual({ enabled: 0, routine_enabled: 0 });
  expect(await one("SELECT kind,email_binding_id FROM suppressions")).toEqual({
    kind: "complaint",
    email_binding_id: binding,
  });
  while (await pruneFeedbackPage(env.DB, T)) {
    /* 有限页直到全部过期异常已汇总 */
  }
  expect(await one("SELECT COUNT(*) AS n FROM mail_feedback WHERE mail_outbox_id IS NULL")).toEqual(
    { n: 0 },
  );
  expect(
    await one(
      "SELECT value_json FROM system_state WHERE key='mail_feedback:unmatched_expired:deferred'",
    ),
  ).toEqual({ value_json: String(MAIL_UNMATCHED_MAX) });
});
it("A-P4-FEEDBACK 未过期未关联已满，可关联投诉仍直接入库且不占未关联池", async () => {
  const { uid } = await seed();
  await seedFeedbackHistory(MAIL_UNMATCHED_MAX, T, false);
  const b = batch([event("complained")]);
  await consumeFeedback(b, deps());
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(await one("SELECT COUNT(*) AS n FROM mail_feedback WHERE mail_outbox_id IS NULL")).toEqual(
    { n: MAIL_UNMATCHED_MAX },
  );
  expect(await one("SELECT enabled FROM email_channels WHERE user_id=?", uid)).toEqual({
    enabled: 0,
  });
});
it("A-P4-FEEDBACK 探针二：20000 条新近完成记录时一批新反馈含投诉全部处理", async () => {
  const { uid } = await seed();
  await seedFeedbackHistory(MAIL_FEEDBACK_MAX, T - 1, true);
  const b = batch(
    Array.from({ length: FEEDBACK_BATCH }, (_, n) => event(n === 0 ? "complained" : "delivered")),
  );
  await consumeFeedback(b, deps());
  for (const message of b.messages) {
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  }
  expect(
    await one("SELECT enabled,routine_enabled FROM email_channels WHERE user_id=?", uid),
  ).toEqual({ enabled: 0, routine_enabled: 0 });
  expect(await one("SELECT kind FROM suppressions")).toEqual({ kind: "complaint" });
  const total = await one<{ n: number }>("SELECT COUNT(*) AS n FROM mail_feedback");
  expect(total?.n).toBeLessThanOrEqual(MAIL_FEEDBACK_MAX);
  const archived = await one<{ value_json: string }>(
    "SELECT value_json FROM system_state WHERE key='mail_feedback:archived:deferred'",
  );
  expect(Number(archived?.value_json)).toBeGreaterThanOrEqual(FEEDBACK_BATCH);
  expect((total?.n ?? 0) + Number(archived?.value_json)).toBe(MAIL_FEEDBACK_MAX + FEEDBACK_BATCH);
});
it("A-P4-FEEDBACK 压力回收只删最旧 done，不删处理中、待重试、未过期未关联", async () => {
  await seedFeedbackHistory(FEEDBACK_BATCH * 2, T - 1, true);
  await run(
    "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.stage','pending','$.leaseUntil',?) WHERE id='probe-1'",
    T + EXECUTOR_BATCH_WALL_LIMIT * 1000,
  );
  await run(
    "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.stage','pending') WHERE id='probe-2'",
  );
  await run(
    "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.stage','pending'),mail_outbox_id=NULL WHERE id='probe-3'",
  );
  // 未来的 done 作为排序对照；旧的完成行必须先清理。
  await run("UPDATE mail_feedback SET created_at=? WHERE id='probe-4'", T + 1);
  expect(await compactFeedbackPage(env.DB, T)).toBe(FEEDBACK_BATCH);
  const retained = (
    await env.DB.prepare("SELECT id FROM mail_feedback ORDER BY id").all<{ id: string }>()
  ).results.map((r) => r.id);
  expect(retained).toHaveLength(FEEDBACK_BATCH);
  expect(retained).toEqual(expect.arrayContaining(["probe-1", "probe-2", "probe-3", "probe-4"]));
  expect(await pruneFeedbackPage(env.DB, T)).toBe(0);
});
it("A-P4-FEEDBACK 过期异常汇总并发只计一次，已取得活跃租约的旧行不删", async () => {
  await seedFeedbackHistory(FEEDBACK_BATCH, T - MAIL_FEEDBACK_TTL * 1000, false);
  await run(
    "UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.leaseUntil',?,'$.token','busy') WHERE id='probe-1'",
    T + EXECUTOR_BATCH_WALL_LIMIT * 1000,
  );
  await Promise.all([pruneFeedbackPage(env.DB, T), pruneFeedbackPage(env.DB, T)]);
  expect(await one("SELECT COUNT(*) AS n FROM mail_feedback")).toEqual({ n: 1 });
  expect(
    await one(
      "SELECT value_json FROM system_state WHERE key='mail_feedback:unmatched_expired:deferred'",
    ),
  ).toEqual({ value_json: String(FEEDBACK_BATCH - 1) });
});
it("A-P4-FEEDBACK 先投诉后硬退信，抑制种类仍为投诉", async () => {
  await seed();
  const complaint = batch([event("complained")]);
  await consumeFeedback(complaint, deps());
  const bounce = batch([event("bounced")]);
  await consumeFeedback(bounce, deps());
  expect(complaint.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(bounce.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(await one("SELECT kind FROM suppressions")).toEqual({ kind: "complaint" });
});
it("A-P4-FEEDBACK 已关联待重试的反馈可由维护重放，关联不代表完成", async () => {
  const { oid } = await seed(undefined, "calling_provider");
  const e = event();
  const b = batch([e]);
  await consumeFeedback(b, deps());
  expect(b.messages[0]?.ack).not.toHaveBeenCalled();
  expect(await one("SELECT mail_outbox_id FROM mail_feedback")).toEqual({ mail_outbox_id: oid });
  expect(await compactFeedbackPage(env.DB, T)).toBe(0);
  await run("UPDATE mail_outbox SET status='accepted' WHERE id=?", oid);
  expect(await reconcileFeedbackPage(env.DB, keys, T)).toBe(1);
});
