-- P2-09：首次意图由两张挑战表承载（含永不外发的 equalization 占位挑战）。
-- 重发意图独立于 outbox，载荷清空、任务清理都不能恢复邮箱的当日额度。
CREATE TABLE auth_resend_intents (
  id TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  preauth_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (preauth_id, idempotency_key)
);
CREATE INDEX idx_auth_resend_intents_email ON auth_resend_intents(email_key, created_at);
CREATE INDEX idx_auth_resend_intents_cleanup ON auth_resend_intents(created_at);
-- 只迁移明确重发（首发 idempotency_key 为 NULL），不把未受理的 skipped 算成发送。
INSERT INTO auth_resend_intents (id,email_key,preauth_id,idempotency_key,created_at)
SELECT o.id,c.email_key,c.preauth_id,
  substr(o.idempotency_key,length(c.preauth_id)+2),o.created_at
FROM mail_outbox o JOIN auth_challenges c ON c.id=o.payload_ref
WHERE o.idempotency_key IS NOT NULL AND o.status <> 'skipped';
