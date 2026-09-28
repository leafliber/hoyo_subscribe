-- P2-05：恢复会话限制由会话承担；恢复停用的幂等水位独立于灾备 recovery_epoch。
ALTER TABLE sessions ADD COLUMN recovery_code_required INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_code_required IN (0, 1));
ALTER TABLE users ADD COLUMN last_recovery_stop_epoch INTEGER;

-- recovery_id 精确双窗口计数；只保存 SHA-256 摘要，不保存来源 IP。
CREATE TABLE recovery_attempt_windows (
  subject_hash TEXT NOT NULL,
  period_kind TEXT NOT NULL CHECK (period_kind IN ('hour', 'day')),
  period_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_hash, period_kind, period_start)
);
CREATE INDEX idx_recovery_attempt_windows_expiry ON recovery_attempt_windows (expires_at);
