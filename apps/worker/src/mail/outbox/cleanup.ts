// P4-03：发送元数据沿 MAIL_METADATA_TTL；P5 可在其墙钟内逐页调用。未知/未完成结果不清除。
import { MAIL_METADATA_TTL, MATCH_PAGE } from "@hoyo/contracts";
export async function pruneMailJobPage(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM jobs WHERE id IN (
    SELECT j.id FROM jobs j WHERE j.kind='mail_send' AND j.status IN ('done','failed')
      AND j.completed_at < ? AND NOT EXISTS (SELECT 1 FROM mail_outbox o
        WHERE o.id=substr(j.id,length('delivery:mail:')+1) AND o.status IN ('pending','leased','calling_provider','retry_wait','unknown','deferred'))
      ORDER BY j.completed_at LIMIT ?)`)
    .bind(now - MAIL_METADATA_TTL * 1000, MATCH_PAGE)
    .run();
  return result.meta.changes;
}
