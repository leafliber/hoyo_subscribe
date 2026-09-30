// A-P4-BUDGET · 本地真实 D1，全部 MailProvider 为替身。
import { env } from "cloudflare:test";
import {
  CHANGE_TTL,
  MAIL_BASE_DAY,
  MAIL_SEATS_MAX,
  MAIL_URGENT_DAY,
  MAIL_URGENT_FLOOR,
  MAIL_USER_URGENT_DAY,
  MATCH_PAGE,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDispatchAlarm, runDispatchPass } from "../../executors/delivery/dispatch";
import { DeliveryRuntime } from "../../executors/delivery/runtime";
import { testKeyring } from "../../shell/test-support";
import { conditionalCommit } from "../../storage/cas";
import { insertUsageRowStatement, readMailDayLedger } from "../../storage/ledger/mail-ledger";
import { splitSqlStatements } from "../../storage/split-sql";
import { selectDispatchCandidate } from "../dispatch/dispatch";
import { type SendDeps, sendOneMail } from "../outbox/send";
import { claimMail, transitionMail } from "../outbox/state";
import type { MailRow } from "../outbox/types";
import { approveBudgetedDispatch, planBudgetedDispatch } from "./dispatch";
import {
  nextRolloverAlarm,
  releaseOldReservation,
  reserveUnsentIntent,
  rolloverBudgetPage,
} from "./rollover";
import { batch, fact, migrations, rows, run, select, T, user } from "./test-support";

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(splitSqlStatements(migrations[path] ?? "").map((s) => env.DB.prepare(s)));
});
beforeEach(async () => {
  for (const table of [
    "system_state",
    "deliveries",
    "mail_outbox",
    "usage_periods",
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
});
const ledger = (now = T, uid?: string) => readMailDayLedger(env.DB, utcDayPeriod(now).key, uid);
async function mail(id: string) {
  const r = await env.DB.prepare("SELECT * FROM mail_outbox WHERE id=?").bind(id).first<MailRow>();
  if (!r) throw Error("missing");
  return r;
}
function deps(now = () => T): SendDeps {
  return {
    db: env.DB,
    now,
    available: async () => true,
    pause: async () => {},
    origin: "https://synthetic.example",
    fieldKey: async () => (await testKeyring).fieldEncryption(),
    unsubscribe: async () => ({
      page: "https://synthetic.example/unsubscribe",
      oneClick: "https://synthetic.example/one-click",
    }),
    provider: {
      send: vi.fn(async () => ({ kind: "accepted" as const, messageId: crypto.randomUUID() })),
    },
  };
}
async function approve(bid: string, now = T) {
  const result = await approveBudgetedDispatch(env.DB, await select(bid, now), now);
  expect(result.outcome).toBe("committed");
  if (!("outboxId" in result) || !result.outboxId) throw Error("not approved");
  return result.outboxId;
}
async function seedPool(pool: "base_business" | "urgent_business", used: number, now = T) {
  const s = insertUsageRowStatement(pool, utcDayPeriod(now), now);
  await run(s.sql, ...s.params);
  await run(
    "UPDATE usage_periods SET settled=? WHERE pool=? AND period_key=? AND user_id IS NULL",
    used,
    pool,
    utcDayPeriod(now).key,
  );
}

describe("A-P4-BUDGET 批准与公平游标原子组合", () => {
  it("合并多条 Delivery 只扣一个机会；unknown 保留占用和游标、不自动重投", async () => {
    const uid = await user(1);
    await fact();
    await fact();
    const b = await batch();
    const id = await approve(b.id);
    expect((await ledger(T, uid)).userBase?.reserved).toBe(1);
    expect(await rows("SELECT mail_outbox_ref FROM deliveries")).toEqual([
      { mail_outbox_ref: id },
      { mail_outbox_ref: id },
    ]);
    const d = deps();
    d.provider.send = vi.fn<SendDeps["provider"]["send"]>(async () => ({
      kind: "unknown" as const,
      reason: "synthetic",
      pause: false,
    }));
    expect(await sendOneMail(d, "test")).toBe(true);
    expect(await sendOneMail(d, "test")).toBe(false);
    expect((await ledger(T, uid)).userBase).toEqual({ reserved: 0, settled: 0, uncertain: 1 });
    expect(await rows("SELECT last_order FROM dispatch_cursors")).toEqual([{ last_order: 1 }]);
    await rolloverBudgetPage(env.DB, utcDayPeriod(T).endMsExclusive);
    expect((await mail(id)).status).toBe("unknown");
    expect((await ledger()).pools.base_business.uncertain).toBe(1);
  });
  it("两个并发批准抢最后一额仅一人成功；失败者不建 outbox、不推进游标", async () => {
    await user(1);
    await user(2);
    await fact();
    const b = await batch();
    const first = await select(b.id);
    const second = await selectDispatchCandidate(env.DB, b.id, T, [
      { userId: first.userId, priority: first.priority },
    ]);
    if (second.outcome !== "candidate") throw Error("candidate");
    const a = await planBudgetedDispatch(env.DB, first, T),
      c = await planBudgetedDispatch(env.DB, second.proposal, T);
    if (!a || !c) throw Error("plan");
    await seedPool("base_business", MAIL_BASE_DAY - 1);
    const result = await Promise.all([
      conditionalCommit(env.DB, a.plan),
      conditionalCommit(env.DB, c.plan),
    ]);
    expect(result.filter((r) => r.outcome === "committed")).toHaveLength(1);
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(1);
    expect((await ledger()).pools.base_business.reserved).toBe(1);
  });
  it("预算在计划之后耗尽仍拒绝，SQL 报错整批回滚（含游标、账本、outbox）", async () => {
    await user(1);
    await fact();
    const b = await batch(),
      p = await select(b.id);
    const planned = await planBudgetedDispatch(env.DB, p, T);
    if (!planned) throw Error("plan");
    await seedPool("base_business", MAIL_BASE_DAY);
    expect((await conditionalCommit(env.DB, planned.plan)).outcome).toBe("condition_missed");
    expect(await rows("SELECT last_order FROM dispatch_cursors")).toEqual([{ last_order: -1 }]);
    await seedPool("base_business", 0);
    await run(
      `CREATE TRIGGER synthetic_budget_failure BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`,
    );
    try {
      await expect(conditionalCommit(env.DB, planned.plan)).rejects.toThrow();
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_budget_failure");
    }
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    expect((await ledger()).pools.base_business.reserved).toBe(0);
    expect(await rows("SELECT last_order FROM dispatch_cursors")).toEqual([{ last_order: -1 }]);
  });
  it("100 席位全量取消可批准，恰余 floor 后拒绝更正/晚发现但仍批准取消", async () => {
    for (let n = 0; n < MAIL_SEATS_MAX; n++) await user(n);
    await fact("cancelled_or_retracted");
    const b = await batch();
    for (let n = 0; n < MAIL_SEATS_MAX; n++) await approve(b.id);
    expect(MAIL_URGENT_DAY - (await ledger()).pools.urgent_business.reserved).toBe(
      MAIL_URGENT_FLOOR,
    );
    await fact("important_change");
    await fact("late_discovery:limited_start_1h");
    const low = await batch();
    const p = await select(low.id);
    expect((await approveBudgetedDispatch(env.DB, p, T)).outcome).toBe("condition_missed");
    const late = await selectDispatchCandidate(
      env.DB,
      low.id,
      T,
      (await rows<{ id: string }>("SELECT id FROM users")).map((u) => ({
        userId: u.id,
        priority: p.priority,
      })),
    );
    expect(late.outcome).toBe("candidate");
    if (late.outcome === "candidate")
      expect((await approveBudgetedDispatch(env.DB, late.proposal, T)).outcome).toBe(
        "condition_missed",
      );
    await fact("cancelled_or_retracted");
    await approve((await batch()).id);
    expect((await ledger()).pools.urgent_business.reserved).toBe(MAIL_SEATS_MAX + 1);
  }, 60000);
  it("每用户基础/紧急独立限频，UTC 次日恢复且公平游标不清零", async () => {
    const uid = await user(7);
    await fact();
    await approve((await batch()).id);
    await fact();
    const basic = await batch();
    expect((await approveBudgetedDispatch(env.DB, await select(basic.id), T)).outcome).toBe(
      "condition_missed",
    );
    for (let n = 0; n < MAIL_USER_URGENT_DAY; n++) {
      await fact("cancelled_or_retracted");
      await approve((await batch()).id);
    }
    await fact("cancelled_or_retracted");
    const extra = await batch();
    expect((await approveBudgetedDispatch(env.DB, await select(extra.id), T)).outcome).toBe(
      "condition_missed",
    );
    const next = utcDayPeriod(T).endMsExclusive;
    await approve((await batch(next)).id, next);
    expect((await ledger(next, uid)).userUrgent?.reserved).toBe(1);
    expect(
      (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors")).every(
        (r) => r.last_order === 7,
      ),
    ).toBe(true);
  });
});

describe("A-P4-BUDGET UTC 日界与旧租约竞态", () => {
  it.each(["pending", "leased", "retry_wait"] as const)(
    "未调用 %s 旧日撤回并重新预留，保留意图、作废旧租约",
    async (status) => {
      const uid = await user(1);
      await fact();
      const id = await approve((await batch()).id);
      await run(
        "UPDATE mail_outbox SET status=?,lease_owner=?,lease_expires_at=? WHERE id=?",
        status,
        status === "leased" ? "old" : null,
        T + WATCHDOG_INTERVAL * 1000,
        id,
      );
      const old = await mail(id),
        next = utcDayPeriod(T).endMsExclusive;
      await rolloverBudgetPage(env.DB, next);
      const moved = await mail(id);
      expect(moved.period_key).toBe(utcDayPeriod(next).key);
      expect(moved.status).toBe("pending");
      expect(moved.lease_version).toBeGreaterThan(old.lease_version);
      expect((await ledger(T, uid)).userBase?.reserved).toBe(0);
      expect((await ledger(next, uid)).userBase?.reserved).toBe(1);
      expect(
        await transitionMail(env.DB, old, next, {
          status: "calling_provider",
          budget: { from: "reserved", to: "uncertain" },
        }),
      ).toBe(false);
    },
  );
  it("新日满额先撤回旧日，意图保留等待；不误释放已调用、unknown 和明确拒绝已结算的邮件", async () => {
    await user(1);
    await fact();
    const id = await approve((await batch()).id),
      next = utcDayPeriod(T).endMsExclusive;
    await seedPool("base_business", MAIL_BASE_DAY, next);
    await rolloverBudgetPage(env.DB, next);
    expect((await mail(id)).period_key).toBe("");
    expect((await ledger()).pools.base_business.reserved).toBe(0);
    expect(await claimMail(env.DB, "new", next, id)).toBeNull();
    expect(await nextRolloverAlarm(env.DB, next)).toBe(next + WATCHDOG_INTERVAL * 1000);
    await seedPool("base_business", 0, next);
    await rolloverBudgetPage(env.DB, next + WATCHDOG_INTERVAL * 1000);
    expect((await mail(id)).period_key).toBe(utcDayPeriod(next).key);
  });
  it("真实外调抢先跨过边界，旧读撤回失败，其他信预留不受影响", async () => {
    await user(1);
    await fact("cancelled_or_retracted");
    const id = await approve((await batch()).id);
    const leased = await claimMail(env.DB, "sender", T, id);
    if (!leased) throw Error("claim");
    expect(
      await transitionMail(env.DB, leased, T, {
        status: "calling_provider",
        budget: { from: "reserved", to: "uncertain" },
      }),
    ).toBe(true);
    expect(await releaseOldReservation(env.DB, leased, utcDayPeriod(T).endMsExclusive)).toBe(false);
    expect((await ledger()).pools.urgent_business).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 1,
    });
  });
  it("同一旧日行并发撤回只退款一次，未预留意图并发重排只预留一次", async () => {
    await user(1);
    await fact();
    const id = await approve((await batch()).id),
      old = await mail(id),
      next = utcDayPeriod(T).endMsExclusive;
    expect(
      (
        await Promise.all([
          releaseOldReservation(env.DB, old, next),
          releaseOldReservation(env.DB, old, next),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
    const fresh = await mail(id);
    expect(
      (
        await Promise.all([
          reserveUnsentIntent(env.DB, fresh, next),
          reserveUnsentIntent(env.DB, fresh, next),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
    expect((await ledger()).pools.base_business.reserved).toBe(0);
    expect((await ledger(next)).pools.base_business.reserved).toBe(1);
  });
  it("明确可重试拒绝保留已消耗预算，不自行分配重试预算", async () => {
    await user(1);
    await fact();
    const id = await approve((await batch()).id),
      d = deps();
    d.provider.send = vi.fn<SendDeps["provider"]["send"]>(async () => ({
      kind: "rejected" as const,
      retryable: true,
      reason: "synthetic",
      pause: false as const,
    }));
    await sendOneMail(d, "sender");
    await new DeliveryRuntime(d).watchdog();
    await rolloverBudgetPage(env.DB, utcDayPeriod(T).endMsExclusive);
    expect((await mail(id)).status).toBe("retry_wait");
    expect((await ledger()).pools.base_business).toEqual({ settled: 1, reserved: 0, uncertain: 0 });
    expect(d.provider.send).toHaveBeenCalledTimes(1);
  });
});

describe("A-P4-BUDGET 业务执行器闭环", () => {
  it("调度持久跨批次推进，替身发送 accepted 后结算；完整展开之前不批准", async () => {
    await user(1);
    await fact("cancelled_or_retracted");
    const d = deps(),
      runtime = new DeliveryRuntime(d);
    for (let n = 0; n < 8; n++) {
      await runtime.tick();
    }
    expect(d.provider.send).toHaveBeenCalledTimes(1);
    expect((await ledger()).pools.urgent_business).toEqual({
      settled: 1,
      reserved: 0,
      uncertain: 0,
    });
  });
  it("预算拒绝的前排用户不堵住其他用户，deferred 跨执行器重启保存", async () => {
    const first = await user(1);
    await fact();
    await approve((await batch()).id);
    await user(2);
    await user(3);
    await fact();
    await batch();
    for (let n = 0; n < 4; n++) await runDispatchPass(env.DB, () => T, T + CHANGE_TTL * 1000);
    expect(await rows("SELECT recipient_user_id FROM mail_outbox")).toHaveLength(3);
    expect((await ledger(T, first)).userBase?.reserved).toBe(1);
  });
});

it("A-P4-BUDGET 旧日扫描 rows_read 不随 2000 条已调用历史增长", async () => {
  const { ROLLOVER_CANDIDATES_SQL } = await import("./rollover");
  const { nextRejectedRetryAlarm, REJECTED_RETRY_SQL } = await import("./rejected");
  const uid = await user(1),
    f = await fact();
  await approve((await batch()).id);
  const day = utcDayPeriod(utcDayPeriod(T).endMsExclusive);
  const queries: { sql: string; params: unknown[] }[] = [
    { sql: ROLLOVER_CANDIDATES_SQL, params: [day.key, day.startMs, MATCH_PAGE] },
    { sql: REJECTED_RETRY_SQL, params: [T, T, T, T, T, MATCH_PAGE] },
  ];
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(stmt, method) {
              if (method === "bind")
                return (...params: unknown[]) => {
                  queries.push({ sql, params });
                  return stmt.bind(...params);
                };
              const value = Reflect.get(stmt, method);
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await nextRolloverAlarm(db, day.startMs);
  await nextRejectedRetryAlarm(db, T);
  await nextDispatchAlarm(db, T);
  const measure = async () =>
    Promise.all(
      queries.map(
        async (q) =>
          (
            await env.DB.prepare(q.sql)
              .bind(...q.params)
              .all()
          ).meta.rows_read,
      ),
    );
  const before = await measure(),
    history = JSON.stringify(Array.from({ length: 2000 }, (_, n) => n));
  await run(
    `INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,status,sent_at,created_at,updated_at)
    SELECT 'synthetic-history-'||value,'base_business',4,'2020-01-01',1,'notification_digest','accepted',?,?,? FROM json_each(?)`,
    T,
    T,
    T,
    history,
  );
  await run(
    `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at)
    SELECT 'synthetic-job-history-'||value,'mail_send','{}',?,'done',?,? FROM json_each(?)`,
    T,
    T,
    T,
    history,
  );
  await run(
    `INSERT INTO deliveries(id,occurrence_id,user_id,channel,target_ref,milestone_id,schedule_revision,kind,priority,dedupe_family,status,expires_at,created_at,updated_at)
    SELECT 'synthetic-delivery-history-'||value,?,?,'email',?,?,1,'rule',4,'synthetic-family-'||value,'accepted',?,?,? FROM json_each(?)`,
    f.oid,
    uid,
    uid,
    f.nid,
    T,
    T,
    T,
    history,
  );
  const after = await measure();
  expect(after).toEqual(before);
  console.log("A-P4-BUDGET hot query rows_read", JSON.stringify({ before, after }));
});

it("A-P4-BUDGET 已外调可重试拒绝并发只计一次，到期 expired 不退款", async () => {
  const {
    finishRejectedRetryPage,
    RETRY_COUNTER_KEY,
    RETRY_BUDGET_NOT_SCHEDULED,
    nextRejectedRetryAlarm,
  } = await import("./rejected");
  await user(1);
  const f = await fact();
  const id = await approve((await batch()).id),
    d = deps();
  d.provider.send = vi.fn<SendDeps["provider"]["send"]>(async () => ({
    kind: "rejected",
    retryable: true,
    reason: "synthetic",
    pause: false,
  }));
  await sendOneMail(d, "sender");
  await Promise.all([finishRejectedRetryPage(env.DB, T), finishRejectedRetryPage(env.DB, T)]);
  expect(await rows("SELECT value_json FROM system_state WHERE key=?", RETRY_COUNTER_KEY)).toEqual([
    { value_json: '{"count":1,"base_business":1}' },
  ]);
  expect(await nextRejectedRetryAlarm(env.DB, T)).toBe(f.expiry);
  expect(await finishRejectedRetryPage(env.DB, T)).toBe(0);
  await finishRejectedRetryPage(env.DB, f.expiry);
  expect((await mail(id)).status).toBe("expired");
  expect(
    await rows("SELECT last_error,status FROM jobs WHERE id=?", `delivery:mail:${id}`),
  ).toEqual([{ last_error: RETRY_BUDGET_NOT_SCHEDULED, status: "done" }]);
  expect((await ledger()).pools.base_business).toEqual({ reserved: 0, settled: 1, uncertain: 0 });
  expect(await nextRejectedRetryAlarm(env.DB, f.expiry)).toBeNull();
  expect(d.provider.send).toHaveBeenCalledTimes(1);
});

it("A-P4-BUDGET 导出构造随外部守卫批准，转换检查全局和用户源占用", async () => {
  const { planMailReservation } = await import("@hoyo/contracts");
  const {
    mailBudgetCapacityPredicate,
    reserveMailBudgetEffects,
    mailReservationTransitionPredicate,
    mailReservationTransitionEffects,
  } = await import("../../storage/ledger/mail-ledger");
  const uid = await user(1),
    period = utcDayPeriod(T),
    ref = { pool: "base_business" as const, periodKey: period.key, userId: uid, now: T };
  const capacity = mailBudgetCapacityPredicate(
    planMailReservation("base_routine_or_announce"),
    period.key,
    uid,
  );
  const plan = {
    preamble: [
      insertUsageRowStatement(ref.pool, period, T),
      insertUsageRowStatement(ref.pool, period, T, uid),
    ],
    guard: {
      sql: `UPDATE users SET updated_at=? WHERE id=? AND (${capacity.sql})`,
      params: [T, uid, ...capacity.params],
    },
    effects: reserveMailBudgetEffects(ref),
  };
  expect((await conditionalCommit(env.DB, plan)).outcome).toBe("committed");
  expect((await conditionalCommit(env.DB, plan)).outcome).toBe("condition_missed");
  for (const transition of ["mark_uncertain", "resolve_uncertain"] as const) {
    const source = mailReservationTransitionPredicate(ref, transition);
    expect(
      (
        await conditionalCommit(env.DB, {
          guard: {
            sql: `UPDATE users SET updated_at=? WHERE id=? AND (${source.sql})`,
            params: [T, uid, ...source.params],
          },
          effects: mailReservationTransitionEffects(ref, transition),
        })
      ).outcome,
    ).toBe("committed");
  }
  expect((await ledger(T, uid)).userBase).toEqual({ reserved: 0, settled: 1, uncertain: 0 });
  // 用户源占用缺失时整批拒绝，不能先扣全局再在用户效果失败。
  await run("UPDATE usage_periods SET reserved=1 WHERE pool=? AND user_id IS NULL", ref.pool);
  const source = mailReservationTransitionPredicate(ref, "release");
  expect(
    (
      await conditionalCommit(env.DB, {
        guard: {
          sql: `UPDATE users SET updated_at=? WHERE id=? AND (${source.sql})`,
          params: [T, uid, ...source.params],
        },
        effects: mailReservationTransitionEffects(ref, "release"),
      })
    ).outcome,
  ).toBe("condition_missed");
  expect((await ledger()).pools.base_business.reserved).toBe(1);
});

it("A-P4-BUDGET 新日无预算等待到期后终止，不把过期意图无限保留", async () => {
  await user(1);
  const f = await fact();
  const id = await approve((await batch()).id),
    next = utcDayPeriod(T).endMsExclusive;
  await seedPool("base_business", MAIL_BASE_DAY, next);
  await rolloverBudgetPage(env.DB, next);
  expect((await mail(id)).period_key).toBe("");
  await rolloverBudgetPage(env.DB, f.expiry);
  expect((await mail(id)).status).toBe("expired");
  expect((await ledger()).pools.base_business.reserved).toBe(0);
});

it("A-P4-BUDGET 有 failed 起步的批次仍批准其他发生项，不复活 failed", async () => {
  const { startDispatchBatch } = await import("../dispatch/batch");
  const { startDueOccurrenceExpansion } = await import("../occurrences/expand");
  await user(1);
  const bad = await fact(),
    good = await fact("cancelled_or_retracted");
  const b = await startDispatchBatch(env.DB, "synthetic-failed-batch", T);
  await run(
    `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('delivery:dispatch','mail_dispatch_coordinator',?,?,'pending',?,?)`,
    JSON.stringify({ batchId: b.id, deferred: [] }),
    T,
    T,
    T,
  );
  await run(
    `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES (?,'occurrence_start','{}',?,'failed',?,?)`,
    `occurrence:${bad.oid}:start`,
    T,
    T,
    T,
  );
  expect(await startDueOccurrenceExpansion(env.DB, T, 2)).toBe(1);
  const runtime = new DeliveryRuntime(deps());
  for (let n = 0; n < 6; n++) await runtime.tick();
  expect(await rows("SELECT audience_upper_order FROM occurrences WHERE id=?", bad.oid)).toEqual([
    { audience_upper_order: null },
  ]);
  expect(await rows("SELECT status FROM deliveries WHERE occurrence_id=?", good.oid)).toEqual([
    { status: "accepted" },
  ]);
});

it("A-P4-BUDGET 只剩失败展开的 pending Delivery 不触发新批次空转", async () => {
  await user(1);
  const failed = await fact();
  await batch();
  await run("UPDATE jobs SET status='failed' WHERE id=?", `occurrence:${failed.oid}:email`);
  expect(await nextDispatchAlarm(env.DB, T)).toBeNull();
  await runDispatchPass(env.DB, () => T, T + CHANGE_TTL * 1000);
  expect(await rows("SELECT due_at FROM jobs WHERE id='delivery:dispatch'")).toEqual([
    { due_at: Math.min(utcDayPeriod(T).endMsExclusive, T + WATCHDOG_INTERVAL * 1000) },
  ]);
  expect(await nextDispatchAlarm(env.DB, T)).toBeNull();
  expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
});

it.each([false, true])(
  "A-P4-BUDGET 预算扫描错误 terminal=%s 不停止认证核心，持久退避",
  async (terminal) => {
    const { REJECTED_RETRY_SQL } = await import("./rejected");
    let scans = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql === REJECTED_RETRY_SQL) {
              scans++;
              throw Error(terminal ? "too many SQL variables" : "temporary D1 failure");
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
      T,
    );
    const runtime = new DeliveryRuntime({ ...deps(), db });
    await runtime.watchdog();
    await runtime.watchdog();
    expect(scans).toBe(1);
    expect(await rows("SELECT status FROM jobs WHERE id='delivery:backoff'")).toHaveLength(0);
    expect(await rows("SELECT status FROM jobs WHERE id='delivery:budget-backoff'")).toEqual([
      { status: terminal ? "failed" : "pending" },
    ]);
    expect(
      await rows("SELECT value_json FROM system_state WHERE key='mail_sending_available'"),
    ).toEqual([{ value_json: "true" }]);
  },
);

it.each(["version", "owner"])(
  "A-P4-BUDGET 同状态下旧租约 %s 不得撤回新持有者预留",
  async (changed) => {
    await user(1);
    await fact();
    const id = await approve((await batch()).id);
    const old = await claimMail(env.DB, "old", T, id);
    if (!old) throw Error("lease");
    if (changed === "version")
      await run("UPDATE mail_outbox SET lease_version=lease_version+1 WHERE id=?", id);
    else await run("UPDATE mail_outbox SET lease_owner='new' WHERE id=?", id);
    expect(await releaseOldReservation(env.DB, old, utcDayPeriod(T).endMsExclusive)).toBe(false);
    expect((await ledger()).pools.base_business.reserved).toBe(1);
  },
);

it.each(["existing_auth_first_login", "auth_resend", "signup_auth"] as const)(
  "A-P4-BUDGET 认证跨日 %s 沿用原意图且重新核 floor",
  async (intent) => {
    const { MAIL_AUTH_DAY, MAIL_AUTH_FLOOR, OTP_TTL, poolOfMailIntent } = await import(
      "@hoyo/contracts"
    );
    const { reserveMailBudget } = await import("../../storage/ledger/mail-ledger");
    const id = `synthetic-auth-${intent}`,
      challenge = `synthetic-challenge-${intent}`,
      next = utcDayPeriod(T).endMsExclusive,
      pool = poolOfMailIntent(intent);
    await run(
      `INSERT INTO auth_challenges(id,purpose,email_key,address_version,preauth_id,mac,generation,deadline,created_at,updated_at)
    VALUES (?,?,?,1,'synthetic','synthetic',?,?,?,?)`,
      challenge,
      intent === "signup_auth" ? "signup" : "login",
      id,
      intent === "auth_resend" ? 1 : 0,
      T + OTP_TTL * 1000,
      T,
      T,
    );
    await run(
      `INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,payload_ref,status,created_at,updated_at)
    VALUES (?,?,0,'',1,'otp',?,'pending',?,?)`,
      id,
      pool,
      challenge,
      T,
      T,
    );
    expect(
      (await reserveMailBudget(env.DB, { intent, period: utcDayPeriod(T), now: T, outboxId: id }))
        .outcome,
    ).toBe("committed");
    const seed = insertUsageRowStatement("existing_auth", utcDayPeriod(next), next);
    await run(seed.sql, ...seed.params);
    await run(
      "UPDATE usage_periods SET settled=? WHERE pool='existing_auth' AND period_key=? AND user_id IS NULL",
      MAIL_AUTH_DAY - MAIL_AUTH_FLOOR,
      utcDayPeriod(next).key,
    );
    await rolloverBudgetPage(env.DB, next);
    expect((await mail(id)).period_key).toBe(
      intent === "existing_auth_first_login" ? utcDayPeriod(next).key : "",
    );
    expect((await ledger()).pools[pool].reserved).toBe(0);
    await run("DELETE FROM mail_outbox WHERE id=?", id);
    await run("DELETE FROM auth_challenges WHERE id=?", challenge);
  },
);
