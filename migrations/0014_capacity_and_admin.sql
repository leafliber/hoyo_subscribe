-- P1-04 · 数据组 14/14：容量与管理（主方案 §8.1 第 14 组、§4.2、§8.3）
-- 预占/释放一致；管理员隔离；日志有期限，不保存认证秘密（§8.1 第 14 组约束）。

-- 注册预占（§4.2）：注册槽在验证码有效期内保留，验证成功转成账号存量，过期释放；
-- 不创建永久"候补用户"（§9.4）。
CREATE TABLE admission_reservations (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,          -- 首版仅 registration（§4.2）
  email_key          TEXT NOT NULL,
  state              TEXT NOT NULL,          -- reserved / converted / released / expired（§4.2）
  reserved_at        INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  converted_user_id  TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 同一规范邮箱共享有限预占、防并发超卖（§4.2）：至多一条 reserved。
-- P0-01 实测：CAS 零行不回滚 batch → 容量判断不能 COUNT→无条件 INSERT，
-- 条件唯一索引 + P1-05 统一守卫让整批写入一起成立或一起失败。
CREATE UNIQUE INDEX idx_admission_reservations_open
  ON admission_reservations (email_key) WHERE state = 'reserved';
-- 清理时间（§8.1 访问路径）：到期释放。
CREATE INDEX idx_admission_reservations_expiry ON admission_reservations (expires_at);

-- 容量计数（账号总存量、当日注册等）：条件更新本行，禁止 COUNT 后无条件 INSERT（§8.1 末段）。
CREATE TABLE capacity_state (
  key         TEXT PRIMARY KEY,              -- 如 accounts_total / registrations:2026-09-22
  value       INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,    -- CAS 列：P1-05 统一条件守卫用
  updated_at  INTEGER NOT NULL
);

-- 运行开关与全局状态（registration_open、回收暂停、当前发布代次缓存等）。
CREATE TABLE system_state (
  key          TEXT PRIMARY KEY,
  value_json   TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at   INTEGER NOT NULL
);

-- 管理员会话（§8.3）：与普通用户会话完全隔离；高强度引导秘密换短期会话。
CREATE TABLE admin_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  admin_id      TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_admin_sessions_expiry ON admin_sessions (expires_at);

-- 审计日志：有期限，不保存认证秘密（§8.1 第 14 组约束）。
-- 人工修改保护字段必须带理由（§3.6）→ reason 列。
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  actor_type   TEXT NOT NULL,                -- admin | system
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  reason       TEXT,
  detail_ref   TEXT,                         -- 详情引用（不含秘密的脱敏负载）
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- 清理时间（§8.1 访问路径）与时间序。
CREATE INDEX idx_audit_log_expiry ON audit_log (expires_at);
CREATE INDEX idx_audit_log_created ON audit_log (created_at);
