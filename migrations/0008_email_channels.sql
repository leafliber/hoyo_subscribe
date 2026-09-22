-- P1-04 · 数据组 8/14：邮件（主方案 §8.1 第 8 组、§7.5、§7.7、§9.4）
-- 两层各记同意；routine_enabled 默认关闭且占子名额；同意与可投递分离；
-- 新邮箱不继承同意；抑制按准确地址关联（§8.1 第 8 组约束）。
-- routine_enabled 属通道状态，不进订阅 JSON（CONTRACTS_BASELINE §3）。

CREATE TABLE email_channels (
  user_id             TEXT PRIMARY KEY REFERENCES users (id),
  enabled             INTEGER NOT NULL DEFAULT 0,    -- 第一层：邮件席位（取消/撤回、重要更正、晚发现）（§7.5）
  routine_enabled     INTEGER NOT NULL DEFAULT 0,    -- 第二层：常规提醒，默认关闭、席位的子名额（§7.5）
  consent_version     INTEGER NOT NULL DEFAULT 0,    -- 保存同意版本（§7.5）
  address_version     INTEGER NOT NULL,              -- 新邮箱不继承同意（§7.5）
  lease_expires_at    INTEGER,                       -- 席位租期：有账号活动信号即自动续租（§9.4）
  last_renewed_at     INTEGER,
  last_renewed_reason TEXT,                          -- §8.1 必备字段：最近一次续租原因
  channel_revision    INTEGER NOT NULL DEFAULT 0,    -- CAS 版本列：两层同意的条件更新（P1-05/P4-05）
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  -- 第二层是第一层的子集（§7.5）：不允许出现 routine 开着、席位却关着的行。
  CHECK (routine_enabled = 0 OR enabled = 1)
);

-- 同意事件（两层各记同意，§8.1）。历史不可变，只追加。
CREATE TABLE consent_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id),
  email_binding_id  TEXT NOT NULL,          -- 同意绑定到邮箱绑定：换邮箱重新同意（§7.5）
  layer             TEXT NOT NULL,          -- seat | routine（§7.5 两层）
  action            TEXT NOT NULL,
  consent_version   INTEGER NOT NULL,
  context_json      TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_consent_events_user ON consent_events (user_id, created_at);
CREATE INDEX idx_consent_events_binding ON consent_events (email_binding_id, created_at);

-- 抑制：按准确地址关联（§7.7），不是 email_key（后者折叠本地大小写，覆盖面更宽）。
-- 只读抑制不能由应用解除；可变抑制也不自动删除（§7.7）。
CREATE TABLE suppressions (
  id                TEXT PRIMARY KEY,
  address_key       TEXT NOT NULL UNIQUE,   -- 精确地址的查找键（HMAC/规范化由 P1-06 定）
  email_binding_id  TEXT NOT NULL,
  kind              TEXT NOT NULL,          -- complaint / hard_bounce / …；精确清单属 P4-07
  read_only         INTEGER NOT NULL DEFAULT 0,
  reason            TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER                 -- 投诉通常无到期（§7.7）
);

CREATE INDEX idx_suppressions_expiry ON suppressions (expires_at) WHERE expires_at IS NOT NULL;
