-- P1-04 · 数据组 13/14：反馈与用量（主方案 §8.1 第 13 组、§6.6、§7.5、§9.1、§9.2）
-- 反馈重复/乱序安全；预算原子；carry 持久化以免 floor 吞额度；公平游标按池保存；
-- 遥测失败计数驱动回收暂停（§8.1 第 13 组约束）。

-- 邮件反馈：只通过受控 Queue 消费（§7.5）。
-- provider_event_id 唯一 → 重复反馈安全；乱序由 message_id / mail_outbox_id 关联兜底。
CREATE TABLE mail_feedback (
  id                TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL UNIQUE,    -- provider eventId 去重（§7.5）
  message_id        TEXT,                    -- messageId 关联（§7.5）
  mail_outbox_id    TEXT,                    -- 先于结果到达的反馈有限保留：关联可为空（§7.5）
  kind              TEXT NOT NULL,           -- deferred / bounced / complained / delivered …（§7.5）
  feedback_at       INTEGER NOT NULL,
  raw_ref           TEXT,                    -- 原始反馈的脱敏引用，正文不进公共日志（§7.5）
  created_at        INTEGER NOT NULL
);

-- 反馈 ID 访问路径（§8.1）。
CREATE INDEX idx_mail_feedback_message ON mail_feedback (message_id);
CREATE INDEX idx_mail_feedback_outbox ON mail_feedback (mail_outbox_id);

-- 预算账本（§9.1、§9.2）：settled + reserved + uncertain 均占可用预算。
-- period_kind 实际取值（UTC 月池 / UTC 日硬计数）与周期口径由 P1-07 账本写入；
-- 周期键设计为显式列，账单周期口径若再调整（ADR-0002 状态为"提议"）不需改 schema。
-- user_id 为空 = 池级行；非空 = 该用户日限频计数行（§9.1：每用户基础/紧急日机会分别限频）。
CREATE TABLE usage_periods (
  id                 TEXT PRIMARY KEY,
  pool               TEXT NOT NULL CHECK (pool IN ('existing_auth','new_registration','base_business','urgent_business')),
  period_kind        TEXT NOT NULL,
  period_key         TEXT NOT NULL,          -- 如 '2026-09' / '2026-09-22'
  user_id            TEXT REFERENCES users (id),
  reserved           INTEGER NOT NULL DEFAULT 0,
  settled            INTEGER NOT NULL DEFAULT 0,
  uncertain          INTEGER NOT NULL DEFAULT 0,
  envelope           INTEGER,                -- §9.2 基础池片段 envelope（E）；紧急池与认证池不做 envelope（§9.2）
  carry              REAL NOT NULL DEFAULT 0,   -- §9.2 小数余额持久化：floor 才不会吞掉额度；仅未被日硬上限截断的部分累积
  fragment_key       TEXT,                   -- 当前片段（UTC 日）；月末半日片段口径随周期定义走
  fragment_approved  INTEGER NOT NULL DEFAULT 0,  -- 本片段已批准且未释放的占用（§9.2：片段可批准 = E − 本列）
  period_start       INTEGER NOT NULL,
  period_end         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 一池一周期一主体（用户为空归一）：并发预占的条件更新都落在同一行上。
CREATE UNIQUE INDEX idx_usage_periods_identity
  ON usage_periods (pool, period_kind, period_key, ifnull(user_id, ''));
-- 历史周期归档清理。
CREATE INDEX idx_usage_periods_period_end ON usage_periods (period_end);

-- 公平游标（§7.3）：每个优先级/预算池单独保存，不随日或发生项重置。
-- 游标在"批准一次发送尝试"时推进；unknown/失败也算已获得本轮机会。
CREATE TABLE dispatch_cursors (
  pool           TEXT NOT NULL,
  priority       INTEGER NOT NULL,
  last_order     INTEGER NOT NULL,           -- users."order" 游标
  completed_lap  INTEGER NOT NULL DEFAULT 0, -- 完整圈数标记
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (pool, priority)
);

-- 活动水位写入失败计数（§6.6）：该指标与 RECLAIM_TELEMETRY_STALE_HOURS 共同驱动
-- "全局暂停账号与席位回收"。被设计成可静默失败的写入不能单独决定删不删账号。
CREATE TABLE activity_write_failures (
  metric           TEXT NOT NULL,            -- 如 feed_poll_merge
  utc_day          TEXT NOT NULL,
  failures         INTEGER NOT NULL DEFAULT 0,
  last_success_at  INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (metric, utc_day)
);
