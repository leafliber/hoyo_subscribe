// A-P4-OCCUR · 合成事实与账户；真实本地 D1 事务；不连接邮件服务。
import { env } from "cloudflare:test";
import {
  LATE_POST_START_WINDOW,
  MAIL_SEAT_LEASE,
  NOTIFICATION_PUBLICATION_TOPIC,
  REMINDER_GRACE,
  SUBSCRIPTION_SCHEMA_VERSION,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { runOccurrencePass } from "../../executors/delivery/occurrences";
import { splitSqlStatements } from "../../storage/split-sql";
import { expandOccurrencePage, startDueOccurrenceExpansion } from "./expand";
import { generatePublicationOccurrences } from "./generate";
import { reviewDeliveryBeforeSend } from "./review";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}
const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T0 = 1_800_000_000_000;
let serial = 0;
function id(prefix: string): string {
  return `p401_${prefix}_${++serial}`;
}
async function run(sql: string, ...params: unknown[]): Promise<void> {
  await env.DB.prepare(sql)
    .bind(...params)
    .run();
}
async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .all<T>()
    ).results ?? []
  );
}

interface Fact {
  eventId: string;
  nodeId: string;
  signalId: string;
}
async function fact(input: {
  nodeAt: number;
  nodeType?: string;
  changeKind?: string;
  status?: string;
  backfill?: boolean;
  changed?: boolean;
  eventRevision?: number;
  scheduleRevision?: number;
  additionalEndAt?: number;
}): Promise<Fact> {
  const eventId = id("event");
  const nodeId = id("node");
  const signalId = id("signal");
  const revision = input.eventRevision ?? 1;
  const schedule = input.scheduleRevision ?? 1;
  await run(
    `INSERT INTO events (id,game,region,event_type,status,title,event_revision,schedule_revision,created_at,updated_at)
    VALUES (?,'genshin','CN','limited_event',?,'合成活动',?,?,?,?)`,
    eventId,
    input.status ?? "scheduled",
    revision,
    schedule,
    T0,
    T0,
  );
  await run(
    `INSERT INTO milestones (id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
    VALUES (?,?,?,?,'节点',?,'Asia/Shanghai','合成时刻','official_explicit','datetime',?,?)`,
    nodeId,
    eventId,
    "main",
    input.nodeType ?? "start",
    input.nodeAt,
    T0,
    T0,
  );
  if (input.additionalEndAt !== undefined)
    await run(
      `INSERT INTO milestones (id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
      VALUES (?,?,?,'end','结束',?,'Asia/Shanghai','合成结束','official_explicit','datetime',?,?)`,
      id("end"),
      eventId,
      "end",
      input.additionalEndAt,
      T0,
      T0,
    );
  const payload = {
    event_id: eventId,
    event_revision: revision,
    schedule_revision: schedule,
    change_kind: input.changeKind ?? "created",
    changed_node_ids: input.changed === false ? [] : [nodeId],
    newly_exact_node_ids: [nodeId],
    backfill: input.backfill ?? false,
  };
  await run(
    `INSERT INTO outbox (id,topic,dedupe_key,payload_json,dispatch_state,created_at)
    VALUES (?,?,?,?, 'pending',?)`,
    signalId,
    NOTIFICATION_PUBLICATION_TOPIC,
    id("dedupe"),
    JSON.stringify(payload),
    T0,
  );
  return { eventId, nodeId, signalId };
}

async function occurrenceKinds(
  eventId: string,
): Promise<{ kind: string; due_at: number; expires_at: number; backfill: number }[]> {
  return rows(
    "SELECT kind,due_at,expires_at,backfill FROM occurrences WHERE event_id = ? ORDER BY kind",
    eventId,
  );
}

