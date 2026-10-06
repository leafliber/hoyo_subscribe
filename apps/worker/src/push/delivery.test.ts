// A-P6-SEND · 业务通知的 Push 展开与后台外发（主方案 §7.1、§7.3、§7.4、§7.8、§9.1；ADR-0025）。
// 合成账号与事实（沿 P4 fixture）、合成订阅、推送服务替身；无网络或收费资源。
import { env } from "cloudflare:test";
import {
  CHANGE_TTL,
  PUSH_LEASE,
  PUSH_RECEIPT_WRITE_INTERVAL,
  PUSH_STALE_GRACE,
  pushCounterKeys,
  pushSendDayLimit,
  pushStaleCleanupBefore,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupRetentionPage } from "../accounts/reclaim/retention";
import { DeliveryRuntime } from "../executors/delivery/runtime";
import { batch, fact, T, user } from "../mail/budget/test-support";
import { migrate } from "../mail/channel/test-support";
import { selectDispatchCandidate } from "../mail/dispatch/dispatch";
import { startDueOccurrenceExpansion } from "../mail/occurrences/expand";
import type { SendDeps } from "../mail/outbox/send";
import { testKeyring } from "../shell/test-support";
import { generateSecretToken } from "../storage/crypto/random";
import type { PushConfig } from "./config";
import { sha256Hex } from "./crypto";
import { maintainPushMessages, nextPushAlarm, type PushSendDeps, runPushPass } from "./delivery";
import { processedReceipt } from "./receipts";
import { sealBindingSecrets } from "./store";
import {
  FakePushService,
  openPush,
  openPushControls,
  type SyntheticSubscription,
  subscription,
  testPushConfig,
} from "./test-support";

const DAY = 86_400_000;
const WALL = 120_000;
let config: PushConfig;
let fake: FakePushService;
let order = 10_000;

const all = async <R = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<R>()
  ).results;
const one = async <R = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  (await all<R>(sql, ...params))[0] ?? null;
const exec = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();

function deps(pushConfig: PushConfig | null = config): PushSendDeps {
  return {
    db: env.DB,
    keys: () => testKeyring,
    config: async () => pushConfig,
    transport: fake.transport,
  };
}
async function pass(at = T, pushConfig: PushConfig | null = config) {
  await runPushPass(deps(pushConfig), () => at, at + WALL);
}
interface Bound {
  userId: string;
  bindingId: string;
  receipt: string;
  sub: SyntheticSubscription;
}
/** 一个已订阅（规则 + 全部变更通知）的合成账号，带一个在 T 之前激活的 Push 绑定。 */
async function subscriber(activatedAt = T - 1_000, state = "active"): Promise<Bound> {
  const userId = await user(++order);
  const sub = await subscription();
  const bindingId = crypto.randomUUID();
  const receipt = generateSecretToken().base64url;
  const sealed = await sealBindingSecrets(await testKeyring, bindingId, sub.endpoint, sub.keys);
  await exec(
    `INSERT INTO push_bindings(id,user_id,endpoint_hash,endpoint_ciphertext,keys_ciphertext,state,binding_version,
      receipt_token_hash,lease_expires_at,activated_at,created_at,updated_at,push_service)
    VALUES (?,?,?,?,?,?,1,?,?,?,?,?,'fcm')`,
    bindingId,
    userId,
    await sha256Hex(sub.endpoint),
    sealed.endpoint,
    sealed.keys,
    state,
    await sha256Hex(receipt),
    activatedAt + PUSH_LEASE * DAY,
    activatedAt,
    activatedAt,
    activatedAt,
  );
  return { userId, bindingId, receipt, sub };
}
/** 到期并冻结受众上界（与邮件同一起步）。 */
async function due(kind = "limited_start_1h", at = T, base?: Awaited<ReturnType<typeof fact>>) {
  const occurrence = await fact(kind, at, base);
  await startDueOccurrenceExpansion(env.DB, at, 50);
  return occurrence;
}
const counter = async (key: string) =>
  (await one<{ value: number }>("SELECT value FROM capacity_state WHERE key=?", key))?.value ?? 0;

beforeAll(async () => {
  await migrate();
  config = await testPushConfig();
}, 180_000);
beforeEach(async () => {
  fake = new FakePushService();
  for (const table of [
    "push_messages",
    "deliveries",
    "mail_outbox",
    "dispatch_cursors",
    "jobs",
    "occurrences",
    "push_bindings",
    "capacity_state",
    "system_state",
    "audit_log",
  ])
    await exec(`DELETE FROM ${table}`);
  await openPushControls(env.DB);
});

