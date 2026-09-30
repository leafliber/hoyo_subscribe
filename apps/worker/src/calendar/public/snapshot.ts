// P3-06 获准跨卡改动：整代保留历史投影（保证未来自然进入及更正对比），集合 SQL 固定构建语句数。
// P3-11 获准跨卡改动：回收条件纳入 generation 小于 current 的残留 building。
// P3-05 · 可调用的公共完整代次构建入口；P3-11 负责调度，P3-06 负责个人 ICS。
// 主方案 §6.3、附录 A.3。只读 P3-04 投影，不修改其发布器。
import {
  CAL_PATCH_GLOBAL_MAX,
  decideCalendarPatch,
  EventStatusSchema,
  EventTypeSchema,
  NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
  NodeTypeSchema,
  type PatchDecision,
  PUBLIC_CACHE_FRESH,
  PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
  type PublicCalendarProjection,
  type PublicSnapshotNode,
  SNAPSHOT_REBUILD_TOPIC,
  TimeValueSchema,
} from "@hoyo/contracts";

const PATCH_CAPACITY_PAUSE_REASON = "calendar_patch_capacity";

interface ProjectionRow {
  milestone_id: string;
  event_id: string;
  projection_json: string;
  public_ical_revision: number;
  updated_at: number;
  game: PublicSnapshotNode["game"];
  region: PublicSnapshotNode["region"];
}
interface SnapshotRow {
  id: string;
  generation: number;
  published_at: number | null;
}
interface StoredNodeRow {
  milestone_id: string;
  node_json: string;
}
interface PatchRow {
  id: string;
  milestone_id: string;
  retain_until: number;
}
interface OutboxRow {
  id: string;
}
interface PendingRow {
  value_json: string;
  updated_at: number;
}

export interface PublicSnapshotResult {
  readonly outcome: "built" | "unchanged" | "condition_missed";
  readonly generation?: number;
  readonly patch_count?: number;
  readonly capacity_alert?: boolean;
}

function parseProjection(row: ProjectionRow): PublicCalendarProjection {
  const raw: unknown = JSON.parse(row.projection_json);
  if (typeof raw !== "object" || raw === null) throw new Error("公共投影结构无效");
  const value = raw as Record<string, unknown>;
  if (value.event_id !== row.event_id || value.milestone_id !== row.milestone_id)
    throw new Error("公共投影身份与行不一致");
  const event = value.event as Record<string, unknown> | null;
  const milestone = value.milestone as Record<string, unknown> | null;
  if (!event || !milestone) throw new Error("公共投影缺少事件或节点");
  return {
    event_id: row.event_id,
    milestone_id: row.milestone_id,
    event: {
      event_type: EventTypeSchema.parse(event.event_type),
      status: EventStatusSchema.parse(event.status),
      title: String(event.title),
      summary: event.summary === null ? null : String(event.summary),
      official_url: event.official_url === null ? null : String(event.official_url),
      human_locked: event.human_locked === true,
    },
    milestone: {
      milestone_key: String(milestone.milestone_key),
      node_type: NodeTypeSchema.parse(milestone.node_type),
      title: String(milestone.title),
      time: TimeValueSchema.parse(milestone.time),
      human_locked: milestone.human_locked === true,
    },
  };
}

function timeColumns(time: PatchDecision["old_time"]): [number | null, string | null] {
  if (time?.precision === "datetime") return [time.utc_ms, null];
  if (time?.precision === "date") return [null, time.date];
  return [null, null];
}

function nodeFromJson(value: string): PublicSnapshotNode {
  const node = JSON.parse(value) as PublicSnapshotNode;
  if (!node?.projection?.milestone) throw new Error("旧快照节点结构无效");
  return node;
}

async function pendingOutboxes(db: D1Database): Promise<OutboxRow[]> {
  return (
    (
      await db
        .prepare("SELECT id FROM outbox WHERE topic = ? AND dispatch_state = 'pending' ORDER BY id")
        .bind(SNAPSHOT_REBUILD_TOPIC)
        .all<OutboxRow>()
    ).results ?? []
  );
}

