// A-P3-PATCH：本地 D1 真表，合成公共事实；不使用真实来源、账户或邮件。
import { env } from "cloudflare:test";
import {
  CAL_PATCH_GLOBAL_MAX,
  CAL_PATCH_MIN_DAYS,
  CAL_PATCH_TAIL_DAYS,
  effectivePublicSnapshotNodes,
  NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
  PUBLIC_CACHE_FRESH,
  PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
  type PublicCalendarProjection,
  SNAPSHOT_REBUILD_TOPIC,
  TimeValueSchema,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { splitSqlStatements } from "../../storage/split-sql";
import {
  buildPublicSnapshot,
  readCurrentPublicSnapshot,
  readNoncriticalPublicationPause,
  reclaimSupersededPublicSnapshotPage,
  writeNoncriticalPublicationPause,
} from "./snapshot";

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
const day = 86_400_000;
const T0 = 1_800_000_000_000;
const eventId = "snapshot-event";
const nodeId = "snapshot-node";
const time = (ms: number) =>
  TimeValueSchema.parse({
    precision: "datetime" as const,
    utc_ms: ms,
    source_timezone: "UTC",
    raw_expression: "官方时间",
    time_basis: "official_explicit" as const,
  });
function projection(
  ms: number,
  status: "scheduled" | "postponed" = "scheduled",
): PublicCalendarProjection {
  return {
    event_id: eventId,
    milestone_id: nodeId,
    event: {
      event_type: "limited_event",
      status,
      title: "合成活动",
      summary: null,
      official_url: "https://example.invalid/event",
      human_locked: false,
    },
    milestone: {
      milestone_key: "start",
      node_type: "start",
      title: "开始",
      time: time(ms),
      human_locked: false,
    },
  };
}
async function one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}
async function queue(now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .bind(PUBLIC_SNAPSHOT_PENDING_STATE_KEY, JSON.stringify({ pending: true }), now)
    .run();
  await env.DB.prepare(`INSERT INTO outbox (id, topic, dedupe_key, payload_json, dispatch_state, created_at)
    VALUES (?, ?, ?, '{}', 'pending', ?)`)
    .bind(crypto.randomUUID(), SNAPSHOT_REBUILD_TOPIC, `test:${now}`, now)
    .run();
}
async function updateProjection(
  value: PublicCalendarProjection,
  revision: number,
  now: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE calendar_projections SET projection_json = ?, public_ical_revision = ?,
    updated_at = ? WHERE milestone_id = ?`)
    .bind(JSON.stringify(value), revision, now, nodeId)
    .run();
  await env.DB.prepare(
    "UPDATE milestones SET public_ical_revision = ?, updated_at = ? WHERE id = ?",
  )
    .bind(revision, now, nodeId)
    .run();
  await queue(now);
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  await env.DB.prepare(`INSERT INTO events (id, game, region, event_type, status, title,
    event_revision, schedule_revision, human_locked, created_at, updated_at)
    VALUES (?, 'genshin', 'CN', 'limited_event', 'scheduled', '合成活动', 1, 1, 0, ?, ?)`)
    .bind(eventId, T0, T0)
    .run();
  await env.DB.prepare(`INSERT INTO milestones (id, event_id, milestone_key, node_type, title,
    time_exact_ms, source_timezone, raw_expression, time_basis, time_precision,
    public_ical_revision, human_locked, created_at, updated_at)
    VALUES (?, ?, 'start', 'start', '开始', ?, 'UTC', '官方时间', 'official_explicit', 'datetime', 1, 0, ?, ?)`)
    .bind(nodeId, eventId, T0 + 170 * day, T0, T0)
    .run();
  await env.DB.prepare(`INSERT INTO calendar_projections
    (milestone_id, event_id, public_ical_revision, projection_json, updated_at)
    VALUES (?, ?, 1, ?, ?)`)
    .bind(nodeId, eventId, JSON.stringify(projection(T0 + 170 * day)), T0)
    .run();
}, 180_000);

describe("A-P3-PATCH 公共快照与共享更正层", () => {
  it("完整代次先构建后切换；重复调用不取新号，公共模板不含个人 UID", async () => {
    expect(await buildPublicSnapshot(env.DB, T0)).toEqual({ outcome: "unchanged" });
    await queue(T0 + 1);
    const built = await buildPublicSnapshot(env.DB, T0 + 2);
    expect(built).toMatchObject({ outcome: "built", generation: 1, patch_count: 0 });
    const current = await readCurrentPublicSnapshot(env.DB, T0 + 2);
    expect(current?.nodes).toHaveLength(1);
    expect(JSON.stringify(current?.nodes)).not.toContain("UID");
    expect(await buildPublicSnapshot(env.DB, T0 + 3)).toEqual({ outcome: "unchanged" });
    expect(
      await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM public_snapshots WHERE state = 'current'",
      ),
    ).toEqual({ n: 1 });
    expect(
      await one<{ dispatch_state: string }>(
        "SELECT dispatch_state FROM outbox WHERE dedupe_key = ?",
        `test:${T0 + 1}`,
      ),
    ).toEqual({ dispatch_state: "dispatched" });
    expect(
      (await readCurrentPublicSnapshot(env.DB, T0 + 2 + PUBLIC_CACHE_FRESH * 1000 + 1))?.fresh,
    ).toBe(false);
  });

  it("连续改期只保留当前 UID 投影并累积旧时间保留水位", async () => {
    await updateProjection(projection(T0 + 200 * day), 2, T0 + day);
    expect((await buildPublicSnapshot(env.DB, T0 + day + 1)).outcome).toBe("built");
    await updateProjection(projection(T0 + 150 * day), 3, T0 + 2 * day);
    expect((await buildPublicSnapshot(env.DB, T0 + 2 * day + 1)).outcome).toBe("built");
    const snapshot = await readCurrentPublicSnapshot(env.DB, T0 + 2 * day + 1);
    expect(snapshot?.nodes).toHaveLength(1);
    expect(snapshot?.nodes[0]?.patch?.old_time).toEqual(time(T0 + 200 * day));
    expect(snapshot?.nodes[0]?.patch?.retain_until).toBe(
      Math.max(T0 + 2 * day + CAL_PATCH_MIN_DAYS * day, T0 + (200 + CAL_PATCH_TAIL_DAYS) * day),
    );
    expect(
      await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calendar_patches WHERE superseded_at IS NULL",
      ),
    ).toEqual({ n: 1 });
    expect(
      await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM public_snapshots WHERE state = 'current'",
      ),
    ).toEqual({ n: 1 });
  });

  it("更正与基础节点同受当前筛选；隐藏类型不露出取消", async () => {
    const snapshot = await readCurrentPublicSnapshot(env.DB, T0 + 2 * day + 1);
    const config = {
      scope: { games: ["genshin" as const], regions: ["CN" as const] },
      calendar: {
        event_types: ["limited_event" as const],
        node_types: ["start" as const],
        alarms_enabled: false,
      },
      notifications: { rule_ids: [] },
    };
    expect(effectivePublicSnapshotNodes(config, snapshot?.nodes ?? [])).toHaveLength(1);
    expect(
      effectivePublicSnapshotNodes(
        { ...config, calendar: { ...config.calendar, node_types: [] } },
        snapshot?.nodes ?? [],
      ),
    ).toHaveLength(0);
  });

  it("官方取消和延期未知分别保留最近已发布时间，隐藏节点看不到 CANCELLED", async () => {
    await updateProjection(projection(T0 + 150 * day, "postponed"), 4, T0 + 3 * day);
    await env.DB.prepare("UPDATE events SET status = 'postponed' WHERE id = ?").bind(eventId).run();
    await env.DB.prepare(
      `UPDATE calendar_projections SET projection_json = ? WHERE milestone_id = ?`,
    )
      .bind(
        JSON.stringify({
          ...projection(T0 + 150 * day, "postponed"),
          milestone: {
            ...projection(T0 + 150 * day).milestone,
            time: {
              precision: "unknown",
              source_timezone: "UTC",
              raw_expression: "延期",
              time_basis: "unresolved",
            },
          },
        }),
        nodeId,
      )
      .run();
    expect((await buildPublicSnapshot(env.DB, T0 + 3 * day + 1)).outcome).toBe("built");
    const postponed = await readCurrentPublicSnapshot(env.DB, T0 + 3 * day + 1);
    expect(postponed?.nodes[0]?.patch?.kind).toBe("postponed_unknown");
    expect(postponed?.nodes[0]?.patch?.display_time).toEqual(time(T0 + 150 * day));

    await updateProjection(
      {
        ...projection(T0 + 150 * day),
        event: { ...projection(T0 + 150 * day).event, status: "cancelled" },
      },
      5,
      T0 + 4 * day,
    );
    await env.DB.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").bind(eventId).run();
    expect((await buildPublicSnapshot(env.DB, T0 + 4 * day + 1)).outcome).toBe("built");
    const cancelled = await readCurrentPublicSnapshot(env.DB, T0 + 4 * day + 1);
    expect(cancelled?.nodes[0]?.patch?.kind).toBe("cancelled");
    const config = {
      scope: { games: ["genshin" as const], regions: ["CN" as const] },
      calendar: {
        event_types: ["limited_event" as const],
        node_types: [] as "start"[],
        alarms_enabled: false,
      },
      notifications: { rule_ids: [] },
    };
    expect(effectivePublicSnapshotNodes(config, cancelled?.nodes ?? [])).toHaveLength(0);
  });

  it("节点删除以共享墓碑补偿，到期后自然缺席", async () => {
    await env.DB.prepare("DELETE FROM calendar_projections WHERE milestone_id = ?")
      .bind(nodeId)
      .run();
    await queue(T0 + 5 * day);
    expect((await buildPublicSnapshot(env.DB, T0 + 5 * day + 1)).outcome).toBe("built");
    const current = await readCurrentPublicSnapshot(env.DB, T0 + 5 * day + 1);
    expect(current?.nodes).toHaveLength(1);
    expect(current?.nodes[0]?.tombstone).toBe(true);
    expect(current?.nodes[0]?.patch?.kind).toBe("deleted");
    expect(
      (await readCurrentPublicSnapshot(env.DB, (current?.nodes[0]?.patch?.retain_until ?? 0) + 1))
        ?.nodes,
    ).toHaveLength(0);
  });

  it("节点恢复沿用身份并替换删除补偿", async () => {
    await env.DB.prepare(`INSERT INTO calendar_projections
      (milestone_id, event_id, public_ical_revision, projection_json, updated_at)
      VALUES (?, ?, 6, ?, ?)`)
      .bind(nodeId, eventId, JSON.stringify(projection(T0 + 180 * day)), T0 + 6 * day)
      .run();
    await env.DB.prepare("UPDATE milestones SET public_ical_revision = 6 WHERE id = ?")
      .bind(nodeId)
      .run();
    await env.DB.prepare("UPDATE events SET status = 'scheduled' WHERE id = ?").bind(eventId).run();
    await queue(T0 + 6 * day);
    expect((await buildPublicSnapshot(env.DB, T0 + 6 * day + 1)).outcome).toBe("built");
    const current = await readCurrentPublicSnapshot(env.DB, T0 + 6 * day + 1);
    expect(current?.nodes).toHaveLength(1);
    expect(current?.nodes[0]?.projection.milestone_id).toBe(nodeId);
    expect(current?.nodes[0]?.patch?.kind).toBe("restored");
    expect(current?.nodes[0]?.tombstone).toBe(false);
  });

  it("暂停标记独立可读写，不改变快照与用户配置", async () => {
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(false);
    await writeNoncriticalPublicationPause(env.DB, true, "容量告警", T0 + 3 * day);
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
    await writeNoncriticalPublicationPause(env.DB, false, "容量恢复", T0 + 3 * day + 1);
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(false);
  });

  it("公共更正只剩一个记录名额时提前暂停非关键发布", async () => {
    const row = await one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM calendar_patches WHERE retain_until > ?",
      T0 + 7 * day,
    );
    const missing = CAL_PATCH_GLOBAL_MAX - 1 - (row?.n ?? 0);
    expect(missing).toBeGreaterThan(0);
    await env.DB.prepare(`WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
    ) INSERT INTO calendar_patches
      (id, milestone_id, patch_kind, fact_reason, effective_at, retain_until,
       superseded_at, created_at, updated_at)
      SELECT 'synthetic-history-' || n, ?, 'rescheduled', '合成历史', ?, ?, ?, ?, ? FROM seq`)
      .bind(missing, nodeId, T0, T0 + (CAL_PATCH_MIN_DAYS + CAL_PATCH_TAIL_DAYS) * day, T0, T0, T0)
      .run();
    await queue(T0 + 7 * day);
    const result = await buildPublicSnapshot(env.DB, T0 + 7 * day + 1);
    expect(result).toMatchObject({ outcome: "built", capacity_alert: true });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
  }, 30_000);

  it("容量仍在告警线时构建与 unchanged 路径均保持暂停", async () => {
    const now = T0 + 7 * day + 2;
    expect(
      await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calendar_patches WHERE retain_until > ?",
        now,
      ),
    ).toEqual({ n: CAL_PATCH_GLOBAL_MAX - 1 });
    await queue(now);
    expect(await buildPublicSnapshot(env.DB, now + 1)).toMatchObject({
      outcome: "built",
      capacity_alert: true,
    });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
    expect(await buildPublicSnapshot(env.DB, now + 2)).toEqual({ outcome: "unchanged" });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
  });

  it("他源已暂停时触发容量告警仍保留他源原因", async () => {
    const now = T0 + 7 * day + 5;
    await writeNoncriticalPublicationPause(env.DB, true, "other_source", now);
    try {
      await queue(now);
      expect(await buildPublicSnapshot(env.DB, now + 1)).toMatchObject({
        outcome: "built",
        capacity_alert: true,
      });
      expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
      expect(
        await one<{ reason: string }>(
          "SELECT json_extract(value_json, '$.reason') AS reason FROM system_state WHERE key = ?",
          NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
        ),
      ).toEqual({ reason: "other_source" });
    } finally {
      // 恢复后续容量回落用例需要的本卡暂停原因。
      await writeNoncriticalPublicationPause(env.DB, true, "calendar_patch_capacity", now + 2);
    }
  });

  it("容量回落后仅解除本卡暂停标记，保留其他来源的暂停", async () => {
    const recoveredAt = T0 + (CAL_PATCH_MIN_DAYS + CAL_PATCH_TAIL_DAYS + 1) * day;
    await queue(recoveredAt);
    expect(await buildPublicSnapshot(env.DB, recoveredAt + 1)).toMatchObject({
      outcome: "built",
      capacity_alert: false,
    });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(false);
    expect(
      await one<{ reason: string }>(
        "SELECT json_extract(value_json, '$.reason') AS reason FROM system_state WHERE key = ?",
        NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
      ),
    ).toEqual({ reason: "calendar_patch_capacity" });

    await writeNoncriticalPublicationPause(
      env.DB,
      true,
      "calendar_patch_capacity",
      recoveredAt + 2,
    );
    expect(await buildPublicSnapshot(env.DB, recoveredAt + 3)).toEqual({ outcome: "unchanged" });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(false);

    await writeNoncriticalPublicationPause(env.DB, true, "other_source", recoveredAt + 4);
    expect(await buildPublicSnapshot(env.DB, recoveredAt + 5)).toEqual({ outcome: "unchanged" });
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
    expect(
      await one<{ reason: string }>(
        "SELECT json_extract(value_json, '$.reason') AS reason FROM system_state WHERE key = ?",
        NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
      ),
    ).toEqual({ reason: "other_source" });
  });

  it("旧代次按页回收节点，清空后删代次，保留当前与上一代", async () => {
    const oldest = await one<{ id: string }>(
      "SELECT id FROM public_snapshots WHERE state = 'superseded' ORDER BY generation ASC LIMIT 1",
    );
    expect(oldest).not.toBeNull();
    const extraId = "reclaim-extra-node";
    await env.DB.prepare(`INSERT INTO milestones (id, event_id, milestone_key, node_type, title,
      time_exact_ms, source_timezone, raw_expression, time_basis, time_precision,
      public_ical_revision, human_locked, created_at, updated_at)
      VALUES (?, ?, 'reclaim-extra', 'start', '测试节点', ?, 'UTC', '官方时间',
        'official_explicit', 'datetime', 1, 0, ?, ?)`)
      .bind(extraId, eventId, T0 + 170 * day, T0, T0)
      .run();
    await env.DB.prepare(
      "INSERT INTO public_snapshot_nodes (snapshot_id, milestone_id, node_json) VALUES (?, ?, '{}')",
    )
      .bind(oldest?.id, extraId)
      .run();
    await expect(reclaimSupersededPublicSnapshotPage(env.DB, 0)).rejects.toThrow();
    const first = await reclaimSupersededPublicSnapshotPage(env.DB, 1);
    expect(first).toMatchObject({
      outcome: "progress",
      snapshot_id: oldest?.id,
      nodes_deleted: 1,
      snapshot_deleted: false,
    });
    expect(
      await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM public_snapshot_nodes WHERE snapshot_id = ?",
        oldest?.id,
      ),
    ).toEqual({ n: 1 });
    const second = await reclaimSupersededPublicSnapshotPage(env.DB, 1);
    expect(second).toMatchObject({
      outcome: "progress",
      snapshot_id: oldest?.id,
      nodes_deleted: 1,
      snapshot_deleted: true,
    });
    expect(await one("SELECT id FROM public_snapshots WHERE id = ?", oldest?.id)).toBeNull();

    for (;;) {
      const page = await reclaimSupersededPublicSnapshotPage(env.DB, 1);
      if (page.outcome === "done") break;
    }
    const retained = (
      await env.DB.prepare("SELECT id, state FROM public_snapshots ORDER BY generation DESC").all<{
        id: string;
        state: string;
      }>()
    ).results;
    expect(retained.map(({ state }) => state)).toEqual(["current", "superseded"]);
    for (const { id } of retained) {
      expect(
        await one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM public_snapshot_nodes WHERE snapshot_id = ?",
          id,
        ),
      ).toEqual({ n: 1 });
    }
    expect(await reclaimSupersededPublicSnapshotPage(env.DB, 1)).toEqual({
      outcome: "done",
      nodes_deleted: 0,
      snapshot_deleted: false,
    });
  });
});

// P3-06 获准跨卡负载回归：超过原实现单次 1,000 条语句的形状。
describe("A-P3-ICS 公共构建查询数上界", () => {
  it("1200 节点及一次全部改期仍以固定查询数切换完整代次", async () => {
    const size = 1200;
    const at = T0 + 400 * day;
    const nodes = Array.from({ length: size }, (_, i) => ({
      ...projection(at + day),
      milestone_id: `bulk-${i}`,
      milestone: { ...projection(at + day).milestone, milestone_key: `bulk-${i}` },
    }));
    await env.DB.prepare(`INSERT INTO milestones (id, event_id, milestone_key, node_type, title,
      time_exact_ms, source_timezone, raw_expression, time_basis, time_precision,
      public_ical_revision, human_locked, created_at, updated_at)
      SELECT json_extract(value, '$.milestone_id'), ?, json_extract(value, '$.milestone.milestone_key'),
      'start', '合成', ?, 'UTC', '明确', 'official_explicit', 'datetime', 1, 0, ?, ? FROM json_each(?)`)
      .bind(eventId, at + day, at, at, JSON.stringify(nodes))
      .run();
    await env.DB.prepare(`INSERT INTO calendar_projections
      SELECT json_extract(value, '$.milestone_id'), ?, 1, value, ? FROM json_each(?)`)
      .bind(eventId, at, JSON.stringify(nodes))
      .run();
    let queries = 0;
    const counted = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await queue(at);
    expect((await buildPublicSnapshot(counted, at)).outcome).toBe("built");
    expect(queries).toBeLessThanOrEqual(21);
    expect((await readCurrentPublicSnapshot(env.DB, at))?.nodes).toHaveLength(size + 1);
    await env.DB.prepare(`UPDATE calendar_projections SET
      projection_json = json_set(projection_json, '$.milestone.time.utc_ms', ?),
      public_ical_revision = public_ical_revision + 1, updated_at = ? WHERE milestone_id LIKE 'bulk-%'`)
      .bind(at + 2 * day, at + 1)
      .run();
    await queue(at + 1);
    queries = 0;
    expect((await buildPublicSnapshot(counted, at + 1)).outcome).toBe("built");
    expect(queries).toBeLessThanOrEqual(21);
    expect(
      (await readCurrentPublicSnapshot(env.DB, at + 1))?.nodes.filter(
        (n) => n.patch?.kind === "rescheduled",
      ),
    ).toHaveLength(size);
    console.log(JSON.stringify({ event: "p3_06_build_bound", nodes: size, queries }));
  }, 60_000);
  it("最终 CAS 未命中时所有效果零写入；数据库错误整批回滚", async () => {
    const at = T0 + 400 * day + 2;
    const previous = await readCurrentPublicSnapshot(env.DB, at);
    await queue(at);
    let raced = false;
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target
                .prepare("UPDATE system_state SET updated_at = updated_at + 1 WHERE key = ?")
                .bind(PUBLIC_SNAPSHOT_PENDING_STATE_KEY)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await buildPublicSnapshot(racing, at)).outcome).toBe("condition_missed");
    expect((await readCurrentPublicSnapshot(env.DB, at))?.generation).toBe(previous?.generation);
    expect(await one("SELECT id FROM public_snapshots WHERE state = 'building'")).toBeNull();
    await env.DB.prepare(`CREATE TRIGGER synthetic_snapshot_failure BEFORE UPDATE ON outbox
      WHEN NEW.dispatch_state = 'dispatched' BEGIN SELECT RAISE(ABORT, 'synthetic'); END`).run();
    try {
      await expect(buildPublicSnapshot(env.DB, at + 1)).rejects.toThrow();
      expect((await readCurrentPublicSnapshot(env.DB, at))?.generation).toBe(previous?.generation);
      expect(await one("SELECT id FROM public_snapshots WHERE state = 'building'")).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER synthetic_snapshot_failure").run();
    }
  }, 60_000);
});
