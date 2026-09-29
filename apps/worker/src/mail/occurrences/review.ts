// P4-01 · 主方案 §7.1：外发前即时复核；P4-03 在领取发送意图时调用。
import {
  AUDIENCE_SELECT,
  type AudienceRow,
  isEmailAudienceEligible,
  loadInterests,
  OCCURRENCE_SELECT,
  type OccurrenceMatch,
} from "./eligibility";

interface DeliveryRow {
  id: string;
  user_id: string;
  occurrence_id: string;
  channel: string;
  target_ref: string;
  schedule_revision: number;
  status: string;
  expires_at: number;
}

export async function reviewDeliveryBeforeSend(
  db: D1Database,
  deliveryId: string,
  nowMs: number,
): Promise<"eligible" | "expired" | "superseded" | "skipped" | "already_sent"> {
  const delivery = await db
    .prepare(
      "SELECT id,user_id,occurrence_id,channel,target_ref,schedule_revision,status,expires_at FROM deliveries WHERE id = ?",
    )
    .bind(deliveryId)
    .first<DeliveryRow>();
  if (delivery === null) throw new Error("Delivery 不存在");
  if (!(["pending", "leased", "retry_wait"] as string[]).includes(delivery.status))
    return "already_sent";
  const occurrence = await db
    .prepare(`${OCCURRENCE_SELECT} WHERE o.id = ?`)
    .bind(delivery.occurrence_id)
    .first<OccurrenceMatch>();
  if (occurrence === null) throw new Error("Delivery 的 occurrence 不存在");
  if (delivery.channel !== "email" || delivery.target_ref !== delivery.user_id) return "skipped";
  if (
    occurrence.invalidated_at !== null ||
    occurrence.current_schedule_revision !== occurrence.schedule_revision ||
    delivery.schedule_revision !== occurrence.schedule_revision
  )
    return "superseded";
  if (delivery.expires_at <= nowMs || occurrence.expires_at <= nowMs) return "expired";
  const audience = await db
    .prepare(`${AUDIENCE_SELECT} WHERE u.id = ?`)
    .bind(nowMs, delivery.user_id)
    .first<AudienceRow>();
  if (audience === null) return "skipped";
  const interests = await loadInterests(db, audience.id, occurrence.game, occurrence.region);
  return isEmailAudienceEligible(occurrence, audience, interests, nowMs) ? "eligible" : "skipped";
}