describe("A-P6-SEND 业务通知展开：目标是 binding_id，资格与邮件共用兴趣匹配", () => {
  it("到期后为 due_at 前已激活的绑定建 Delivery 与外发记录，加密外发并记账", async () => {
    const a = await subscriber();
    const late = await subscriber(T + 1);
    const paused = await subscriber(T - 1_000, "paused");
    const occurrence = await due();
    await pass();
    const deliveries = await all<{ target_ref: string; status: string; channel: string }>(
      "SELECT target_ref,status,channel FROM deliveries WHERE channel='push'",
    );
    expect(deliveries).toEqual([{ target_ref: a.bindingId, status: "accepted", channel: "push" }]);
    expect(deliveries.some((d) => d.target_ref === late.bindingId)).toBe(false);
    expect(deliveries.some((d) => d.target_ref === paused.bindingId)).toBe(false);
    expect(fake.requests).toHaveLength(1);
    const payload = await openPush(a.sub, fake.requests[0] as (typeof fake.requests)[number]);
    expect(payload).toMatchObject({
      v: 1,
      kind: "notification",
      binding_id: a.bindingId,
      title: "合成日程",
      url: "/events/synthetic",
      tag: `node:${occurrence.nid}`,
    });
    expect(String(payload.body)).toContain("北京时间");
    expect(fake.requests[0]?.headers.get("urgency")).toBe("normal");
    expect(Number(fake.requests[0]?.headers.get("ttl"))).toBeLessThanOrEqual(CHANGE_TTL);
    expect(await counter(pushCounterKeys(utcDayPeriod(T).key).send)).toBe(1);
    expect(await one("SELECT status,attempts FROM push_messages")).toEqual({
      status: "accepted",
      attempts: 1,
    });
    // 去重族：再跑一轮不会重复外发。
    await pass(T + 1);
    expect(fake.requests).toHaveLength(1);
  });

  it("邮件调度只取 channel=email，不把 Push Delivery 标成 skipped", async () => {
    const a = await subscriber();
    await due();
    await exec("UPDATE system_state SET value_json='false' WHERE key='push_enabled'");
    await pass();
    expect(fake.requests).toHaveLength(0);
    const bid = (await batch(T)).id;
    // 逐组走完邮件选择（每个候选都暂缓），确保本账号的邮件候选确实被检查过。
    const examined: { userId: string; priority: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const selected = await selectDispatchCandidate(env.DB, bid, T, examined);
      if (selected.outcome === "candidate")
        examined.push({ userId: selected.proposal.userId, priority: selected.proposal.priority });
      else if (selected.outcome !== "advanced") break;
    }
    expect(examined.some((group) => group.userId === a.userId)).toBe(true);
    expect(
      await one("SELECT status FROM deliveries WHERE channel='push' AND target_ref=?", a.bindingId),
    ).toEqual({ status: "pending" });
    // 能力恢复后，未过期的照常外发。
    await exec("UPDATE system_state SET value_json='true' WHERE key='push_enabled'");
    await pass(T + 1);
    expect(fake.requests).toHaveLength(1);
  });

  it("不发静默心跳：没有到期通知时即使有已激活绑定也零外发", async () => {
    await subscriber();
    await subscriber();
    await pass();
    await pass(T + DAY);
    expect(fake.requests).toHaveLength(0);
    expect(await nextPushAlarm(deps(), T)).toBeNull();
  });
});

describe("A-P6-SEND 预算：关键预留与当日用尽", () => {
  it("普通外发用尽时关键通知仍可发；普通通知推到下一 UTC 日", async () => {
    const a = await subscriber();
    const routine = await due("limited_start_1h");
    await due("cancelled_or_retracted", T, routine);
    const day = utcDayPeriod(T);
    await exec(
      "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,?,0,?)",
      pushCounterKeys(day.key).send,
      pushSendDayLimit(false),
      T,
    );
    await pass();
    expect(fake.requests).toHaveLength(1);
    expect(
      (await openPush(a.sub, fake.requests[0] as (typeof fake.requests)[number])).body,
    ).toContain("取消或撤回");
    expect(fake.requests[0]?.headers.get("urgency")).toBe("high");
    expect(
      await one<{ next_attempt_at: number; status: string }>(
        "SELECT status,next_attempt_at FROM push_messages WHERE critical=0",
      ),
    ).toEqual({ status: "pending", next_attempt_at: day.endMsExclusive });
    expect(await nextPushAlarm(deps(), T)).toBe(day.endMsExclusive);
    await pass(day.endMsExclusive);
    expect(fake.requests).toHaveLength(2);
    expect(await counter(pushCounterKeys(utcDayPeriod(day.endMsExclusive).key).send)).toBe(1);
  });
});

