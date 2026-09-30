// 即将到期项只为当前已获候选的用户暂存 Delivery；不提前冻结 occurrence 的全体受众。
import { MATCH_PAGE } from "@hoyo/contracts";
import {
  isEmailAudienceEligible,
  OCCURRENCE_SELECT,
  type OccurrenceMatch,
  occurrenceDeliveryKind,
  occurrencePriority,
  occurrenceRuleId,
} from "../occurrences/eligibility";
import type { DispatchBatch } from "./batch";
import type { DispatchContext } from "./types";

/** 每次最多暂存 MATCH_PAGE 条；不扣机会、不推进公平游标、不修改全局展开进度。 */
export async function stageDigestCandidates(
  db: D1Database,
  batch: DispatchBatch,
  context: DispatchContext,
  priority: number,
  nowMs: number,
): Promise<boolean> {
  const audience = context.audience;
  if (!audience) return false;
  const future = (
    await db
      .prepare(`${OCCURRENCE_SELECT}
    WHERE o.id IN (SELECT value FROM json_each(?)) AND o.due_at > ? AND o.expires_at > ? AND o.invalidated_at IS NULL`)
      .bind(JSON.stringify(batch.occurrenceIds), batch.startedAt, nowMs)
      .all<OccurrenceMatch>()
  ).results;
  const candidates = future
    .filter(
      (o) =>
        occurrencePriority(o.kind) === priority &&
        isEmailAudienceEligible(
          o,
          audience,
          context.interests.filter((i) => i.game === o.game && i.region === o.region),
          nowMs,
        ),
    )
    .map((o) => {
      const rule = occurrenceRuleId(o.kind);
      const kind = occurrenceDeliveryKind(o.kind);
      return {
        o,
        rule,
        kind,
        family: JSON.stringify([
          o.milestone_id,
          o.schedule_revision,
          rule ?? kind,
          "email",
          audience.id,
        ]),
      };
    });
  if (!candidates.length) return false;
  const existing = new Set(
    (
      await db
        .prepare(`SELECT d.dedupe_family FROM json_each(?) k
    JOIN deliveries d ON d.dedupe_family = k.value`)
        .bind(JSON.stringify(candidates.map((c) => c.family)))
        .all<{ dedupe_family: string }>()
    ).results.map((r) => r.dedupe_family),
  );
  const pending = candidates.filter((c) => !existing.has(c.family)).slice(0, MATCH_PAGE);
  if (!pending.length) return false;
  // 每行唯一键即幂等条件；并发扫描只会插入一次。审批仍会重新读取兴趣、绑定及计划版本。
  await db.batch(
    pending.map(({ o, rule, kind, family }) =>
      db
        .prepare(`INSERT INTO deliveries
    (id,occurrence_id,user_id,channel,target_ref,milestone_id,schedule_revision,rule_id,kind,priority,dedupe_family,status,expires_at,created_at,updated_at)
    VALUES (?,?,?,'email',?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(dedupe_family) DO NOTHING`)
        .bind(
          crypto.randomUUID(),
          o.id,
          audience.id,
          audience.id,
          o.milestone_id,
          o.schedule_revision,
          rule,
          kind,
          priority,
          family,
          o.expires_at,
          nowMs,
          nowMs,
        ),
    ),
  );
  return true;
}