/** 独立运行标记；P3-11 发布前调用读取函数，取消/撤回/改期不得被此标记拦截。 */
export async function readNoncriticalPublicationPause(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value_json FROM system_state WHERE key = ?")
    .bind(NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY)
    .first<{ value_json: string }>();
  if (row === null) return false;
  const value: unknown = JSON.parse(row.value_json);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { paused?: unknown }).paused !== "boolean"
  )
    throw new Error("非关键发布暂停标记损坏");
  return (value as { paused: boolean }).paused;
}

export async function writeNoncriticalPublicationPause(
  db: D1Database,
  paused: boolean,
  reason: string,
  nowMs: number,
): Promise<void> {
  if (reason.trim() === "") throw new Error("暂停标记必须有原因");
  await db
    .prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .bind(NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY, JSON.stringify({ paused, reason }), nowMs)
    .run();
}

/** 容量告警不会覆盖其他来源已经写入的暂停原因。 */
async function markCapacityPause(db: D1Database, nowMs: number): Promise<void> {
  const value = JSON.stringify({ paused: true, reason: PATCH_CAPACITY_PAUSE_REASON });
  await db
    .prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
        updated_at = excluded.updated_at
      WHERE json_extract(system_state.value_json, '$.paused') IS NOT 1
        OR json_extract(system_state.value_json, '$.reason') = ?`)
    .bind(NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY, value, nowMs, PATCH_CAPACITY_PAUSE_REASON)
    .run();
}

/** 只解除本卡容量原因；重算已保留行数，并要求没有尚待构建的发布。 */
async function clearCapacityPauseIfRecovered(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE system_state SET value_json = ?, updated_at = ?
      WHERE key = ? AND json_extract(value_json, '$.paused') = 1
        AND json_extract(value_json, '$.reason') = ?
        AND (SELECT COUNT(*) + 1 FROM calendar_patches WHERE retain_until > ?) < ?
        AND NOT EXISTS (SELECT 1 FROM system_state
          WHERE key = ? AND json_extract(value_json, '$.pending') = 1)`)
    .bind(
      JSON.stringify({ paused: false, reason: PATCH_CAPACITY_PAUSE_REASON }),
      nowMs,
      NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY,
      PATCH_CAPACITY_PAUSE_REASON,
      nowMs,
      CAL_PATCH_GLOBAL_MAX,
      PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
    )
    .run();
}

/** 读取当前整代，公共缓存寿命只取 published_at，不因读取或重组而续命。 */
export async function readCurrentPublicSnapshot(
  db: D1Database,
  nowMs: number,
): Promise<{
  generation: number;
  published_at: number;
  fresh: boolean;
  nodes: readonly PublicSnapshotNode[];
} | null> {
  const row = await db
    .prepare("SELECT id, generation, published_at FROM public_snapshots WHERE state = 'current'")
    .first<SnapshotRow>();
  if (row === null || row.published_at === null) return null;
  const nodes =
    (
      await db
        .prepare(
          "SELECT node_json FROM public_snapshot_nodes WHERE snapshot_id = ? ORDER BY milestone_id",
        )
        .bind(row.id)
        .all<{ node_json: string }>()
    ).results ?? [];
  return {
    generation: row.generation,
    published_at: row.published_at,
    fresh: nowMs <= row.published_at + PUBLIC_CACHE_FRESH * 1000,
    nodes: nodes
      .map((item) => nodeFromJson(item.node_json))
      .filter((node) => !node.tombstone || (node.patch?.retain_until ?? 0) > nowMs)
      .map((node) =>
        node.patch !== null && node.patch.retain_until <= nowMs ? { ...node, patch: null } : node,
      ),
  };
}

export type PublicSnapshotReclaimResult =
  | { readonly outcome: "done"; readonly nodes_deleted: 0; readonly snapshot_deleted: false }
  | {
      readonly outcome: "progress";
      readonly snapshot_id: string;
      readonly nodes_deleted: number;
      readonly snapshot_deleted: boolean;
    };

// 保留 current 和最新一条 superseded；只有低于 current 的 building 已不可能提交。
const reclaimableSnapshotSql = `((state = 'building' AND generation < (
  SELECT generation FROM public_snapshots WHERE state = 'current'
)) OR (state = 'superseded' AND generation < (
  SELECT MAX(previous.generation) FROM public_snapshots AS previous
  WHERE previous.state = 'superseded' AND previous.generation < (
    SELECT generation FROM public_snapshots WHERE state = 'current'
  )
)))`;

