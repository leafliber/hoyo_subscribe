// P6（ADR-0025）获准跨卡：候选只取 channel=email；Push Delivery 由 push/delivery.ts 外发，不能被邮件调度标成 skipped。
import { AUDIENCE_SELECT } from "../occurrences/eligibility";
import type { DispatchContext } from "./types";

// 单用户快照同时供读取和提交守卫使用，防止读完资格后退订/换绑/改期仍写入意图。
const audienceFields = [
  "id",
  "user_order",
  "status",
  "email_binding_id",
  "email_version",
  "subscription_state",
  "subscription_revision",
  "scope_json",
  "calendar_json",
  "notifications_json",
  "channel_enabled",
  "routine_enabled",
  "channel_address_version",
  "lease_expires_at",
  "seat_enabled_at",
  "routine_enabled_at",
  "suppressed",
];
const candidateFields = {
  delivery_id: "d.id",
  user_id: "d.user_id",
  user_order: 'u."order"',
  delivery_kind: "d.kind",
  priority: "d.priority",
  delivery_expires_at: "d.expires_at",
  delivery_schedule_revision: "d.schedule_revision",
  target_ref: "d.target_ref",
  channel: "d.channel",
  id: "o.id",
  milestone_id: "o.milestone_id",
  schedule_revision: "o.schedule_revision",
  kind: "o.kind",
  due_at: "o.due_at",
  expires_at: "o.expires_at",
  invalidated_at: "o.invalidated_at",
  event_id: "e.id",
  game: "e.game",
  region: "e.region",
  event_type: "e.event_type",
  event_status: "e.status",
  current_schedule_revision: "e.schedule_revision",
};
export const CONTEXT_SQL = `SELECT json_object(
  'audience', (SELECT json_object(${audienceFields.map((f) => `'${f}', a.${f}`).join(",")}) FROM (${AUDIENCE_SELECT} WHERE u.id = ?) a),
  'interests', json((SELECT json_group_array(json_object('game',game,'region',region,'interest_kind',interest_kind,'interest_id',interest_id,'enabled_at',enabled_at))
    FROM (SELECT * FROM subscription_interests WHERE user_id = ? ORDER BY id))),
  'candidates', json((SELECT json_group_array(json(item)) FROM (
    SELECT json_object(${Object.entries(candidateFields)
      .map(([key, value]) => `'${key}',${value}`)
      .join(",")}) AS item
    FROM deliveries d INDEXED BY idx_deliveries_status JOIN occurrences o ON o.id = d.occurrence_id
    JOIN events e ON e.id = o.event_id JOIN users u ON u.id = d.user_id
    WHERE d.status = 'pending' AND d.mail_outbox_ref IS NULL AND d.user_id = ? AND d.channel = 'email'
      AND d.occurrence_id IN (SELECT value FROM json_each(?)) ORDER BY d.id)))
) AS snapshot`;
export function contextParams(
  userId: string,
  occurrenceIds: string[],
  nowMs: number,
): (string | number)[] {
  return [nowMs, userId, userId, userId, JSON.stringify(occurrenceIds)];
}
export async function readDispatchContext(
  db: D1Database,
  userId: string,
  occurrenceIds: string[],
  nowMs: number,
): Promise<{ snapshot: string; context: DispatchContext }> {
  const row = await db
    .prepare(CONTEXT_SQL)
    .bind(...contextParams(userId, occurrenceIds, nowMs))
    .first<{ snapshot: string }>();
  if (!row) throw new Error("调度快照读取失败");
  return { snapshot: row.snapshot, context: JSON.parse(row.snapshot) as DispatchContext };
}