describe("A-P6-SEND 结果处理：退避、结果不明、失效与配置拒绝", () => {
  it("临时错误按 watchdog 周期退避重试，每次尝试都计预算", async () => {
    await subscriber();
    await due();
    fake.respond(503, 201);
    await pass();
    const retry = T + WATCHDOG_INTERVAL * 1000;
    expect(await one("SELECT status,attempts,next_attempt_at FROM push_messages")).toEqual({
      status: "retry_wait",
      attempts: 1,
      next_attempt_at: retry,
    });
    expect(await one("SELECT status FROM deliveries WHERE channel='push'")).toEqual({
      status: "retry_wait",
    });
    await pass(retry - 1);
    expect(fake.requests).toHaveLength(1);
    expect(await nextPushAlarm(deps(), T + 1)).toBe(retry);
    await pass(retry);
    expect(fake.requests).toHaveLength(2);
    expect(await one("SELECT status,attempts FROM push_messages")).toEqual({
      status: "accepted",
      attempts: 2,
    });
    // 每次尝试计入它实际外发那一 UTC 日的预算（T 为 23:59，重试落在下一日）。
    expect(await counter(pushCounterKeys(utcDayPeriod(T).key).send)).toBe(1);
    expect(await counter(pushCounterKeys(utcDayPeriod(retry).key).send)).toBe(1);
  });

  it("超时/异常是结果不明：不盲目重发；浏览器的处理回执确认它并合并写入活动水位与租期", async () => {
    const a = await subscriber();
    await due();
    fake.respond("throws");
    await pass();
    expect(await one("SELECT status FROM push_messages")).toEqual({ status: "unknown" });
    await pass(T + DAY / 2);
    expect(fake.requests).toHaveLength(1);
    const message = (await one<{ id: string }>("SELECT id FROM push_messages")) as { id: string };
    const at = T + 5_000;
    expect(
      await processedReceipt(
        env.DB,
        a.bindingId,
        { receipt_token: a.receipt, message_id: message.id },
        at,
      ),
    ).toEqual({ result: "recorded" });
    expect(await one("SELECT status FROM push_messages")).toEqual({ status: "accepted" });
    expect(await one("SELECT status FROM deliveries WHERE channel='push'")).toEqual({
      status: "accepted",
    });
    expect(
      await one(
        "SELECT last_processed_at,lease_expires_at FROM push_bindings WHERE id=?",
        a.bindingId,
      ),
    ).toEqual({ last_processed_at: at, lease_expires_at: at + PUSH_LEASE * DAY });
    expect(await one("SELECT last_push_processed_at FROM users WHERE id=?", a.userId)).toEqual({
      last_push_processed_at: at,
    });
    // 合并写入：间隔内的再次确认不写库。
    await processedReceipt(
      env.DB,
      a.bindingId,
      { receipt_token: a.receipt, message_id: message.id },
      at + PUSH_RECEIPT_WRITE_INTERVAL * DAY - 1,
    );
    expect(
      await one("SELECT last_processed_at FROM push_bindings WHERE id=?", a.bindingId),
    ).toEqual({ last_processed_at: at });
    // 凭证不符：不写任何东西。
    await expect(
      processedReceipt(
        env.DB,
        a.bindingId,
        { receipt_token: "Z".repeat(43), message_id: message.id },
        at + 2 * PUSH_RECEIPT_WRITE_INTERVAL * DAY,
      ),
    ).rejects.toThrow("push_receipt_not_found");
  });

  it("404/410 停用该端点，后续通知不再发往它", async () => {
    const a = await subscriber();
    const b = await subscriber();
    const first = await due();
    fake.respondTo(a.sub.endpoint, 404);
    await pass();
    expect(await one("SELECT state FROM push_bindings WHERE id=?", a.bindingId)).toEqual({
      state: "gone",
    });
    expect(await one("SELECT state FROM push_bindings WHERE id=?", b.bindingId)).toEqual({
      state: "active",
    });
    await due("cancelled_or_retracted", T + 1, first);
    await pass(T + 1);
    expect(fake.requests.filter((r) => r.url === a.sub.endpoint)).toHaveLength(1);
    expect(fake.requests.filter((r) => r.url === b.sub.endpoint)).toHaveLength(2);
  });

  it("401/403 关闭 Push 开关等待核对配置，消息退避、绑定一个不动", async () => {
    const a = await subscriber();
    const b = await subscriber();
    await due();
    fake.respond(401);
    await pass();
    expect(await one("SELECT value_json FROM system_state WHERE key='push_enabled'")).toEqual({
      value_json: "false",
    });
    expect(fake.requests).toHaveLength(1);
    for (const bound of [a, b])
      expect(await one("SELECT state FROM push_bindings WHERE id=?", bound.bindingId)).toEqual({
        state: "active",
      });
    const statuses = (
      await all<{ status: string }>("SELECT status FROM push_messages ORDER BY status")
    ).map((row) => row.status);
    expect(statuses).toEqual(["pending", "retry_wait"]);
    // 开关关闭期间不再外发，也不为待发消息排 alarm。
    await pass(T + DAY);
    expect(fake.requests).toHaveLength(1);
    expect(await nextPushAlarm(deps(), T + 2)).toBeNull();
  });
});