async function audience(order: number, enabledAt: number, initialized = true): Promise<string> {
  const userId = id("user");
  const binding = id("binding");
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,?,'active',?,?,?,1,?,?)`,
    userId,
    order,
    id("emailkey"),
    binding,
    new Uint8Array([1]),
    T0,
    T0,
  );
  const scope = JSON.stringify({ games: ["genshin"], regions: ["CN"] });
  const calendar = JSON.stringify({
    event_types: ["limited_event"],
    node_types: [],
    alarms_enabled: false,
  });
  const notifications = JSON.stringify({
    rule_ids: ["limited_start_1h"],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  });
  await run(
    `INSERT INTO user_subscriptions (user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    userId,
    initialized ? "initialized" : "uninitialized",
    SUBSCRIPTION_SCHEMA_VERSION,
    initialized ? 1 : 0,
    initialized ? scope : null,
    initialized ? calendar : null,
    initialized ? notifications : null,
    T0,
    T0,
  );
  await run(
    `INSERT INTO email_channels (user_id,enabled,routine_enabled,consent_version,address_version,lease_expires_at,created_at,updated_at)
    VALUES (?,1,1,1,1,?,?,?)`,
    userId,
    T0 + MAIL_SEAT_LEASE * 1000,
    T0,
    T0,
  );
  for (const layer of ["seat", "routine"])
    await run(
      `INSERT INTO consent_events (id,user_id,email_binding_id,layer,action,consent_version,created_at)
      VALUES (?,?,?,?,'enable',1,?)`,
      id("consent"),
      userId,
      binding,
      layer,
      enabledAt,
    );
  if (initialized) {
    for (const [kind, interestId] of [
      ["rule", "limited_start_1h"],
      ["change_switch", "late_discovery"],
      ["change_switch", "important_change"],
    ])
      await run(
        `INSERT INTO subscription_interests (id,user_id,game,region,interest_kind,interest_id,enabled_at)
        VALUES (?,?,'genshin','CN',?,?,?)`,
        id("interest"),
        userId,
        kind,
        interestId,
        enabledAt,
      );
  }
  return userId;
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
});

