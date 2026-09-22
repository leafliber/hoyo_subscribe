-- P1-04 · 数据组 6/14：会话与恢复（主方案 §8.1 第 6 组、§4.5、§4.6）
-- pending/active 分开（pending 不计 active 名额）；抖动后绝对期限创建时固定；
-- 恢复码单次消费且紧急停用不消费；新码未确认保存前限制恢复会话能力（§8.1 第 6 组约束）。

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id),
  token_hash          TEXT NOT NULL UNIQUE,       -- 常态只存 hash（§4.5）
  state               TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  label               TEXT NOT NULL,              -- 用户自填或缺省设备标签；仅显示信息，不参与鉴权（§4.5）
  platform_hint       TEXT NOT NULL,              -- 粗粒度平台类别：桌面 / 移动 / 未知（§4.5）
  issued_at           INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,           -- SESSION_ABSOLUTE_TTL ± SESSION_ABSOLUTE_JITTER，创建时固定，续期突破不了（§4.5）
  expires_at          INTEGER NOT NULL,           -- 不活跃期限；恒 ≤ 绝对期限
  renewed_at          INTEGER NOT NULL,
  auth_epoch          INTEGER NOT NULL,           -- 使用时与 users.auth_epoch 核对（§4.5）
  recovery_epoch      INTEGER NOT NULL,
  activated_at        INTEGER,
  revoked_at          INTEGER,
  revoke_reason       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (expires_at <= absolute_expires_at)       -- 低频续期不得突破绝对期限（§4.5）
);

-- 所有者维度：active 名额判断与设备列表（§8.1 访问路径"所有者"）。
CREATE INDEX idx_sessions_owner_state ON sessions (user_id, state);
-- 清理时间：pending 超时释放与到期会话（§9.4）。
CREATE INDEX idx_sessions_expiry_cleanup ON sessions (state, expires_at);

-- 绝对期限含抖动、创建时固定（§4.5）：任何改写直接拒绝。
-- 这是 §4.5 的显式不变式，也是 §9.3 集中到期摊平的存储前提。
CREATE TRIGGER trg_sessions_absolute_expires_immutable
BEFORE UPDATE OF absolute_expires_at ON sessions
WHEN OLD.absolute_expires_at <> NEW.absolute_expires_at
BEGIN
  SELECT RAISE (ABORT, 'sessions.absolute_expires_at 含抖动、创建时固定，不得改写（主方案 §4.5）');
END;

-- 恢复码：服务端只存 hash（§4.6）。
-- consumed_at：恢复登录一次消费；紧急停用不消费（§4.6，动作语义由 P2-05 保证，列只承载事实）。
-- saved_confirmed_at：新码保存确认时间；未确认前恢复会话能力受限（§4.6、§8.1）。
CREATE TABLE recovery_credentials (
  id                  TEXT PRIMARY KEY,           -- recovery_id（§4.6）
  user_id             TEXT NOT NULL REFERENCES users (id),
  secret_hash         TEXT NOT NULL,
  generation          INTEGER NOT NULL,           -- 用户级代次；轮换 +1，恢复登录立即交付新码
  consumed_at         INTEGER,
  saved_confirmed_at  INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- 每用户至多一条未消费恢复码：并发提交一次成功（§4.6 一次消费）。
CREATE UNIQUE INDEX idx_recovery_credentials_current
  ON recovery_credentials (user_id) WHERE consumed_at IS NULL;
CREATE INDEX idx_recovery_credentials_user ON recovery_credentials (user_id, generation);
