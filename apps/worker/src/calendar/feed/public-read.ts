// P3-06 · 只缓存无私人内容的当前整代；主库每次确认代次，缓存不是授权依据。
import {
  type PublicSnapshotNode,
  requiredCalendarSources,
  type SubscriptionConfig,
} from "@hoyo/contracts";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { readCurrentPublicSnapshot } from "../public/snapshot";

export interface FeedSnapshot {
  generation: number;
  published_at: number;
  nodes: readonly PublicSnapshotNode[];
}
export class FeedPublicCache {
  private current: FeedSnapshot | null = null;
  async read(db: D1Database, now: number): Promise<FeedSnapshot | null> {
    const header = await db
      .prepare("SELECT generation, node_count FROM public_snapshots WHERE state = 'current'")
      .first<{ generation: number; node_count: number | null }>();
    if (header === null) {
      this.current = null;
      return null;
    }
    if (
      this.current?.generation === header.generation &&
      this.current.nodes.length === header.node_count
    )
      return this.current;
    this.current = null;
    const snapshot = await readCurrentPublicSnapshot(db, now, true);
    if (snapshot === null || snapshot.generation !== header.generation) return null;
    this.current = snapshot;
    return snapshot;
  }
}
/** 所需来源按已登记可抓正文的来源与当前 scope 决定；空结果也须证明来源被成功核验。 */
export function requiredFeedSources(config: SubscriptionConfig): readonly string[] {
  return requiredCalendarSources(config, SOURCE_REGISTRY).map((entry) => entry.sourceId);
}
export async function readFeedSourceWatermarks(
  db: D1Database,
  ids: readonly string[],
): Promise<readonly (number | null)[]> {
  const rows = (
    await db
      .prepare(`SELECT requested.value AS source_id, s.last_success_at
    FROM json_each(?) requested LEFT JOIN sources s ON s.source_id = requested.value`)
      .bind(JSON.stringify(ids))
      .all<{ source_id: string; last_success_at: number | null }>()
  ).results;
  return rows.map((row) => row.last_success_at);
}
/** 仅取保留的上一代来核对缩水证据；绝不把它用作响应内容。更早基线由 contracts 核对现存证据和已保存的自然退出上界。 */
export async function readShrinkEvidence(
  db: D1Database,
  generation: number,
): Promise<readonly PublicSnapshotNode[] | null> {
  const row = await db
    .prepare(`SELECT id, node_count FROM public_snapshots
    WHERE generation = ? AND state = 'superseded' AND generation =
      (SELECT MAX(generation) FROM public_snapshots WHERE state = 'superseded')`)
    .bind(generation)
    .first<{ id: string; node_count: number | null }>();
  if (row === null) return null;
  const nodes = (
    await db
      .prepare(
        "SELECT node_json FROM public_snapshot_nodes WHERE snapshot_id = ? ORDER BY milestone_id",
      )
      .bind(row.id)
      .all<{ node_json: string }>()
  ).results;
  if (row.node_count !== nodes.length) return null;
  return nodes.map((row) => JSON.parse(row.node_json) as PublicSnapshotNode);
}