describe("A-P4-OCCUR 发布、晚发现与生命周期", () => {
  it("四种晚发现分支：未来已错过、刚过开始、截止已过、正常宽限内", async () => {
    const future = await fact({ nodeAt: T0 + 30 * 60_000 });
    const pastStart = await fact({
      nodeAt: T0 - Math.min((LATE_POST_START_WINDOW * 1000) / 2, 30 * 60_000),
    });
    const pastEnd = await fact({ nodeAt: T0 - 30 * 60_000, nodeType: "end" });
    const normal = await fact({ nodeAt: T0 + 60 * 60_000 - 60_000 });
    for (const item of [future, pastStart, pastEnd, normal])
      expect(await generatePublicationOccurrences(env.DB, item.signalId, T0)).toBe("generated");
    expect((await occurrenceKinds(future.eventId)).map((row) => row.kind)).toContain(
      "late_discovery:limited_start_1h",
    );
    expect((await occurrenceKinds(pastStart.eventId)).map((row) => row.kind)).toContain(
      "late_discovery:limited_start_1h",
    );
    expect((await occurrenceKinds(pastEnd.eventId)).map((row) => row.kind)).not.toContain(
      "late_discovery:limited_end_1d",
    );
    const normalRows = await occurrenceKinds(normal.eventId);
    expect(normalRows.map((row) => row.kind)).toContain("limited_start_1h");
    expect(normalRows.map((row) => row.kind)).not.toContain("late_discovery:limited_start_1h");
    expect(normalRows.find((row) => row.kind === "limited_start_1h")?.expires_at).toBe(
      T0 - 60_000 + REMINDER_GRACE * 1000,
    );
  });

  it("确认已结束不补报；历史回填标记并禁止公布群发；纯标题修改不重建提前提醒", async () => {
    const ended = await fact({ nodeAt: T0 - 30 * 60_000, additionalEndAt: T0 - 10 * 60_000 });
    const backfill = await fact({ nodeAt: T0 + 2 * 60 * 60_000, backfill: true });
    const title = await fact({
      nodeAt: T0 + 2 * 60 * 60_000,
      changeKind: "content_updated",
      changed: false,
      eventRevision: 2,
    });
    for (const item of [ended, backfill, title])
      await generatePublicationOccurrences(env.DB, item.signalId, T0);
    expect(
      (await occurrenceKinds(ended.eventId)).some((row) => row.kind.startsWith("late_discovery:")),
    ).toBe(false);
    const backfillRows = await occurrenceKinds(backfill.eventId);
    expect(backfillRows).toEqual([
      expect.objectContaining({ kind: "limited_start_1h", backfill: 1 }),
    ]);
    expect(await occurrenceKinds(title.eventId)).toEqual([]);
  });

  it("发布后先有标题修订，仍消费同一计划版本的较早通知信号", async () => {
    const item = await fact({ nodeAt: T0 + 2 * 60 * 60_000 });
    await run("UPDATE events SET event_revision = 2,title = '修正标题' WHERE id = ?", item.eventId);
    expect(await generatePublicationOccurrences(env.DB, item.signalId, T0 + 1)).toBe("generated");
    expect((await occurrenceKinds(item.eventId)).map((row) => row.kind)).toContain(
      "limited_start_1h",
    );
  });

  it("改期使旧 occurrence 与尚未发送 Delivery 失效；相同信号幂等", async () => {
    const item = await fact({ nodeAt: T0 + 2 * 60 * 60_000 });
    await generatePublicationOccurrences(env.DB, item.signalId, T0);
    const old = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind = 'limited_start_1h'",
        item.eventId,
      )
    )[0];
    expect(old).toBeDefined();
    const user = await audience(10000 + serial, T0 - 60_000);
    await run(
      `INSERT INTO deliveries (id,occurrence_id,user_id,channel,target_ref,milestone_id,schedule_revision,rule_id,kind,priority,dedupe_family,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,'email',?,?,1,'limited_start_1h','rule',4,?,'pending',?,?,?)`,
      id("delivery"),
      old?.id,
      user,
      user,
      item.nodeId,
      id("family"),
      T0 + 60_000,
      T0,
      T0,
    );
    await run(
      "UPDATE events SET event_revision = 2,schedule_revision = 2 WHERE id = ?",
      item.eventId,
    );
    await run(
      "UPDATE milestones SET time_exact_ms = ? WHERE id = ?",
      T0 + 3 * 60 * 60_000,
      item.nodeId,
    );
    const signalId = id("signal");
    await run(
      `INSERT INTO outbox (id,topic,dedupe_key,payload_json,dispatch_state,created_at)
      VALUES (?,?,?,?, 'pending',?)`,
      signalId,
      NOTIFICATION_PUBLICATION_TOPIC,
      id("dedupe"),
      JSON.stringify({
        event_id: item.eventId,
        event_revision: 2,
        schedule_revision: 2,
        change_kind: "schedule_updated",
        changed_node_ids: [item.nodeId],
        newly_exact_node_ids: [],
      }),
      T0 + 1,
    );
    expect(await generatePublicationOccurrences(env.DB, signalId, T0 + 1)).toBe("generated");
    expect(await generatePublicationOccurrences(env.DB, signalId, T0 + 2)).toBe("unchanged");
    expect(
      (
        await rows<{ invalidated_at: number }>(
          "SELECT invalidated_at FROM occurrences WHERE id = ?",
          old?.id,
        )
      )[0]?.invalidated_at,
    ).toBe(T0 + 1);
    expect(
      (
        await rows<{ status: string }>(
          "SELECT status FROM deliveries WHERE occurrence_id = ?",
          old?.id,
        )
      )[0]?.status,
    ).toBe("superseded");
  });
});

