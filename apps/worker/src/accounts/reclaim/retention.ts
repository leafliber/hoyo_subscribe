import {
  CONSENT_AUDIT_AFTER_CLOSE,
  DELIVERY_DEDUPE_TTL,
  EXPIRED_AUTH_CLEANUP,
  EXPIRED_SESSION_METADATA,
  MAIL_METADATA_TTL,
  MATCH_PAGE,
  pushStaleCleanupBefore,
  UNREFERENCED_VERSION_TTL,
  UNUSED_ARTICLE_TTL,
} from "@hoyo/contracts";
// 删除正式证据/撤销/抑制/退订绑定不属于机械 TTL；下列引用检查优先。
export async function cleanupRetentionPage(db: D1Database, now: number): Promise<number> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM admission_reservations WHERE id IN(SELECT r.id FROM admission_reservations r WHERE r.state<>'reserved' AND r.expires_at<=? AND NOT EXISTS(SELECT 1 FROM auth_challenges c WHERE c.reservation_id=r.id) ORDER BY r.expires_at LIMIT ?)`,
      )
      .bind(now - EXPIRED_AUTH_CLEANUP * 1000, MATCH_PAGE),
    db
      .prepare(
        `DELETE FROM admin_sessions WHERE id IN(SELECT id FROM admin_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now - EXPIRED_SESSION_METADATA * 1000, MATCH_PAGE),
    db
      .prepare(`DELETE FROM mail_outbox WHERE id IN(SELECT m.id FROM mail_outbox m WHERE m.status IN('accepted','bounced','failed','complained','rejected','skipped','superseded','expired') AND m.updated_at<=?
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.mail_outbox_ref=m.id)
      AND NOT EXISTS(SELECT 1 FROM recent_auth_challenges c WHERE c.outbox_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM mail_feedback f WHERE f.mail_outbox_id=m.id OR f.message_id=m.message_id)
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id='delivery:mail:'||m.id)
      ORDER BY m.updated_at,m.id LIMIT ?)`)
      .bind(now - MAIL_METADATA_TTL * 1000, MATCH_PAGE),
    db
      .prepare(
        `UPDATE sessions SET state='revoked',revoked_at=expires_at,revoke_reason='expired',updated_at=? WHERE id IN (SELECT id FROM sessions WHERE state='active' AND expires_at<=? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, now, MATCH_PAGE),
    // FK 依赖先清；尚可用的最近认证/恢复操作保留其关联会话。
    db
      .prepare(
        `DELETE FROM recovery_rotations WHERE id IN(SELECT id FROM recovery_rotations WHERE expires_at<=? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, MATCH_PAGE),
    db
      .prepare(
        `DELETE FROM recent_auth_proofs WHERE id IN(SELECT id FROM recent_auth_proofs p WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM recovery_rotations r WHERE r.proof_id=p.id) ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, MATCH_PAGE),
    // 删除会话前清除旧 token hash；保留必要外键行时也不留可关联凭证。
    db
      .prepare(
        `UPDATE sessions SET token_hash='expired:'||id,label='',platform_hint='unknown' WHERE id IN(SELECT id FROM sessions WHERE state='revoked' AND revoked_at<=? AND token_hash NOT LIKE 'expired:%' ORDER BY revoked_at,id LIMIT ?)`,
      )
      .bind(now - EXPIRED_SESSION_METADATA * 1000, MATCH_PAGE),
    db
      .prepare(`DELETE FROM sessions WHERE id IN(SELECT id FROM sessions s WHERE state='revoked' AND revoked_at<=?
    AND NOT EXISTS(SELECT 1 FROM auth_challenges c WHERE c.pending_session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM recent_auth_challenges c WHERE c.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM recent_auth_proofs p WHERE p.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM recovery_rotations r WHERE r.session_id=s.id)
    ORDER BY revoked_at,id LIMIT ?)`)
      .bind(now - EXPIRED_SESSION_METADATA * 1000, MATCH_PAGE),
    db
      .prepare(`DELETE FROM consent_events WHERE id IN(SELECT e.id FROM consent_events e WHERE e.created_at<=?
   AND NOT EXISTS(SELECT 1 FROM email_channels c WHERE c.user_id=e.user_id AND (c.enabled=1 OR c.updated_at>?))
   AND NOT EXISTS(SELECT 1 FROM consent_events newer WHERE newer.email_binding_id=e.email_binding_id AND newer.created_at>?)
   ORDER BY e.created_at,e.id LIMIT ?)`)
      .bind(
        now - CONSENT_AUDIT_AFTER_CLOSE * 1000,
        now - CONSENT_AUDIT_AFTER_CLOSE * 1000,
        now - CONSENT_AUDIT_AFTER_CLOSE * 1000,
        MATCH_PAGE,
      ),
    db
      .prepare(`DELETE FROM article_versions WHERE id IN(SELECT v.id FROM article_versions v WHERE v.created_at<=?
   AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.article_version_id=v.id)
   AND NOT EXISTS(SELECT 1 FROM extraction_runs r WHERE r.article_version_id=v.id)
   ORDER BY v.created_at,v.id LIMIT ?)`)
      .bind(now - UNREFERENCED_VERSION_TTL * 1000, MATCH_PAGE),
    db
      .prepare(
        `DELETE FROM articles WHERE id IN(SELECT a.id FROM articles a WHERE a.created_at<=? AND NOT EXISTS(SELECT 1 FROM article_versions v WHERE v.article_id=a.id) ORDER BY a.created_at,a.id LIMIT ?)`,
      )
      .bind(now - UNUSED_ARTICLE_TTL * 1000, MATCH_PAGE),
    // P6（ADR-0025）：租期到期暂停（需重新验证接收才恢复）；激活截止已过的 pending 即删；
    // 暂停或失效超过 PUSH_STALE_GRACE 后清理（§9.4"过期暂停，宽限后清理"）。
    db
      .prepare(
        `UPDATE push_bindings SET state='paused',paused_reason='lease_expired',activation_challenges_json=NULL,binding_version=binding_version+1,updated_at=? WHERE id IN(SELECT id FROM push_bindings WHERE state='active' AND lease_expires_at<=? ORDER BY lease_expires_at LIMIT ?)`,
      )
      .bind(now, now, MATCH_PAGE),
    db
      .prepare(
        `DELETE FROM push_bindings WHERE id IN(SELECT id FROM push_bindings WHERE (state='pending' AND COALESCE(activation_deadline,created_at)<=?)
      OR (state='paused' AND COALESCE(lease_expires_at,activation_deadline,updated_at)<=?)
      OR (state='gone' AND COALESCE(gone_at,updated_at)<=?) ORDER BY updated_at,id LIMIT ?)`,
      )
      // PUSH_STALE_GRACE 的单位是天（附录 A.4）；换算只在 contracts 的 pushStaleCleanupBefore。
      .bind(now, pushStaleCleanupBefore(now), pushStaleCleanupBefore(now), MATCH_PAGE),
    // 已结束的 Push 外发记录与 Delivery 同一期限清理；未完成（含 unknown 待回执核对前）的保留。
    db
      .prepare(`DELETE FROM push_messages WHERE id IN(SELECT id FROM push_messages WHERE expires_at<=?
      AND status IN('accepted','unknown','failed','skipped','superseded','expired') ORDER BY expires_at,id LIMIT ?)`)
      .bind(now - DELIVERY_DEDUPE_TTL * 1000, MATCH_PAGE),
    // 发生项保留为去重锚；其过期且已完成后删除 Delivery 不会使其重新展开。
    db
      .prepare(`DELETE FROM deliveries WHERE id IN(SELECT d.id FROM deliveries d WHERE d.expires_at<=? AND d.status IN('accepted','bounced','failed','complained','rejected','skipped','superseded','expired')
    AND EXISTS(SELECT 1 FROM occurrences o WHERE o.id=d.occurrence_id AND o.expires_at<=?)
    AND NOT EXISTS(SELECT 1 FROM mail_outbox m WHERE m.id=d.mail_outbox_ref AND m.status IN('pending','leased','calling_provider','retry_wait','unknown','deferred'))
    AND NOT EXISTS(SELECT 1 FROM push_messages p WHERE p.delivery_id=d.id AND p.status IN('pending','calling_provider','retry_wait')) ORDER BY d.expires_at LIMIT ?)`)
      .bind(now - DELIVERY_DEDUPE_TTL * 1000, now, MATCH_PAGE),
  ]);
  return results.reduce((n, r) => n + r.meta.changes, 0);
}
