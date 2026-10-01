import { EMAIL_CONSENT_DISABLE_ACTION } from "@hoyo/contracts";

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
  const results = await db.batch([
    db
      .prepare(
        "UPDATE users SET updated_at=updated_at WHERE email_binding_id=? AND status='active'",
      )
      .bind(bindingId),
    db
      .prepare(`INSERT INTO email_channels(user_id,address_version,created_at,updated_at)
      SELECT id,email_version,?,? FROM users WHERE email_binding_id=? AND changes()=1
      ON CONFLICT(user_id) DO UPDATE SET enabled=0,routine_enabled=0,lease_expires_at=NULL,
        channel_revision=email_channels.channel_revision+1,updated_at=excluded.updated_at
      WHERE email_channels.enabled<>0 OR email_channels.routine_enabled<>0 OR email_channels.lease_expires_at IS NOT NULL`)
      .bind(now, now, bindingId),
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
  return results[0].meta.changes === 1;
}
