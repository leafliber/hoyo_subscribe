-- P2-07：最近认证绑定当前会话、操作用途与目标摘要；仅校验成功后生成单次证明。
ALTER TABLE users ADD COLUMN deletion_completed_at INTEGER;
CREATE TABLE recent_auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('email_change','recovery_code_rotate','account_delete')),
  role TEXT NOT NULL CHECK (role IN ('current','new_address')),
  target_digest TEXT NOT NULL,
  email_key TEXT NOT NULL,
  address_version INTEGER NOT NULL,
  mac TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER NOT NULL,
  outbox_id TEXT NOT NULL REFERENCES mail_outbox(id),
  consumed_at INTEGER,
  aborted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_recent_auth_challenges_session ON recent_auth_challenges(session_id, action, role, created_at);
CREATE INDEX idx_recent_auth_challenges_expiry ON recent_auth_challenges(deadline);
CREATE UNIQUE INDEX idx_recent_auth_challenges_idem ON recent_auth_challenges(session_id, idempotency_key);

CREATE TABLE recent_auth_proofs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  action TEXT NOT NULL CHECK (action IN ('email_change','recovery_code_rotate','account_delete')),
  role TEXT NOT NULL CHECK (role IN ('current','new_address')),
  target_digest TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('otp','recovery')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recent_auth_proofs_session ON recent_auth_proofs(session_id, action, role, expires_at);
CREATE INDEX idx_recent_auth_proofs_expiry ON recent_auth_proofs(expires_at);

-- 已确认旧码在新码被本人回传确认之前继续有效；响应丢失可用同一操作键重新生成。
CREATE TABLE recovery_rotations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  operation_key TEXT NOT NULL,
  proof_id TEXT NOT NULL REFERENCES recent_auth_proofs(id),
  old_credential_id TEXT NOT NULL REFERENCES recovery_credentials(id),
  new_credential_id TEXT NOT NULL,
  new_secret_hash TEXT NOT NULL,
  new_generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, operation_key)
);
CREATE INDEX idx_recovery_rotations_expiry ON recovery_rotations(expires_at);

-- 邮箱绑定更换和删除在 users 的同一提交内废止旧会话及待发认证任务。
-- 通道状态由 P3/P4/P6 的挂接效果写入；这里不创造它们的状态枚举。
CREATE TRIGGER trg_account_email_change_invalidate
AFTER UPDATE OF email_version ON users
WHEN NEW.email_version <> OLD.email_version
BEGIN
  UPDATE sessions SET state = 'revoked', revoked_at = NEW.updated_at,
    revoke_reason = 'email_change', updated_at = NEW.updated_at
    WHERE user_id = OLD.id AND state IN ('pending','active');
  UPDATE auth_challenges SET aborted_at = NEW.updated_at, receipt_ciphertext = NULL,
    receipt_expires_at = NULL, delivery_address_ciphertext = NULL, updated_at = NEW.updated_at
    WHERE email_key = OLD.email_key AND consumed_at IS NULL AND aborted_at IS NULL;
  UPDATE auth_challenges SET receipt_ciphertext = NULL, receipt_expires_at = NULL,
    updated_at = NEW.updated_at WHERE pending_session_id IN
      (SELECT id FROM sessions WHERE user_id = OLD.id);
  UPDATE recent_auth_challenges SET aborted_at = NEW.updated_at, updated_at = NEW.updated_at
    WHERE user_id = OLD.id AND consumed_at IS NULL AND aborted_at IS NULL;
  UPDATE mail_outbox SET status = 'skipped', payload_ciphertext = NULL,
    payload_ref = NULL, updated_at = NEW.updated_at
    WHERE recipient_user_id = OLD.id AND address_version = OLD.email_version
      AND status IN ('pending','retry_wait');
  UPDATE email_channels SET enabled = 0, routine_enabled = 0,
    address_version = NEW.email_version, updated_at = NEW.updated_at WHERE user_id = OLD.id;
END;

CREATE TRIGGER trg_account_delete_invalidate
AFTER UPDATE OF status ON users
WHEN NEW.status = 'deleting' AND OLD.status <> 'deleting'
BEGIN
  UPDATE sessions SET state = 'revoked', revoked_at = NEW.updated_at,
    revoke_reason = 'account_delete', updated_at = NEW.updated_at
    WHERE user_id = OLD.id AND state IN ('pending','active');
  UPDATE auth_challenges SET aborted_at = NEW.updated_at, receipt_ciphertext = NULL,
    receipt_expires_at = NULL, delivery_address_ciphertext = NULL, updated_at = NEW.updated_at
    WHERE email_key = OLD.email_key AND consumed_at IS NULL AND aborted_at IS NULL;
  UPDATE auth_challenges SET receipt_ciphertext = NULL, receipt_expires_at = NULL,
    updated_at = NEW.updated_at WHERE pending_session_id IN
      (SELECT id FROM sessions WHERE user_id = OLD.id);
  UPDATE recent_auth_challenges SET aborted_at = NEW.updated_at, updated_at = NEW.updated_at
    WHERE user_id = OLD.id AND consumed_at IS NULL AND aborted_at IS NULL;
  UPDATE mail_outbox SET status = 'skipped', payload_ciphertext = NULL,
    payload_ref = NULL, updated_at = NEW.updated_at
    WHERE recipient_user_id = OLD.id AND status IN ('pending','retry_wait');
  UPDATE email_channels SET enabled = 0, routine_enabled = 0,
    updated_at = NEW.updated_at WHERE user_id = OLD.id;
END;
