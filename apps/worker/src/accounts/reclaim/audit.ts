import { MATCH_PAGE, SYSTEM_AUDIT_TTL } from "@hoyo/contracts";

const KEY = "reclaim:system_audit_correction";
export const SYSTEM_AUDIT_HISTORY_SQL = `SELECT id,created_at FROM audit_log INDEXED BY idx_audit_log_system_created WHERE actor_type='system' AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?`;
export const SYSTEM_AUDIT_EXPIRED_SQL = `SELECT id FROM audit_log INDEXED BY idx_audit_log_system_expiry WHERE actor_type='system' AND expires_at<=? ORDER BY expires_at,id LIMIT ?`;
/** 一次校正一页，完成全体历史后才开始删除。游标与校正在同一个事务，崩溃可重放。 */
export async function maintainSystemAuditPage(db: D1Database, now: number): Promise<number> {
  const raw = await db
    .prepare("SELECT value_json FROM system_state WHERE key=?")
    .bind(KEY)
    .first<string>("value_json");
  const saved = raw
    ? (JSON.parse(raw) as { ttl: number; at: number; id: string; done: boolean })
    : null;
  const cursor =
    saved?.ttl === SYSTEM_AUDIT_TTL
      ? saved
      : { ttl: SYSTEM_AUDIT_TTL, at: -1, id: "", done: false };
  if (!cursor.done) {
    const rows = (
      await db
        .prepare(SYSTEM_AUDIT_HISTORY_SQL)
        .bind(cursor.at, cursor.id, MATCH_PAGE)
        .all<{ id: string; created_at: number }>()
    ).results;
    const last = rows.at(-1);
    await db.batch([
      db
        .prepare(
          `UPDATE audit_log SET expires_at=created_at+? WHERE actor_type='system' AND id IN(SELECT value FROM json_each(?)) AND expires_at IS NOT created_at+?`,
        )
        .bind(
          SYSTEM_AUDIT_TTL * 1000,
          JSON.stringify(rows.map((r) => r.id)),
          SYSTEM_AUDIT_TTL * 1000,
        ),
      db
        .prepare(
          `INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
        )
        .bind(
          KEY,
          JSON.stringify({
            ttl: SYSTEM_AUDIT_TTL,
            at: last?.created_at ?? cursor.at,
            id: last?.id ?? cursor.id,
            done: rows.length < MATCH_PAGE,
          }),
          now,
        ),
    ]);
    return rows.length || 1;
  }
  const r = await db
    .prepare(
      `DELETE FROM audit_log WHERE actor_type='system' AND id IN (${SYSTEM_AUDIT_EXPIRED_SQL}) AND expires_at=created_at+?`,
    )
    .bind(now, MATCH_PAGE, SYSTEM_AUDIT_TTL * 1000)
    .run();
  return r.meta.changes;
}
