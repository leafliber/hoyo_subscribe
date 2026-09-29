// A-P4-FAIR · 合成账户/事实；本地 workerd + D1，无邮件服务调用。
import { env } from "cloudflare:test";
import {
  CHANGE_TTL,
  MAIL_DIGEST_WINDOW,
  MAIL_METADATA_TTL,
  MAIL_SEAT_LEASE,
  MATCH_PAGE,
  SUBSCRIPTION_SCHEMA_VERSION,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conditionalCommit } from "../../storage/cas";
import { splitSqlStatements } from "../../storage/split-sql";
import { expandOccurrencePage, startDueOccurrenceExpansion } from "../occurrences/expand";
import { expandDispatchBatchPage, startDispatchBatch } from "./batch";
import { CONTEXT_SQL, contextParams, readDispatchContext } from "./context";
import { planDispatchAttempt, selectDispatchCandidate } from "./dispatch";
import { expireDispatchCandidates, pruneExpiredDispatchBatch } from "./expiry";
import { stageDigestCandidates } from "./future";
import type { DispatchProposal } from "./types";

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
    new Uint8Array([1]),
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
});

describe("A-P4-FAIR 完整受众与持久公平调度", () => {
  it("未完成受众展开不能选择；最后注册者进入完整候选集", async () => {
    for (let n = 0; n < MATCH_PAGE + 1; n++) await user(n);
    await fact();
    const b = await startDispatchBatch(env.DB, id(), T);
    expect(await selectDispatchCandidate(env.DB, b.id, T)).toEqual({ outcome: "expanding" });
    await expandDispatchBatchPage(env.DB, b.id, T);
    expect(await selectDispatchCandidate(env.DB, b.id, T)).toEqual({ outcome: "expanding" });
    await expandDispatchBatchPage(env.DB, b.id, T);
    expect(await rows("SELECT id FROM deliveries")).toHaveLength(MATCH_PAGE + 1);
    expect((await select(b.id)).order).toBe(0);
  });
  it("每天只批准一个机会时跨事件、跨日、重启轮转，不偏向早注册；unknown/失败仍算机会", async () => {
    const users = await Promise.all([user(10), user(20), user(30)]);
    let now = T;
    for (let n = 0; n < 5; n++) {
      await fact("important_change", now);
      const b = await batch(now);
      // 模拟重启重新读取同一批次。
      expect((await startDispatchBatch(env.DB, b.id, now + 1)).startedAt).toBe(now);
      const p = await select(b.id, now);
      expect(p.userId).toBe(users[n % users.length]);
      const out = await approve(p, now);
      await run(
        "UPDATE mail_outbox SET status = ? WHERE id = ?",
        n % 2 ? "failed" : "unknown",
        out,
      );
      now = utcDayPeriod(now).endMsExclusive + 1;
    }
    expect(
      (
        await rows<{ last_order: number; completed_lap: number }>(
          "SELECT last_order,completed_lap FROM dispatch_cursors",
        )
      )[0],
    ).toEqual({ last_order: 20, completed_lap: 1 });
  });
  it("固定五档阶梯及预算池；各组游标独立，跨优先级不合并", async () => {
    await user(10);
    await user(20);
    for (const kind of [
      "new_event",
      "limited_start_1h",
      "late_discovery:limited_start_1h",
      "important_change",
      "cancelled_or_retracted",
    ])
      await fact(kind);
    const b = await batch();
    const purposes = [
      "urgent_business",
      "urgent_business",
      "urgent_business",
      "base_business",
      "base_business",
    ];
    for (let priority = 1; priority <= 5; priority++)
      for (const order of [10, 20]) {
        const p = await select(b.id);
        expect([p.priority, p.order, p.pool]).toEqual([priority, order, purposes[priority - 1]]);
        expect(p.deliveryIds).toHaveLength(1);
        await approve(p);
      }
    expect(await rows("SELECT * FROM dispatch_cursors")).toHaveLength(5);
    expect(await selectDispatchCandidate(env.DB, b.id, T)).toEqual({ outcome: "empty" });
  });
  it("选择与预算拒绝不推进游标；可跳过本轮无预算用户", async () => {
    await user(1);
    await user(2);
    await fact();
    const b = await batch();
    const first = await select(b.id);
    expect((await select(b.id)).userId).toBe(first.userId);
    expect(
      (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors"))[0]
        ?.last_order,
    ).toBe(-1);
    const next = await selectDispatchCandidate(env.DB, b.id, T, [
      { userId: first.userId, priority: first.priority },
    ]);
    expect(next.outcome).toBe("candidate");
    if (next.outcome === "candidate") {
      expect(next.proposal.order).toBe(2);
      await approve(next.proposal);
    }
    expect((await select(b.id)).order).toBe(1);
  });
});

describe("A-P4-FAIR 合并、去重与未来候选", () => {
  it("已到期多节点及窗口端点合并为一封，保留各自去重键，不等待窗口结束", async () => {
    const uid = await user(1);
    await fact();
    await fact();
    const future = await fact("limited_start_1h", T + MAIL_DIGEST_WINDOW * 1000);
    await fact("limited_start_1h", T + MAIL_DIGEST_WINDOW * 1000 + 1);
    const b = await batch();
    const p = await select(b.id);
    expect(p.deliveryIds).toHaveLength(3);
    const before = await rows("SELECT dedupe_family FROM deliveries ORDER BY id");
    const out = await approve(p);
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(1);
    expect(await rows("SELECT id FROM deliveries WHERE mail_outbox_ref = ?", out)).toHaveLength(3);
    expect(await rows("SELECT dedupe_family FROM deliveries ORDER BY id")).toEqual(before);
    expect(
      (await rows<{ created_at: number }>("SELECT created_at FROM mail_outbox"))[0]?.created_at,
    ).toBe(T);
    expect(
      (
        await rows<{ audience_upper_order: number | null }>(
          "SELECT audience_upper_order FROM occurrences WHERE id = ?",
          future.oid,
        )
      )[0]?.audience_upper_order,
    ).toBeNull();
    // 未来项提前合并后，正常到期仍可展开后来加入的用户；原用户不重复。
    const newcomer = await user(2);
    await run(
      "UPDATE subscription_interests SET enabled_at = ? WHERE user_id = ?",
      T + 1,
      newcomer,
    );
    await startDueOccurrenceExpansion(env.DB, future.due, 100);
    while ((await expandOccurrencePage(env.DB, future.oid, future.due)) === "advanced") {
      /* 有限合成受众 */
    }
    const recipients = await rows<{ user_id: string }>(
      "SELECT user_id FROM deliveries WHERE occurrence_id = ? ORDER BY user_id",
      future.oid,
    );
    expect(recipients.map((r) => r.user_id).sort()).toEqual([uid, newcomer].sort());
  });
  it("只有未来候选不独立触发邮件，也不提前冻结其受众", async () => {
    await user(1);
    await fact("limited_start_1h", T + 1);
    const b = await batch();
    expect(await selectDispatchCandidate(env.DB, b.id, T)).toEqual({ outcome: "empty" });
    expect(await rows("SELECT * FROM dispatch_cursors")).toHaveLength(0);
  });
  it("高档预算 deferred 后低档到期项被覆盖，剩余未来候选不能单独发信", async () => {
    const uid = await user(1);
    const correction = await fact("important_change");
    const announcement = await fact("new_event", T, correction);
    const future = await fact("new_event", T + MAIL_DIGEST_WINDOW * 1000);
    const b = await batch();
    const high = await select(b.id);
    expect(high.intent).toBe("urgent_important_change");
    const low = (
      await rows<{ id: string; priority: number }>(
        "SELECT id,priority FROM deliveries WHERE occurrence_id = ? AND user_id = ?",
        announcement.oid,
        uid,
      )
    )[0];
    if (!low) throw new Error("缺少合成低档到期候选");
    expect(high.supersededIds).toEqual([low.id]);
    // 用 deferred 模拟预算推迟，不批准高档；覆盖关系仍应阻止低档到期项抢先发送。
    const deferred = [{ userId: uid, priority: high.priority }];
    expect(await selectDispatchCandidate(env.DB, b.id, T, deferred)).toEqual({ outcome: "empty" });
    const cursors = await rows("SELECT * FROM dispatch_cursors");

    // 模拟此前调度轮已经暂存的未来 Delivery，必须让 digest 真正看到未来候选。
    const { context } = await readDispatchContext(env.DB, uid, b.occurrenceIds, T);
    expect(await stageDigestCandidates(env.DB, b, context, low.priority, T)).toBe(true);
    const staged = (
      await rows<{ id: string; priority: number; due_at: number }>(
        `SELECT d.id,d.priority,o.due_at FROM deliveries d JOIN occurrences o ON o.id = d.occurrence_id
       WHERE d.occurrence_id = ? AND d.user_id = ?`,
        future.oid,
        uid,
      )
    )[0];
    if (!staged) throw new Error("缺少合成未来候选");
    expect(staged.priority).toBe(low.priority);
    expect(staged.due_at).toBeGreaterThan(T);
    expect(staged.due_at).toBeLessThanOrEqual(T + MAIL_DIGEST_WINDOW * 1000);

    const selection = await selectDispatchCandidate(env.DB, b.id, T, deferred);
    expect(selection.outcome).toBe("empty");
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    expect(await rows("SELECT * FROM dispatch_cursors")).toEqual(cursors);
    expect(
      await rows("SELECT id FROM deliveries WHERE status = 'pending' AND mail_outbox_ref IS NULL"),
    ).toHaveLength(3);

    // 到了该未来项自己的 due_at 才能独立成为候选；不是因为资格缺失才得到上面的 empty。
    const atDue = await selectDispatchCandidate(env.DB, b.id, future.due, deferred);
    expect(atDue.outcome).toBe("candidate");
    if (atDue.outcome === "candidate") expect(atDue.proposal.deliveryIds).toEqual([staged.id]);
  });
  it("同节点更正覆盖晚发现和公布，普通提醒仍独立；低优先级不进入更正邮件", async () => {
    await user(1);
    const node = await fact("important_change");
    await fact("late_discovery:limited_start_1h", T, node);
    await fact("new_event", T, node);
    await fact();
    const b = await batch();
    const p = await select(b.id);
    expect(p.priority).toBe(2);
    expect(p.deliveryIds).toHaveLength(1);
    expect(p.supersededIds).toHaveLength(2);
    const out = await approve(p);
    expect(await rows("SELECT id FROM deliveries WHERE mail_outbox_ref = ?", out)).toHaveLength(1);
    expect(
      await rows(
        "SELECT id FROM deliveries WHERE status = 'superseded' AND skip_reason = 'higher_priority_same_node' AND mail_outbox_ref IS NULL",
      ),
    ).toHaveLength(2);
    expect((await select(b.id)).priority).toBe(4);
  });
  it("晚发现覆盖同节点公布；别的节点公布仍可发送", async () => {
    await user(1);
    const node = await fact("late_discovery:limited_start_1h");
    await fact("new_event", T, node);
    await fact("new_event");
    const b = await batch();
    const p = await select(b.id);
    expect(p.priority).toBe(3);
    expect(p.supersededIds).toHaveLength(1);
    await approve(p);
    expect((await select(b.id)).priority).toBe(5);
  });
});

describe("A-P4-FAIR 资格、事务与规模", () => {
  it("过期、改期和失去资格留下终态原因，不消耗机会，不跨日补发", async () => {
    const gone = await user(1);
    await user(2);
    const old = await fact("new_event");
    const changed = await fact("important_change");
    await fact();
    const b = await batch();
    await run("UPDATE occurrences SET expires_at = ? WHERE id = ?", T, old.oid);
    await run("UPDATE events SET schedule_revision = 2 WHERE id = ?", changed.eid);
    await run("UPDATE email_channels SET enabled = 0, routine_enabled = 0 WHERE user_id = ?", gone);
    const p = await select(b.id);
    expect(p.order).toBe(2);
    expect(p.priority).toBe(4);
    const reasons = (
      await rows<{ skip_reason: string }>(
        "SELECT skip_reason FROM deliveries WHERE skip_reason IS NOT NULL",
      )
    ).map((r) => r.skip_reason);
    expect(reasons).toContain("notification_expired");
    expect(reasons).toContain("schedule_revision_changed");
    expect(reasons).toContain("eligibility_lost");
    expect(
      (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors"))[0]
        ?.last_order,
    ).toBe(-1);
    await approve(p);
    expect(await selectDispatchCandidate(env.DB, b.id, utcDayPeriod(T).endMsExclusive + 1)).toEqual(
      { outcome: "empty" },
    );
  });
  it("并发批准和重放仅一封、一次机会；另一个用户的旧游标计划条件未命中", async () => {
    await user(1);
    await user(2);
    await fact();
    const b = await batch();
    const p = await select(b.id);
    const a = await planDispatchAttempt(env.DB, p, T);
    const duplicate = await planDispatchAttempt(env.DB, p, T);
    const second = await selectDispatchCandidate(env.DB, b.id, T, [
      { userId: p.userId, priority: p.priority },
    ]);
    if (!a || !duplicate || second.outcome !== "candidate") throw new Error("缺少合成计划");
    const stale = await planDispatchAttempt(env.DB, second.proposal, T);
    if (!stale) throw new Error("缺少第二计划");
    const results = await Promise.all([
      conditionalCommit(env.DB, a.plan),
      conditionalCommit(env.DB, duplicate.plan),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["committed", "condition_missed"]);
    expect(await conditionalCommit(env.DB, stale.plan)).toEqual({ outcome: "condition_missed" });
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(1);
    expect(await planDispatchAttempt(env.DB, p, T)).toBeNull();
  });
  it("SQL 失败回滚游标/意图/引用；批准前换绑或退订令同一提交整体无效", async () => {
    const uid = await user(1);
    await fact();
    const b = await batch();
    const p = await select(b.id);
    const planned = await planDispatchAttempt(env.DB, p, T);
    if (!planned) throw new Error("缺少计划");
    await env.DB.exec(
      "CREATE TRIGGER synthetic_fail BEFORE UPDATE OF mail_outbox_ref ON deliveries BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    try {
      await expect(conditionalCommit(env.DB, planned.plan)).rejects.toThrow(/synthetic failure/);
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_fail");
    }
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    expect(
      (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors"))[0]
        ?.last_order,
    ).toBe(-1);
    await run("UPDATE users SET email_version = 2 WHERE id = ?", uid);
    expect(await conditionalCommit(env.DB, planned.plan)).toEqual({ outcome: "condition_missed" });
    expect(await planDispatchAttempt(env.DB, p, T)).toBeNull();
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
  });
  it("大批多节点合并使用固定绑定数与三条事务语句；历史终态行不放大资格热查询", async () => {
    const uid = await user(1);
    for (let n = 0; n < 120; n++) await fact();
    const b = await batch();
    const p = await select(b.id);
    expect(p.deliveryIds).toHaveLength(120);
    const planned = await planDispatchAttempt(env.DB, p, T);
    if (!planned) throw new Error("缺少计划");
    expect(planned.plan.effects).toHaveLength(2);
    expect(planned.plan.guard.params?.length).toBeLessThan(100);
    const measure = () =>
      env.DB.prepare(CONTEXT_SQL)
        .bind(...contextParams(uid, b.occurrenceIds, T))
        .all();
    const before = (await measure()).meta.rows_read;
    const original = (
      await rows<{ occurrence_id: string; milestone_id: string }>(
        "SELECT occurrence_id,milestone_id FROM deliveries LIMIT 1",
      )
    )[0];
    if (!original) throw new Error("缺少合成事实");
    for (let n = 0; n < 200; n++)
      await run(
        `INSERT INTO deliveries (id,occurrence_id,user_id,channel,target_ref,milestone_id,schedule_revision,kind,priority,dedupe_family,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,'email',?,?,1,'rule',4,?,'expired',?,?,?)`,
        id(),
        original.occurrence_id,
        uid,
        uid,
        original.milestone_id,
        id(),
        T,
        T,
        T,
      );
    const after = (await measure()).meta.rows_read;
    expect(after).toBe(before);
    expect(await conditionalCommit(env.DB, planned.plan)).toEqual({ outcome: "committed" });
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(1);
    expect(await rows("SELECT id FROM deliveries WHERE mail_outbox_ref IS NOT NULL")).toHaveLength(
      120,
    );
  });
});

describe("A-P4-FAIR 批准边界补充", () => {
  it("预算守卫拒绝时游标、outbox 与 Delivery 引用全部不变", async () => {
    await user(1);
    await fact();
    const b = await batch();
    const p = await select(b.id);
    const planned = await planDispatchAttempt(env.DB, p, T);
    if (!planned) throw new Error("缺少合成计划");
    planned.plan.guard.sql += " AND 0 = 1";
    expect(await conditionalCommit(env.DB, planned.plan)).toEqual({ outcome: "condition_missed" });
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    expect(await rows("SELECT id FROM deliveries WHERE mail_outbox_ref IS NOT NULL")).toHaveLength(
      0,
    );
    expect(
      (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors"))[0]
        ?.last_order,
    ).toBe(-1);
  });
  it.each(["interest", "consent", "schedule", "expiry"])(
    "批准计划产生后 %s 变化，提交守卫拒绝",
    async (change) => {
      const uid = await user(1);
      const f = await fact();
      const b = await batch();
      const p = await select(b.id);
      const planned = await planDispatchAttempt(env.DB, p, T);
      if (!planned) throw new Error("缺少合成计划");
      if (change === "interest")
        await run("DELETE FROM subscription_interests WHERE user_id = ?", uid);
      if (change === "consent")
        await run(
          "UPDATE email_channels SET enabled = 0,routine_enabled = 0 WHERE user_id = ?",
          uid,
        );
      if (change === "schedule")
        await run("UPDATE events SET schedule_revision = 2 WHERE id = ?", f.eid);
      if (change === "expiry") await run("UPDATE deliveries SET expires_at = ?", T);
      expect(await conditionalCommit(env.DB, planned.plan)).toEqual({
        outcome: "condition_missed",
      });
      expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    },
  );
  it("过期项不在新批次集合中仍留下 expired 原因", async () => {
    await user(1);
    const f = await fact();
    await batch();
    const later = await batch(f.expiry);
    expect(later.occurrenceIds).toHaveLength(0);
    expect(await expireDispatchCandidates(env.DB, f.expiry)).toBe(1);
    expect(
      (
        await rows<{ status: string; skip_reason: string }>(
          "SELECT status,skip_reason FROM deliveries",
        )
      )[0],
    ).toEqual({ status: "expired", skip_reason: "notification_expired" });
    expect(await selectDispatchCandidate(env.DB, later.id, f.expiry)).toEqual({ outcome: "empty" });
  });
  it("游标按池与优先级共同定位，不受另一个池的同数字游标影响", async () => {
    await user(1);
    await user(2);
    await fact();
    const b = await batch();
    await run(
      "INSERT INTO dispatch_cursors (pool,priority,last_order,completed_lap,updated_at) VALUES ('urgent_business',4,1,0,?)",
      T,
    );
    expect((await select(b.id)).order).toBe(1);
  });
});

it("A-P4-FAIR 批次元数据按注册表期限回收，未完成发送保留且公平游标不被重置", async () => {
  await user(1);
  await fact();
  const b = await batch();
  const p = await select(b.id);
  const outbox = await approve(p);
  const late = T + MAIL_METADATA_TTL * 1000;
  expect(await pruneExpiredDispatchBatch(env.DB, b.id, T)).toBe(false);
  expect(await pruneExpiredDispatchBatch(env.DB, b.id, late)).toBe(false);
  await run("UPDATE deliveries SET status = 'accepted' WHERE mail_outbox_ref = ?", outbox);
  expect(await pruneExpiredDispatchBatch(env.DB, b.id, late)).toBe(true);
  expect(
    (await rows<{ last_order: number }>("SELECT last_order FROM dispatch_cursors"))[0]?.last_order,
  ).toBe(1);
  expect(await rows("SELECT id FROM jobs WHERE kind = 'occurrence_email_expansion'")).toHaveLength(
    1,
  );
});