describe("A-P4-OCCUR keyset、兴趣与发送前复核", () => {
  it("冻结 order 上界，按页提交候选和游标；新增兴趣和晚同意不追溯", async () => {
    await run("UPDATE users SET status = 'deleting' WHERE id LIKE 'p401_%'");
    const item = await fact({ nodeAt: T0 + 60 * 60_000 });
    await generatePublicationOccurrences(env.DB, item.signalId, T0);
    const occurrence = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind = 'limited_start_1h'",
        item.eventId,
      )
    )[0];
    expect(occurrence).toBeDefined();
    const base = 20000 + serial * 10;
    const first = await audience(base, T0 - 60_000);
    const lateInterest = await audience(base + 1, T0 + 1);
    const third = await audience(base + 2, T0 - 60_000);
    expect(await startDueOccurrenceExpansion(env.DB, T0, 100)).toBeGreaterThanOrEqual(1);
    const newcomer = await audience(base + 3, T0 - 60_000);
    let cursor = (
      await rows<{ payload_json: string }>(
        "SELECT payload_json FROM jobs WHERE id = ?",
        `occurrence:${occurrence?.id}:email`,
      )
    )[0];
    while (JSON.parse(cursor?.payload_json ?? "null").cursor < base) {
      expect(await expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 1)).toBe("advanced");
      cursor = (
        await rows<{ payload_json: string }>(
          "SELECT payload_json FROM jobs WHERE id = ?",
          `occurrence:${occurrence?.id}:email`,
        )
      )[0];
    }
    expect(JSON.parse(cursor?.payload_json ?? "null").cursor).toBe(base);
    expect(await expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 1)).toBe("advanced");
    expect(await expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 1)).toBe("done");
    expect(
      (
        await rows<{ user_id: string }>(
          "SELECT user_id FROM deliveries WHERE occurrence_id = ? ORDER BY user_id",
          occurrence?.id,
        )
      )
        .map((row) => row.user_id)
        .sort(),
    ).toEqual([first, third].sort());
    expect(
      await rows<{ user_id: string }>(
        "SELECT user_id FROM deliveries WHERE user_id IN (?,?)",
        lateInterest,
        newcomer,
      ),
    ).toEqual([]);
    const delivery = (
      await rows<{ id: string }>(
        "SELECT id FROM deliveries WHERE occurrence_id = ? AND user_id = ?",
        occurrence?.id,
        first,
      )
    )[0];
    expect(await reviewDeliveryBeforeSend(env.DB, delivery?.id ?? "", T0 + 1)).toBe("eligible");
    await run(
      "DELETE FROM subscription_interests WHERE user_id = ? AND interest_kind = 'rule'",
      first,
    );
    expect(await reviewDeliveryBeforeSend(env.DB, delivery?.id ?? "", T0 + 2)).toBe("skipped");
    const thirdDelivery = (
      await rows<{ id: string }>(
        "SELECT id FROM deliveries WHERE occurrence_id = ? AND user_id = ?",
        occurrence?.id,
        third,
      )
    )[0];
    expect(await reviewDeliveryBeforeSend(env.DB, thirdDelivery?.id ?? "", T0 + 2)).toBe(
      "eligible",
    );
    await run("UPDATE users SET email_version = 2 WHERE id = ?", third);
    expect(await reviewDeliveryBeforeSend(env.DB, thirdDelivery?.id ?? "", T0 + 3)).toBe("skipped");
    expect(
      await reviewDeliveryBeforeSend(env.DB, delivery?.id ?? "", T0 + REMINDER_GRACE * 1000),
    ).toBe("expired");
  });

  it("new_event 关闭仍允许独立 late_discovery；uninitialized 不匹配", async () => {
    await run("UPDATE users SET status = 'deleting' WHERE id LIKE 'p401_%'");
    const item = await fact({ nodeAt: T0 + 30 * 60_000 });
    await generatePublicationOccurrences(env.DB, item.signalId, T0);
    const eligible = await audience(30000 + serial * 10, T0 - 60_000);
    const empty = await audience(30001 + serial * 10, T0 - 60_000, false);
    await startDueOccurrenceExpansion(env.DB, T0, 100);
    const late = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind LIKE 'late_discovery:%'",
        item.eventId,
      )
    )[0];
    const announcement = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind = 'new_event'",
        item.eventId,
      )
    )[0];
    expect(late).toBeDefined();
    expect(announcement).toBeDefined();
    expect(await expandOccurrencePage(env.DB, late?.id ?? "", T0, 100)).toBe("done");
    expect(await expandOccurrencePage(env.DB, announcement?.id ?? "", T0, 100)).toBe("done");
    expect(
      (
        await rows<{ user_id: string }>(
          "SELECT user_id FROM deliveries WHERE occurrence_id = ?",
          late?.id,
        )
      ).map((row) => row.user_id),
    ).toContain(eligible);
    expect(
      await rows<{ user_id: string }>(
        "SELECT user_id FROM deliveries WHERE occurrence_id IN (?,?) AND user_id = ?",
        late?.id,
        announcement?.id,
        empty,
      ),
    ).toEqual([]);
    expect(
      await rows<{ user_id: string }>(
        "SELECT user_id FROM deliveries WHERE occurrence_id = ? AND user_id = ?",
        announcement?.id,
        eligible,
      ),
    ).toEqual([]);
  });

  it("展开页写入失败时游标不推进；执行入口按 pending outbox 领取", async () => {
    await run("UPDATE users SET status = 'deleting' WHERE id LIKE 'p401_%'");
    const item = await fact({ nodeAt: T0 + 60 * 60_000 });
    const user = await audience(40000 + serial * 10, T0 - 60_000);
    const pass = await runOccurrencePass(env.DB, T0, {
      signalLimit: 100,
      occurrenceLimit: 100,
      pageLimit: 0,
      pageSize: 100,
    });
    expect(pass.signals).toBeGreaterThanOrEqual(1);
    const occurrence = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind = 'limited_start_1h'",
        item.eventId,
      )
    )[0];
    expect(occurrence).toBeDefined();
    await env.DB.exec(
      "CREATE TRIGGER fail_p401_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'synthetic delivery failure'); END;",
    );
    try {
      await expect(expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 100)).rejects.toThrow(
        /synthetic delivery failure/,
      );
    } finally {
      await env.DB.exec("DROP TRIGGER fail_p401_delivery;");
    }
    const jobId = `occurrence:${occurrence?.id}:email`;
    const row = (
      await rows<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE id = ?", jobId)
    )[0];
    expect(JSON.parse(row?.payload_json ?? "null").cursor).toBe(-1);
    expect(
      (await rows("SELECT id FROM deliveries WHERE occurrence_id = ?", occurrence?.id)).length,
    ).toBe(0);
    expect(await expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 100)).toBe("done");
    expect(
      (
        await rows<{ user_id: string }>(
          "SELECT user_id FROM deliveries WHERE occurrence_id = ?",
          occurrence?.id,
        )
      ).map((row) => row.user_id),
    ).toContain(user);
  });

  it("重要更正的范围可由日历事件类型提供，规则为空且节点隐藏仍能匹配", async () => {
    await run("UPDATE users SET status = 'deleting' WHERE id LIKE 'p401_%'");
    const item = await fact({
      nodeAt: T0 + 2 * 60 * 60_000,
      changeKind: "schedule_updated",
      eventRevision: 2,
    });
    await generatePublicationOccurrences(env.DB, item.signalId, T0);
    const user = await audience(50000 + serial * 10, T0 - 60_000);
    await run(
      "DELETE FROM subscription_interests WHERE user_id = ? AND interest_kind = 'rule'",
      user,
    );
    await run(
      "UPDATE user_subscriptions SET notifications_json = json_set(notifications_json, '$.rule_ids', json('[]')) WHERE user_id = ?",
      user,
    );
    await startDueOccurrenceExpansion(env.DB, T0, 100);
    const occurrence = (
      await rows<{ id: string }>(
        "SELECT id FROM occurrences WHERE event_id = ? AND kind = 'important_change'",
        item.eventId,
      )
    )[0];
    expect(occurrence).toBeDefined();
    expect(await expandOccurrencePage(env.DB, occurrence?.id ?? "", T0, 100)).toBe("done");
    expect(
      (
        await rows<{ user_id: string }>(
          "SELECT user_id FROM deliveries WHERE occurrence_id = ?",
          occurrence?.id,
        )
      ).map((row) => row.user_id),
    ).toContain(user);
  });
});
