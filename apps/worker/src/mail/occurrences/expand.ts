// P4-01 · 主方案 §7.3：冻结 order 上界；每页候选 Delivery 与 keyset 游标同一条件提交。
import { conditionalCommit, type GuardedEffect } from "../../storage/cas";
import {
  AUDIENCE_SELECT,
  type AudienceRow,
  isEmailAudienceEligible,
  loadInterests,
  OCCURRENCE_SELECT,
  type OccurrenceMatch,
  occurrenceDeliveryKind,
  occurrencePriority,
  occurrenceRuleId,
} from "./eligibility";

interface JobRow {
  payload_json: string;
  lease_version: number;
  status: string;
}

interface Cursor {
  occurrence_id: string;
  cursor: number;
  upper: number;
}

export async function startDueOccurrenceExpansion(
  db: D1Database,
  nowMs: number,
  limit: number,
): Promise<number> {
  const due =
    (
      await db
        .prepare(`${OCCURRENCE_SELECT}
    WHERE o.due_at <= ? AND o.expires_at > ? AND o.invalidated_at IS NULL AND o.audience_upper_order IS NULL
    ORDER BY o.due_at,o.id LIMIT ?`)
        .bind(nowMs, nowMs, limit)
        .all<OccurrenceMatch>()
    ).results ?? [];
  let started = 0;
  for (const occurrence of due) {
    const upper =
      (
        await db
          .prepare('SELECT COALESCE(MAX("order"), -1) AS upper_order FROM users')
          .first<{ upper_order: number }>()
      )?.upper_order ?? -1;
    const jobId = `occurrence:${occurrence.id}:email`;
    const outcome = await conditionalCommit(db, {
      guard: {
        sql: `UPDATE occurrences SET audience_upper_order = ? WHERE id = ? AND audience_upper_order IS NULL
          AND invalidated_at IS NULL AND due_at <= ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM events WHERE id = ? AND schedule_revision = ?)`,
        params: [
          upper,
          occurrence.id,
          nowMs,
          nowMs,
          occurrence.event_id,
          occurrence.schedule_revision,
        ],
      },
      effects: [
        {
          kind: "insert",
          table: "jobs",
          columns: [
            "id",
            "kind",
            "payload_json",
            "due_at",
            "status",
            "lease_version",
            "lease_owner",
            "lease_expires_at",
            "attempts",
            "last_error",
            "created_at",
            "updated_at",
            "completed_at",
          ],
          rows: [
            [
              jobId,
              "occurrence_email_expansion",
              JSON.stringify({ occurrence_id: occurrence.id, cursor: -1, upper }),
              nowMs,
              "pending",
              0,
              null,
              null,
              0,
              null,
              nowMs,
              nowMs,
              null,
            ],
          ],
        },
      ],
    });
    if (outcome.outcome === "committed") started++;
  }
  return started;
}

export async function expandOccurrencePage(
  db: D1Database,
  occurrenceId: string,
  nowMs: number,
  pageSize: number,
): Promise<"advanced" | "done" | "expired" | "unchanged"> {
  const jobId = `occurrence:${occurrenceId}:email`;
  const job = await db
    .prepare("SELECT payload_json,lease_version,status FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<JobRow>();
  if (job === null || job.status !== "pending") return "unchanged";
  const { cursor, upper } = JSON.parse(job.payload_json) as Cursor;
  const occurrence = await db
    .prepare(`${OCCURRENCE_SELECT} WHERE o.id = ?`)
    .bind(occurrenceId)
    .first<OccurrenceMatch>();
  if (occurrence === null) throw new Error("展开目标 occurrence 不存在");
  const stale =
    occurrence.invalidated_at !== null ||
    occurrence.current_schedule_revision !== occurrence.schedule_revision ||
    occurrence.expires_at <= nowMs;
  const users = stale
    ? []
    : ((
        await db
          .prepare(`${AUDIENCE_SELECT}
    WHERE u."order" > ? AND u."order" <= ? ORDER BY u."order" LIMIT ?`)
          .bind(nowMs, cursor, upper, pageSize)
          .all<AudienceRow>()
      ).results ?? []);
  const last = users.at(-1)?.user_order ?? upper;
  const done = stale || users.length < pageSize || last >= upper;
  const nextPayload = JSON.stringify({ occurrence_id: occurrenceId, cursor: last, upper });
  const deliveryKind = occurrenceDeliveryKind(occurrence.kind);
  const ruleId = occurrenceRuleId(occurrence.kind);
  const effects: GuardedEffect[] = [];
  for (const user of users) {
    const interests = await loadInterests(db, user.id, occurrence.game, occurrence.region);
    if (!isEmailAudienceEligible(occurrence, user, interests, nowMs)) continue;
    const logicalRule = ruleId ?? deliveryKind;
    const family = JSON.stringify([
      occurrence.milestone_id,
      occurrence.schedule_revision,
      logicalRule,
      "email",
      user.id,
    ]);
    const found = await db
      .prepare("SELECT id FROM deliveries WHERE dedupe_family = ?")
      .bind(family)
      .first<{ id: string }>();
    if (found !== null) continue;
    effects.push({
      kind: "insert",
      table: "deliveries",
      columns: [
        "id",
        "occurrence_id",
        "user_id",
        "channel",
        "target_ref",
        "milestone_id",
        "schedule_revision",
        "rule_id",
        "kind",
        "priority",
        "dedupe_family",
        "mail_outbox_ref",
        "status",
        "skip_reason",
        "expires_at",
        "created_at",
        "updated_at",
      ],
      rows: [
        [
          crypto.randomUUID(),
          occurrence.id,
          user.id,
          "email",
          user.id,
          occurrence.milestone_id,
          occurrence.schedule_revision,
          ruleId,
          deliveryKind,
          occurrencePriority(occurrence.kind),
          family,
          null,
          "pending",
          null,
          occurrence.expires_at,
          nowMs,
          nowMs,
        ],
      ],
    });
  }
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE jobs SET payload_json = ?, status = ?, lease_version = lease_version + 1, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'pending' AND lease_version = ? AND payload_json = ?
        ${
          stale
            ? ""
            : `AND EXISTS (SELECT 1 FROM occurrences o JOIN events e ON e.id = o.event_id
          WHERE o.id = ? AND o.invalidated_at IS NULL AND o.expires_at > ? AND e.schedule_revision = o.schedule_revision)`
        }`,
      params: [
        nextPayload,
        done ? "done" : "pending",
        nowMs,
        done ? nowMs : null,
        jobId,
        job.lease_version,
        job.payload_json,
        ...(stale ? [] : [occurrence.id, nowMs]),
      ],
    },
    effects,
  });
  if (outcome.outcome !== "committed") return "unchanged";
  return stale ? "expired" : done ? "done" : "advanced";
}