describe("A-P6-SEND 维护、租期与回收", () => {
  it("外发租约过期的转 unknown 不重发；过期未发的转 expired", async () => {
    await subscriber();
    await due();
    await exec("UPDATE system_state SET value_json='false' WHERE key='push_enabled'");
    await pass();
    const message = (await one<{ id: string; delivery_id: string }>(
      "SELECT id,delivery_id FROM push_messages",
    )) as { id: string; delivery_id: string };
    await exec(
      "UPDATE push_messages SET status='calling_provider',lease_expires_at=? WHERE id=?",
      T,
      message.id,
    );
    await exec("UPDATE deliveries SET status='calling_provider' WHERE id=?", message.delivery_id);
    await maintainPushMessages(env.DB, T);
    expect(await one("SELECT status FROM push_messages")).toEqual({ status: "unknown" });
    expect(await one("SELECT status FROM deliveries WHERE id=?", message.delivery_id)).toEqual({
      status: "unknown",
    });
    await exec("UPDATE push_messages SET status='pending',expires_at=? WHERE id=?", T, message.id);
    await exec("UPDATE deliveries SET status='pending' WHERE id=?", message.delivery_id);
    await maintainPushMessages(env.DB, T);
    expect(await one("SELECT status FROM push_messages")).toEqual({ status: "expired" });
    expect(await one("SELECT status FROM deliveries WHERE id=?", message.delivery_id)).toEqual({
      status: "expired",
    });
  });

  it("租期到期暂停；暂停/失效超过宽限后清理；pending 过激活截止即清理", async () => {
    const expiring = await subscriber();
    const stale = await subscriber();
    const gone = await subscriber();
    const fresh = await subscriber();
    const now = T + DAY;
    // 宽限期按"天"独立换算（不复用被测的换算函数）。
    const cutoff = now - PUSH_STALE_GRACE * DAY;
    expect(pushStaleCleanupBefore(now)).toBe(cutoff);
    await exec("UPDATE push_bindings SET lease_expires_at=? WHERE id=?", now, expiring.bindingId);
    await exec(
      "UPDATE push_bindings SET state='paused',paused_reason='user',lease_expires_at=? WHERE id=?",
      cutoff,
      stale.bindingId,
    );
    await exec(
      "UPDATE push_bindings SET state='gone',gone_at=? WHERE id=?",
      cutoff + 1,
      gone.bindingId,
    );
    await exec(
      "UPDATE push_bindings SET state='pending',activated_at=NULL,activation_deadline=? WHERE id=?",
      now,
      fresh.bindingId,
    );
    await cleanupRetentionPage(env.DB, now);
    expect(
      await one("SELECT state,paused_reason FROM push_bindings WHERE id=?", expiring.bindingId),
    ).toEqual({
      state: "paused",
      paused_reason: "lease_expired",
    });
    expect(await one("SELECT 1 FROM push_bindings WHERE id=?", stale.bindingId)).toBeNull();
    expect(await one("SELECT state FROM push_bindings WHERE id=?", gone.bindingId)).toEqual({
      state: "gone",
    });
    expect(await one("SELECT 1 FROM push_bindings WHERE id=?", fresh.bindingId)).toBeNull();
    await cleanupRetentionPage(env.DB, now + 2);
    expect(await one("SELECT 1 FROM push_bindings WHERE id=?", gone.bindingId)).toBeNull();
  });
});

describe("A-P6-SEND DeliveryDO 接线", () => {
  it("同一串行 tick 里邮件不可用时照常外发 Push；alarm 计入待发 Push", async () => {
    await subscriber();
    await due();
    const mail: SendDeps = {
      db: env.DB,
      now: () => T,
      origin: "https://synthetic.example",
      fieldKey: async () => (await testKeyring).fieldEncryption(),
      available: async () => false,
      pause: async () => {},
      provider: {
        send: async () => {
          throw Error("must_not_send_mail");
        },
      },
    };
    const runtime = new DeliveryRuntime(mail, deps());
    expect(await runtime.nextAlarm()).toBe(T);
    await runtime.tick();
    expect(fake.requests).toHaveLength(1);
    expect(await one("SELECT status FROM push_messages")).toEqual({ status: "accepted" });
  });
});
