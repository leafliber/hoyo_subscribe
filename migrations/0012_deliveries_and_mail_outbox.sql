-- P1-04 · 数据组 12/14：实际发送（主方案 §8.1 第 12 组、§7.3、§7.4、§9.1）
-- NOT NULL 逻辑唯一键；跨普通/晚发现去重；一封合并邮件对应多条 Delivery，各自保留去重键；
-- 发送前复核（§8.1 第 12 组约束）。
-- priority 数值即 §7.3 优先级阶梯的顺序编码（值小者优先）：
--   0=认证邮件（最高，§7.4）；1=取消/撤回；2=重要更正；3=晚发现；4=常规提前提醒；5=新事件公布。

-- MailOutbox：记录"实际哪封信"（§7.4）；同一用户同批次候选合并为一个意图（§7.3）。
CREATE TABLE mail_outbox (
  id                 TEXT PRIMARY KEY,
  purpose            TEXT NOT NULL,          -- 四池用途（§9.1）：existing_auth / new_registration / base_business / urgent_business
  priority           INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 5),
  period_key         TEXT NOT NULL,          -- 计费周期键（周期口径见 ADR-0002；实际取值由 P1-07 账本写入）
  recipient_user_id  TEXT REFERENCES users (id),
  email_binding_id   TEXT,
  address_version    INTEGER NOT NULL,       -- 发送前复核投递地址版本（§7.1）
  payload_kind       TEXT NOT NULL,          -- 模板引用 / 受控密文（认证发信载荷加密，§4.3）
  payload_ref        TEXT,
  payload_ciphertext BLOB,                   -- 短期 OTP 发信载荷的受控密文（§4.3）
  status             TEXT NOT NULL CHECK (status IN ('pending','leased','calling_provider','accepted','retry_wait','unknown','deferred','bounced','failed','complained','rejected','skipped','superseded','expired')),
  message_id         TEXT,                   -- 平台返回 messageId（§7.5 反馈关联）
  lease_version      INTEGER NOT NULL DEFAULT 0,   -- 租约 CAS：HTTP 快速路径与后台领取同一租约、不重复外发（§7.4）
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  attempts           INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT UNIQUE,            -- 网络重试幂等（§7.4 不假定供应商幂等键）
  sent_at            INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 发送状态/优先级（§8.1 访问路径）：领取与复核按状态+优先级缩范围。
CREATE INDEX idx_mail_outbox_claim ON mail_outbox (status, priority, created_at);
-- 过期租约修复（§7.4）。
CREATE INDEX idx_mail_outbox_lease ON mail_outbox (lease_expires_at);
-- messageId 反馈关联唯一。
CREATE UNIQUE INDEX idx_mail_outbox_message_id
  ON mail_outbox (message_id) WHERE message_id IS NOT NULL;

-- Delivery：记录"通知谁"（§7.4）。
-- dedupe_family = (node, schedule_revision, rule_id, channel, target) 的规范串（§7.2）：
-- 正常提前提醒与晚发现共享同一族，同一逻辑提醒不因换名称重复发送。
-- 一封合并邮件（mail_outbox 一条）可对应多条 Delivery，各自保留去重键（§7.3、§8.1）。
CREATE TABLE deliveries (
  id                TEXT PRIMARY KEY,
  occurrence_id     TEXT NOT NULL REFERENCES occurrences (id),
  user_id           TEXT NOT NULL REFERENCES users (id),
  channel           TEXT NOT NULL,           -- email | push
  target_ref        TEXT NOT NULL,           -- 邮件=user_id；Push=binding_id（§7.1）
  milestone_id      TEXT NOT NULL REFERENCES milestones (id),
  schedule_revision INTEGER NOT NULL,
  rule_id           TEXT,                    -- 提前提醒规则；变更类通知为空
  kind              TEXT NOT NULL,           -- rule / new_event / important_change / cancelled_or_retracted / late_discovery（§7.2）
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  dedupe_family     TEXT NOT NULL UNIQUE,    -- NOT NULL 逻辑唯一键（§8.1 第 12 组约束）
  mail_outbox_ref   TEXT REFERENCES mail_outbox (id),  -- 一封合并邮件对应多条 Delivery（§7.3）
  status            TEXT NOT NULL CHECK (status IN ('pending','leased','calling_provider','accepted','retry_wait','unknown','deferred','bounced','failed','complained','rejected','skipped','superseded','expired')),
  skip_reason       TEXT,                    -- skipped / superseded / expired 的原因（§7.3）
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 发送状态/优先级（§8.1 访问路径）。
CREATE INDEX idx_deliveries_status ON deliveries (status, priority, expires_at);
-- 合并邮件反向追溯。
CREATE INDEX idx_deliveries_outbox ON deliveries (mail_outbox_ref);
-- 所有者维度（§8.1 访问路径）。
CREATE INDEX idx_deliveries_owner ON deliveries (user_id, created_at);
-- 清理时间。
CREATE INDEX idx_deliveries_expiry ON deliveries (expires_at);
-- 去重族查询的辅助索引（唯一性由 dedupe_family UNIQUE 保证；
-- 组合键不设 UNIQUE：rule_id 可空，SQLite UNIQUE 对 NULL 不判重）。
CREATE INDEX idx_deliveries_dedupe_components
  ON deliveries (milestone_id, schedule_revision, rule_id, channel, target_ref);
