// P3-11：容量暂停只允许更正；复用 contracts 的变更判定，不从中文标题猜业务。
import {
  classifyPublicationChange,
  type PublicEventFacts,
  type PublicMilestoneFacts,
  TimeValueSchema,
} from "@hoyo/contracts";
import { eventIdentity } from "../../extraction/identity";
import type { CandidateRecord } from "../../extraction/service";
export async function isCriticalPublication(
  db: D1Database,
  candidate: CandidateRecord,
): Promise<boolean> {
  let critical = false;
  let noncritical = false;
  for (const item of candidate.proposal.events) {
    const id =
      item.change_relation?.target_event_id ??
      (await eventIdentity(candidate.sourceId, candidate.externalId, item.event_key));
    const old = await db
      .prepare(
        "SELECT event_type,status,title,summary,official_url,human_locked FROM events WHERE id = ?",
      )
      .bind(id)
      .first<PublicEventFacts>();
    if (old === null) {
      noncritical = true;
      continue;
    }
    const rows = (
      await db.prepare("SELECT * FROM milestones WHERE event_id = ?").bind(id).all<{
        milestone_key: string;
        node_type: PublicMilestoneFacts["node_type"];
        title: string;
        time_precision: string;
        time_exact_ms: number | null;
        time_date: string | null;
        source_timezone: string;
        raw_expression: string;
        time_basis: string;
        human_locked: number;
      }>()
    ).results;
    const nodes: PublicMilestoneFacts[] = rows.map((row) => ({
      milestone_key: row.milestone_key,
      node_type: row.node_type,
      title: row.title,
      human_locked: row.human_locked === 1,
      time: TimeValueSchema.parse({
        precision: row.time_precision,
        ...(row.time_precision === "datetime"
          ? { utc_ms: row.time_exact_ms }
          : row.time_precision === "date"
            ? { date: row.time_date }
            : {}),
        source_timezone: row.source_timezone,
        raw_expression: row.raw_expression,
        time_basis: row.time_basis,
      }),
    }));
    const after = {
      ...old,
      ...item,
      official_url: candidate.officialUrl,
      human_locked: Boolean(old.human_locked),
    };
    const change = classifyPublicationChange(
      old,
      after,
      nodes,
      item.milestones.map((node) => ({ ...node, human_locked: Boolean(old.human_locked) })),
    );
    if (
      old.status !== after.status ||
      old.event_type !== after.event_type ||
      change.schedule_revision
    )
      critical = true;
    else if (change.event_revision) noncritical = true;
  }
  // 原子候选不拆批；混合候选先等容量恢复，不能借更正夹带被暂停的新事件。
  return critical && !noncritical;
}