/** P3-11 定时调用：一页最多删除 maxNodes 个旧代节点，清空后删除代次行。 */
export async function reclaimSupersededPublicSnapshotPage(
  db: D1Database,
  maxNodes: number,
): Promise<PublicSnapshotReclaimResult> {
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0)
    throw new Error("旧代次回收页大小必须为正安全整数");
  const candidate = await db
    .prepare(`SELECT id FROM public_snapshots WHERE ${reclaimableSnapshotSql}
      ORDER BY generation ASC LIMIT 1`)
    .first<{ id: string }>();
  if (candidate === null) return { outcome: "done", nodes_deleted: 0, snapshot_deleted: false };
  const nodes = await db
    .prepare(`DELETE FROM public_snapshot_nodes WHERE rowid IN (
      SELECT rowid FROM public_snapshot_nodes WHERE snapshot_id = ? ORDER BY rowid LIMIT ?
    ) AND EXISTS (SELECT 1 FROM public_snapshots WHERE id = ? AND ${reclaimableSnapshotSql})`)
    .bind(candidate.id, maxNodes, candidate.id)
    .run();
  const snapshot = await db
    .prepare(`DELETE FROM public_snapshots WHERE id = ? AND ${reclaimableSnapshotSql}
      AND NOT EXISTS (SELECT 1 FROM public_snapshot_nodes WHERE snapshot_id = ?)`)
    .bind(candidate.id, candidate.id)
    .run();
  return {
    outcome: "progress",
    snapshot_id: candidate.id,
    nodes_deleted: nodes.meta.changes ?? 0,
    snapshot_deleted: (snapshot.meta.changes ?? 0) === 1,
  };
}

