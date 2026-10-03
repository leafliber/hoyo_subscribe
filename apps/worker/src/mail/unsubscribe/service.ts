import { EMAIL_CONSENT_DISABLE_ACTION } from "@hoyo/contracts";
import { recordMetric } from "../../shell/observability/metrics";

export async function currentBinding(db: D1Database, bindingId: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT id FROM users WHERE email_binding_id=? AND status='active'")
      .bind(bindingId)
      .first()) !== null
  );
}
/** 单个事务重查当前绑定；不依赖读取快照或旧同意版本，不受开启额度约束。 */
export async function closeBusinessMail(
  db: D1Database,
  bindingId: string,
  now: number,
): Promise<boolean> {
  const started = Date.now();
  const results = await db.batch([
    // 有效绑定判定与条件关闭同处 batch 事务；SELECT 不制造重复停止的写入。
    db.prepare("SELECT id FROM users WHERE email_binding_id=? AND status='active'").bind(bindingId),
    db
      .prepare(`UPDATE email_channels SET enabled=0,routine_enabled=0,lease_expires_at=NULL,
        channel_revision=channel_revision+1,updated_at=?
      WHERE user_id=(SELECT id FROM users WHERE email_binding_id=? AND status='active')
        AND (enabled<>0 OR routine_enabled<>0 OR lease_expires_at IS NOT NULL)`)
      .bind(now, bindingId),
    // 末句可写两行；前句零行说明已关闭，不制造重复退订审计或无界历史。
    db
      .prepare(`INSERT INTO consent_events(id,user_id,email_binding_id,layer,action,consent_version,context_json,created_at)
      SELECT ?,c.user_id,u.email_binding_id,'seat',?,c.consent_version,'{"reason":"unsubscribe"}',?
      FROM users u JOIN email_channels c ON c.user_id=u.id WHERE u.email_binding_id=? AND changes()=1
      UNION ALL
      SELECT ?,c.user_id,u.email_binding_id,'routine',?,c.consent_version,'{"reason":"unsubscribe"}',?
      FROM users u JOIN email_channels c ON c.user_id=u.id WHERE u.email_binding_id=? AND changes()=1`)
      .bind(
        crypto.randomUUID(),
        EMAIL_CONSENT_DISABLE_ACTION,
        now,
        bindingId,
        crypto.randomUUID(),
        EMAIL_CONSENT_DISABLE_ACTION,
        now,
        bindingId,
      ),
  ]);
  if (results[1].meta.changes === 1)
    await recordMetric(db, "unsubscribe_latency_ms", now, Math.max(0, Date.now() - started));
  return results[0].results.length === 1;
}
