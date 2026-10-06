// P6（ADR-0025）获准跨卡：邮件过期与批次清理只看 channel=email 的 Delivery；Push 的到期由 push/delivery.ts 维护。
import { MAIL_METADATA_TTL, MATCH_PAGE } from "@hoyo/contracts";

/** 过期未批准项即使不再进入新批次也留下原因；已关联 outbox 的生命周期交 P4-03。 */
export async function expireDispatchCandidates(db: D1Database, nowMs: number): Promise<number> {
  const result = await db
    .prepare(`UPDATE deliveries SET status = 'expired', skip_reason = 'notification_expired', updated_at = ?
    WHERE id IN (SELECT id FROM deliveries INDEXED BY idx_deliveries_status
      WHERE status = 'pending' AND mail_outbox_ref IS NULL AND channel = 'email' AND expires_at <= ?
      ORDER BY expires_at,id LIMIT ?)`)
    .bind(nowMs, nowMs, MATCH_PAGE)
    .run();
  return result.meta.changes;
}

/** P5 可逐个批次调用：保留元数据期限与未完成发送依赖；永不回收公平游标或发生项展开记录。 */
export async function pruneExpiredDispatchBatch(
  db: D1Database,
  batchId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM jobs WHERE id = ? AND kind = 'mail_dispatch_batch'
    AND created_at <= ?
    AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(jobs.payload_json,'$.occurrenceIds')) b
      JOIN occurrences o ON o.id = b.value WHERE o.expires_at > ?)
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.channel = 'email' AND d.status IN ('pending','leased','calling_provider','retry_wait','unknown','deferred')
      AND d.occurrence_id IN (SELECT value FROM json_each(json_extract(jobs.payload_json,'$.occurrenceIds'))))`)
    .bind(batchId, nowMs - MAIL_METADATA_TTL * 1000, nowMs)
    .run();
  return result.meta.changes === 1;
}
