-- P1-04 · 数据组 13/14：反馈与用量（主方案 §8.1 第 13 组、§6.6、§7.5、§9.1；ADR-0003）
-- 反馈重复/乱序安全；预算原子；公平游标按池保存；遥测失败计数驱动回收暂停（§8.1 第 13 组约束）。

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

-- 预算账本（§9.1；ADR-0003 纯日额度模型）：settled + reserved + uncertain 均占可用预算。
-- 周期为 UTC 日（ADR-0003：每个 UTC 日独立，不跨日结转，不存在月度维度）。
-- 不建 envelope / carry / 片段列：envelope 平滑、carry 结转与 E=1 兜底已随 ADR-0003 废止
-- （AGENTS.md 禁止清单：恢复月度池/envelope/carry/E=1 兜底即不合格）。
-- period_kind 保留为显式列、当前唯一口径 'utc_day'——预算周期口径已经历
-- 账单周期→UTC 月→UTC 日三次 ADR 修订，显式 kind 让口径变化停留在数据层。
-- user_id 为空 = 池级行；非空 = 该用户的日限频计数行（每用户基础/紧急日机会分别限频）。
CREATE TABLE usage_periods (
  id                 TEXT PRIMARY KEY,
  pool               TEXT NOT NULL CHECK (pool IN ('existing_auth','new_registration','base_business','urgent_business')),
  period_kind        TEXT NOT NULL,          -- 当前唯一口径：utc_day
  period_key         TEXT NOT NULL,          -- 如 '2026-09-22'
  user_id            TEXT REFERENCES users (id),
  reserved           INTEGER NOT NULL DEFAULT 0,
  settled            INTEGER NOT NULL DEFAULT 0,
  uncertain          INTEGER NOT NULL DEFAULT 0,
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