/** 将当前 P3-04 投影构建成新代次；最终 CAS 核对投影和 outbox 后才切换可见性。 */
export async function buildPublicSnapshot(
  db: D1Database,
  nowMs: number,
): Promise<PublicSnapshotResult> {
  // 到期补偿已脱离合同窗口；先归档，避免旧 active 唯一键阻止新一轮更正。
  await db.prepare("DELETE FROM calendar_patches WHERE retain_until <= ?").bind(nowMs).run();
  const pending = await db
    .prepare("SELECT value_json, updated_at FROM system_state WHERE key = ?")
    .bind(PUBLIC_SNAPSHOT_PENDING_STATE_KEY)
    .first<PendingRow>();
  if (
    pending === null ||
    (JSON.parse(pending.value_json) as { pending?: boolean }).pending !== true
  ) {
    await clearCapacityPauseIfRecovered(db, nowMs);
    return { outcome: "unchanged" };
  }
  const outboxes = await pendingOutboxes(db);
  if (outboxes.length === 0) throw new Error("公共快照待更新但缺少 snapshot_rebuild outbox");
  const current = await db
    .prepare("SELECT id, generation, published_at FROM public_snapshots WHERE state = 'current'")
    .first<SnapshotRow>();
  const rows =
    (
      await db
        .prepare(`SELECT p.milestone_id, p.event_id, p.projection_json,
      p.public_ical_revision, p.updated_at, e.game, e.region
      FROM calendar_projections p JOIN events e ON e.id = p.event_id
      ORDER BY p.milestone_id`)
        .all<ProjectionRow>()
    ).results ?? [];
  const oldRows =
    current === null
      ? []
      : ((
          await db
            .prepare(
              "SELECT milestone_id, node_json FROM public_snapshot_nodes WHERE snapshot_id = ?",
            )
            .bind(current.id)
            .all<StoredNodeRow>()
        ).results ?? []);
  const oldNodes = new Map(oldRows.map((row) => [row.milestone_id, nodeFromJson(row.node_json)]));
  const activePatches =
    (
      await db
        .prepare(`SELECT id, milestone_id, retain_until FROM calendar_patches
      WHERE superseded_at IS NULL AND retain_until > ?`)
        .bind(nowMs)
        .all<PatchRow>()
    ).results ?? [];
  const activeById = new Map(activePatches.map((row) => [row.milestone_id, row]));
  const plannedNodes = new Map<string, PublicSnapshotNode>();
  const changes: { milestoneId: string; prior: PatchRow | null; decision: PatchDecision }[] = [];

  for (const row of rows) {
    const projection = parseProjection(row);
    const old = oldNodes.get(row.milestone_id) ?? null;
    const prior = activeById.get(row.milestone_id) ?? null;
    const changed = old !== null && old.source_projection_json !== row.projection_json;
    const decision = changed
      ? decideCalendarPatch(
          old.projection,
          projection,
          prior === null ? null : old.patch,
          row.updated_at,
          old.tombstone,
        )
      : null;
    if (decision !== null) changes.push({ milestoneId: row.milestone_id, prior, decision });
    const patch = decision ?? (prior === null ? null : (old?.patch ?? null));
    plannedNodes.set(row.milestone_id, {
      ...{ public_changed_at: row.updated_at },
      game: row.game,
      region: row.region,
      projection,
      public_ical_revision: row.public_ical_revision,
      patch,
      source_projection_json: row.projection_json,
      tombstone: false,
    });
  }
  for (const [milestoneId, old] of oldNodes) {
    if (plannedNodes.has(milestoneId)) continue;
    const prior = activeById.get(milestoneId) ?? null;
    const decision = old.tombstone
      ? null
      : decideCalendarPatch(old.projection, null, prior === null ? null : old.patch, nowMs);
    if (decision !== null) changes.push({ milestoneId, prior, decision });
    const patch = decision ?? (prior === null ? null : old.patch);
    if (patch === null) continue;
    plannedNodes.set(milestoneId, {
      ...old,
      projection: {
        ...old.projection,
        event: { ...old.projection.event, status: "cancelled" },
        milestone: { ...old.projection.milestone, time: patch.display_time },
      },
      patch,
      source_projection_json: null,
      tombstone: true,
    });
  }

  const totalRetained = await db
    .prepare("SELECT COUNT(*) AS n FROM calendar_patches WHERE retain_until > ?")
    .bind(nowMs)
    .first<{ n: number }>();
  const patchCount = (totalRetained?.n ?? 0) + changes.length;
  // 再增加一条就触及保护值时提前告警；关键更正仍可继续进入共享层。
  const capacityAlert = patchCount + 1 >= CAL_PATCH_GLOBAL_MAX;
  if (capacityAlert) await markCapacityPause(db, nowMs);

  const generationRow = await db
    .prepare("SELECT COALESCE(MAX(generation), 0) AS n FROM public_snapshots")
    .first<{ n: number }>();
  const generation = (generationRow?.n ?? 0) + 1;
  const snapshotId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO public_snapshots (id, generation, state, built_at, published_at, created_at)
    VALUES (?, ?, 'building', NULL, NULL, ?)`)
    .bind(snapshotId, generation, nowMs)
    .run();
  try {
    // 全部节点通过一个 JSON 参数写入；语句数与节点/更正/outbox 数无关。
    await db
      .prepare(`INSERT INTO public_snapshot_nodes (snapshot_id, milestone_id, node_json)
      SELECT ?, json_extract(value, '$.projection.milestone_id'), value FROM json_each(?)`)
      .bind(snapshotId, JSON.stringify([...plannedNodes.values()]))
      .run();
    const patchPlans = changes.map((change) => ({
      id: crypto.randomUUID(),
      milestone_id: change.milestoneId,
      prior_id: change.prior?.id ?? null,
      kind: change.decision.kind,
      old: timeColumns(change.decision.old_time),
      next: timeColumns(change.decision.new_time),
      reason: change.decision.fact_reason,
      retain_until: change.decision.retain_until,
    }));
    // guard 的 built_at 是本次事务内的效果闸门；失败整批回滚，零命中则所有效果零写入。
    const gate =
      "EXISTS (SELECT 1 FROM public_snapshots WHERE id = ? AND state = 'building' AND built_at = ?)";
    const guard = {
      sql: `UPDATE public_snapshots SET built_at = ? WHERE id = ? AND state = 'building'
          AND ${
            current === null
              ? "NOT EXISTS (SELECT 1 FROM public_snapshots WHERE state = 'current')"
              : "EXISTS (SELECT 1 FROM public_snapshots WHERE id = ? AND state = 'current')"
          }
          AND EXISTS (SELECT 1 FROM system_state WHERE key = ? AND updated_at = ? AND json_extract(value_json, '$.pending') = 1)
          AND (SELECT COUNT(*) FROM outbox WHERE topic = ? AND dispatch_state = 'pending') = ?
          AND NOT EXISTS (SELECT 1 FROM calendar_projections p LEFT JOIN public_snapshot_nodes n
            ON n.snapshot_id = ? AND n.milestone_id = p.milestone_id
            WHERE n.milestone_id IS NULL OR json_extract(n.node_json, '$.source_projection_json') <> p.projection_json
              OR json_extract(n.node_json, '$.public_ical_revision') <> p.public_ical_revision)
          AND NOT EXISTS (SELECT 1 FROM public_snapshot_nodes n LEFT JOIN calendar_projections p
            ON p.milestone_id = n.milestone_id WHERE n.snapshot_id = ? AND p.milestone_id IS NULL
            AND json_extract(n.node_json, '$.tombstone') <> 1)`,
      params: [
        nowMs,
        snapshotId,
        ...(current === null ? [] : [current.id]),
        PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
        pending.updated_at,
        SNAPSHOT_REBUILD_TOPIC,
        outboxes.length,
        snapshotId,
        snapshotId,
      ],
    };
    const results = await db.batch([
      db.prepare(guard.sql).bind(...guard.params),
      db
        .prepare(`UPDATE calendar_patches SET superseded_at = ?, updated_at = ?
        WHERE id IN (SELECT json_extract(value, '$.prior_id') FROM json_each(?)) AND ${gate}`)
        .bind(nowMs, nowMs, JSON.stringify(patchPlans), snapshotId, nowMs),
      db
        .prepare(`INSERT INTO calendar_patches (id, milestone_id, patch_kind, old_time_exact_ms,
        old_time_date, new_time_exact_ms, new_time_date, fact_reason, effective_at, retain_until,
        superseded_at, created_at, updated_at)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.milestone_id'),
          json_extract(value, '$.kind'), json_extract(value, '$.old[0]'), json_extract(value, '$.old[1]'),
          json_extract(value, '$.next[0]'), json_extract(value, '$.next[1]'), json_extract(value, '$.reason'),
          ?, json_extract(value, '$.retain_until'), NULL, ?, ? FROM json_each(?) WHERE ${gate}`)
        .bind(nowMs, nowMs, nowMs, JSON.stringify(patchPlans), snapshotId, nowMs),
      db
        .prepare(
          `UPDATE public_snapshots SET state = 'superseded' WHERE state = 'current' AND ${gate}`,
        )
        .bind(snapshotId, nowMs),
      db
        .prepare(`UPDATE system_state SET value_json = ?, updated_at = ? WHERE key = ? AND ${gate}`)
        .bind(
          JSON.stringify({ pending: false }),
          nowMs,
          PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
          snapshotId,
          nowMs,
        ),
      db
        .prepare(`UPDATE outbox SET dispatch_state = 'dispatched', dispatched_at = ?
        WHERE topic = ? AND dispatch_state = 'pending' AND ${gate}`)
        .bind(nowMs, SNAPSHOT_REBUILD_TOPIC, snapshotId, nowMs),
      db
        .prepare(`UPDATE public_snapshots SET state = 'current', published_at = ?
        WHERE id = ? AND state = 'building' AND built_at = ?`)
        .bind(nowMs, snapshotId, nowMs),
    ]);
    if (results[0]?.meta.changes !== 1) return { outcome: "condition_missed" };
    if (!capacityAlert) await clearCapacityPauseIfRecovered(db, nowMs);
    return { outcome: "built", generation, patch_count: patchCount, capacity_alert: capacityAlert };
  } finally {
    await db
      .prepare(
        "DELETE FROM public_snapshot_nodes WHERE snapshot_id = ? AND EXISTS (SELECT 1 FROM public_snapshots WHERE id = ? AND state = 'building')",
      )
      .bind(snapshotId, snapshotId)
      .run();
    await db
      .prepare("DELETE FROM public_snapshots WHERE id = ? AND state = 'building'")
      .bind(snapshotId)
      .run();
  }
}
