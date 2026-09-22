-- P1-04 · 数据组 11/14：后台任务、发布 outbox 与通知发生项（主方案 §8.1 第 11 组、§3.6、§7.1、§7.3、§7.4）
-- 事件发布与 outbox 一致；游标与本页展开一致（§8.1 第 11 组约束）。
-- P0-01 已实测（docs/evidence/p0/d1-conditional-tx-20260921T165034Z.json）：
-- D1 batch 对 SQL 错误回滚、对 CAS 零行不回滚——因此任务与租约必须携带可条件化的版本列，
-- 由 P1-05 的统一条件守卫保证"整批一起成立或一起失败"。

-- 通用后台任务（Cron 修复缺失 alarm 与过期租约，§7.4）。
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  due_at           INTEGER NOT NULL,
  status           TEXT NOT NULL,            -- pending / leased / done / failed 属执行器约定（§7.4）
  lease_version    INTEGER NOT NULL DEFAULT 0,  -- 任务领取带 lease_version（§7.4）；CAS 列
  lease_owner      TEXT,
  lease_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

-- 任务到期（§8.1 访问路径）：先缩小状态范围再按到期时间取。
CREATE INDEX idx_jobs_due ON jobs (status, due_at);
-- 过期租约修复（§7.4）。
CREATE INDEX idx_jobs_lease_expiry ON jobs (lease_expires_at);

-- 事实发布副作用 outbox（§3.6：一次条件提交同时更新 Event/投影与 outbox）。
-- 邮件发送意图在 mail_outbox（0012），两者不共用。
CREATE TABLE outbox (
  id             TEXT PRIMARY KEY,
  topic          TEXT NOT NULL,              -- 如 snapshot_rebuild / projection_refresh
  dedupe_key     TEXT NOT NULL UNIQUE,       -- 幂等
  payload_json   TEXT NOT NULL CHECK (json_valid(payload_json)),
  dispatch_state TEXT NOT NULL,              -- pending / dispatched 属执行器约定
  created_at     INTEGER NOT NULL,
  dispatched_at  INTEGER
);

CREATE INDEX idx_outbox_dispatch ON outbox (dispatch_state, created_at);

-- 通知发生项（§7.1）：不含用户或设备；到期才匹配当前兴趣。
CREATE TABLE occurrences (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL REFERENCES events (id),
  milestone_id           TEXT NOT NULL REFERENCES milestones (id),
  schedule_revision      INTEGER NOT NULL,   -- 官方改期 +1 后旧发生项失效（§7.1）
  kind                   TEXT NOT NULL,      -- rule_id 或 new_event / important_change / cancelled_or_retracted / late_discovery（§7.1、§7.2）
  due_at                 INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,   -- 过期候选留下 skipped/expired 原因，不次月追发（§7.3）
  audience_upper_order   INTEGER,            -- 冻结本轮受众 order 上界（§7.3）
  backfill               INTEGER NOT NULL DEFAULT 0,  -- 首次历史导入标记 backfill，不伪装成新发现群发（§7.2）
  invalidated_at         INTEGER,
  created_at             INTEGER NOT NULL,
  UNIQUE (milestone_id, schedule_revision, kind)
);

-- 任务到期：未失效发生项按到期时间展开（§8.1 访问路径）。
CREATE INDEX idx_occurrences_due ON occurrences (due_at) WHERE invalidated_at IS NULL;
-- 清理时间。
CREATE INDEX idx_occurrences_expiry ON occurrences (expires_at);
-- 改期失效排查：按事件与计划版本定位旧发生项。
CREATE INDEX idx_occurrences_event ON occurrences (event_id, schedule_revision);
