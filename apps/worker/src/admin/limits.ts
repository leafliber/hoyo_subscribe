import {
  decideCalendarPatch,
  PUBLIC_READ_LIMITS,
  type PublicCalendarProjection,
  type PublicSnapshotNode,
} from "@hoyo/contracts";
import type { CandidateProposal } from "../extraction/schema";
import { ApiError } from "../shell";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function invalid(path: string): never {
  throw new ApiError("validation", {
    code: "validation",
    fields: [{ path, reason: "public_node_too_large" }],
  });
}

/** 一个节点有双份投影和最多三份更正时间；给字段分配 nodeBytes 的 1/32，
 * 剩余空间留给固定结构、身份、转义与历史更正。最终仍核验实际完整节点。 */
export function checkCandidateText(proposal: CandidateProposal): void {
  const fieldBytes = Math.floor(PUBLIC_READ_LIMITS.nodeBytes / 32);
  for (const event of proposal.events) {
    for (const value of [event.title, event.summary, event.event_key]) {
      if (bytes(value) > fieldBytes) invalid("proposal_json");
    }
    for (const milestone of event.milestones) {
      for (const value of [
        milestone.title,
        milestone.milestone_key,
        milestone.time.raw_expression,
        milestone.time.source_timezone,
      ]) {
        if (bytes(value) > fieldBytes) invalid("proposal_json");
      }
    }
  }
}

/** 消费发布器实际计划（含保留旧节点），不另定义事件/节点合并或更正规则。 */
export async function checkPublishedNodeBytes(
  db: D1Database,
  projections: readonly PublicCalendarProjection[],
  now: number,
  scope: { game: string; region: string },
): Promise<void> {
  for (const projection of projections) {
    const previous = await db
      .prepare(`SELECT n.node_json FROM public_snapshots s
      JOIN public_snapshot_nodes n ON n.snapshot_id = s.id AND n.milestone_id = ?
      WHERE s.state = 'current'`)
      .bind(projection.milestone_id)
      .first<{ node_json: string }>();
    const old: PublicSnapshotNode | null =
      previous === null ? null : JSON.parse(previous.node_json);
    const prior = old?.patch && old.patch.retain_until > now ? old.patch : null;
    const source = JSON.stringify(projection);
    const patch =
      old !== null && old.source_projection_json !== source
        ? (decideCalendarPatch(old.projection, projection, prior, now, old.tombstone) ?? prior)
        : prior;
    const node = {
      ...scope,
      public_changed_at: Number.MAX_SAFE_INTEGER,
      projection,
      public_ical_revision: Number.MAX_SAFE_INTEGER,
      patch,
      source_projection_json: source,
      tombstone: false,
      content_generation: Number.MAX_SAFE_INTEGER,
    };
    if (bytes(node) > PUBLIC_READ_LIMITS.nodeBytes) invalid("proposal_json");
  }
}
