-- P1-04 · 数据组 5/14：认证挑战（主方案 §8.1 第 5 组、§4.2、§4.3、§4.4）
-- 一次消费；完成回执短期加密；挑战失效不重开（§8.1 第 5 组约束）。
-- 验证码原值只存在短期加密发信载荷中；本表只保存带独立 pepper 的 MAC（§4.3）。

CREATE TABLE auth_challenges (
  id                  TEXT PRIMARY KEY,
  purpose             TEXT NOT NULL,        -- 用途：登录 / 新注册 / 换邮箱 / 恢复登录（§4.x）；精确取值属 P2-02
  email_key           TEXT NOT NULL,
  address_version     INTEGER NOT NULL,     -- 地址版本；消费时检查（§4.1）
  preauth_id          TEXT NOT NULL,        -- 浏览器预认证上下文绑定（§4.3）
  idempotency_key     TEXT,                 -- 网络重试幂等，绑定预认证上下文（§4.3）
  mac                 TEXT NOT NULL,        -- 验证码 MAC（独立 pepper，§4.3）
  generation          INTEGER NOT NULL DEFAULT 0,  -- 重发只旋转本挑战 generation（§4.3）
  attempts            INTEGER NOT NULL DEFAULT 0,  -- 错误尝试持久扣减，不被事务回滚抵消（§4.3）
  deadline            INTEGER NOT NULL,     -- 挑战最初截止，重发不延长（§4.3）
  reservation_id      TEXT,                 -- 注册预占（admission_reservations.id，0014 建；表间无外键，由 P2-03 维系）
  consumed_at         INTEGER,              -- 一次消费；消费后不可重开（§4.4）
  aborted_at          INTEGER,
  receipt_ciphertext  BLOB,                 -- 完成回执：短期加密的待交付 Cookie 值（§4.4）
  receipt_expires_at  INTEGER,              -- AUTH_COMPLETION_TTL 内可取，到期由清理任务兜底（§4.4）
  pending_session_id  TEXT,                 -- 目标 pending Session（§4.4）
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- 每规范邮箱的频率 / 冷却（§9.2 认证池规则按邮箱计数）。
CREATE INDEX idx_auth_challenges_email ON auth_challenges (email_key, created_at);
-- 清理时间（§8.1 访问路径）：到期挑战与到期回执。
CREATE INDEX idx_auth_challenges_deadline ON auth_challenges (deadline);
-- 未消费挑战的邮箱维度缩查。
CREATE INDEX idx_auth_challenges_open
  ON auth_challenges (email_key) WHERE consumed_at IS NULL AND aborted_at IS NULL;
-- 同一预认证上下文 + 幂等键只产生一个发送意图（§4.3）。
CREATE UNIQUE INDEX idx_auth_challenges_idem
  ON auth_challenges (preauth_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
