-- P1-04 · 数据组 2/14：理解与事实（主方案 §8.1 第 2 组、§3.3、§3.4、§3.6）
-- 三类业务版本（event_revision / schedule_revision / public_ical_revision）是三个独立列，
-- 禁止合并成一个计数器（ENGINEERING.md §5.2、AGENTS.md 禁止清单）。
-- CHECK 约束只编码 packages/contracts 已枚举的取值集合（enums.ts 单一定义源），
-- 同步关系由 apps/worker/src/storage/schema.test.ts 的 A-P1-DB 用例校验。

-- 事件（身份不含日期，改期不换 ID，§3.3）。
CREATE TABLE events (
  id                 TEXT PRIMARY KEY,
  game               TEXT NOT NULL,
  region             TEXT NOT NULL,
  event_type         TEXT NOT NULL CHECK (event_type IN ('livestream','maintenance','limited_event','gacha')),
  status             TEXT NOT NULL CHECK (status IN ('scheduled','postponed','cancelled','retracted')),
  title              TEXT NOT NULL,
  summary            TEXT,
  official_url       TEXT,
  detail_path        TEXT,
  event_revision     INTEGER NOT NULL DEFAULT 0,   -- 版本量 1/3：事件任何修订（§3.6）
  schedule_revision  INTEGER NOT NULL DEFAULT 0,   -- 版本量 2/3：仅时刻或提醒语义变化（§3.6）
  human_locked       INTEGER NOT NULL DEFAULT 0,   -- 人工锁：保护字段只能通过带理由的操作修改（§3.6）
  first_published_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 公共目录按 (game, region, event_type, status) 缩小范围。
CREATE INDEX idx_events_catalog ON events (game, region, event_type, status);
CREATE INDEX idx_events_updated ON events (updated_at);

-- 节点（Milestone）。id 是稳定键，进入个人 ICS 的 UID（§6.4）。
-- 时间合同：只有日期不补成精确午夜（§3.3），时间精度与存值形态一一对应。
CREATE TABLE milestones (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES events (id),
  milestone_key        TEXT NOT NULL,       -- 同类阶段用稳定 milestone_key 区分（§3.3）
  node_type            TEXT NOT NULL CHECK (node_type IN ('start','end','phase_unlock','reward_deadline','expected_end','actual_end')),
  title                TEXT NOT NULL,
  time_exact_ms        INTEGER,             -- ExactTime（UTC 毫秒）
  time_date            TEXT,                -- DateOnly（YYYY-MM-DD）
  source_timezone      TEXT NOT NULL,
  raw_expression       TEXT NOT NULL,
  time_basis           TEXT NOT NULL CHECK (time_basis IN ('official_explicit','deterministic_derived','official_estimate','unresolved')),
  time_precision       TEXT NOT NULL CHECK (time_precision IN ('datetime','date','unknown')),
  public_ical_revision INTEGER NOT NULL DEFAULT 0,  -- 版本量 3/3：影响该节点日历表现的变更（§3.6、§6.4）
  human_locked         INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (event_id, milestone_key),
  CHECK (
    (time_precision = 'datetime' AND time_exact_ms IS NOT NULL AND time_date IS NULL)
    OR (time_precision = 'date' AND time_date IS NOT NULL AND time_exact_ms IS NULL)
    OR (time_precision = 'unknown' AND time_exact_ms IS NULL AND time_date IS NULL)
  )
);

-- 窗口查询（FEED_PAST_DAYS/FEED_FUTURE_DAYS 属 P3-06，schema 只保证可按时间缩范围）。
CREATE INDEX idx_milestones_exact ON milestones (time_exact_ms);
CREATE INDEX idx_milestones_date ON milestones (time_date);
CREATE INDEX idx_milestones_event ON milestones (event_id);

-- 抽取运行：模型版本可追溯（§8.1 第 2 组约束）。
-- (article_version, extractor, profile_ref) 唯一：同一组合成功结果可重放（§3.4）。
CREATE TABLE extraction_runs (
  id                 TEXT PRIMARY KEY,
  article_version_id TEXT NOT NULL REFERENCES article_versions (id),
  extractor          TEXT NOT NULL,         -- 规则 / 模型 / 人工 三路（§3.4）；取值属 P3-03
  profile_ref        TEXT NOT NULL,         -- prompt/schema/model_profile 组合引用
  status             TEXT NOT NULL,
  usage_json         TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error              TEXT,
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  UNIQUE (article_version_id, extractor, profile_ref)
);

CREATE INDEX idx_extraction_runs_article ON extraction_runs (article_version_id);

-- 候选：统一来源/证据/时间校验后原子发布（§3.4）。
-- run_id 可空：人工路径不依赖先取得一次模型结果（§3.4）。
CREATE TABLE candidates (
  id              TEXT PRIMARY KEY,
  run_id          TEXT REFERENCES extraction_runs (id),
  event_id        TEXT REFERENCES events (id),   -- 修正已有事件时的目标
  proposal_json   TEXT NOT NULL CHECK (json_valid(proposal_json)),
  review_status   TEXT NOT NULL CHECK (review_status IN ('pending','approved','rejected')),
  reviewer        TEXT,
  decided_at      INTEGER,
  decision_reason TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 审核队列：先缩小状态范围。
CREATE INDEX idx_candidates_review_queue ON candidates (review_status, created_at);

-- 证据：候选/事件/节点对正文证据块的引用（§3.4）。
CREATE TABLE evidence (
  id                 TEXT PRIMARY KEY,
  candidate_id       TEXT REFERENCES candidates (id),
  event_id           TEXT REFERENCES events (id),
  milestone_id       TEXT REFERENCES milestones (id),
  article_version_id TEXT NOT NULL REFERENCES article_versions (id),
  block_ref          TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  CHECK (candidate_id IS NOT NULL OR event_id IS NOT NULL OR milestone_id IS NOT NULL)
);

CREATE INDEX idx_evidence_candidate ON evidence (candidate_id);
CREATE INDEX idx_evidence_event ON evidence (event_id);
CREATE INDEX idx_evidence_article_version ON evidence (article_version_id);

-- 不可变修订历史（§3.6：一次条件提交写入不可变修订）。
CREATE TABLE event_revisions (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events (id),
  revision_no  INTEGER NOT NULL,
  change_kind  TEXT NOT NULL,               -- 取值属 P3-04
  actor_path   TEXT NOT NULL,               -- rule / model / manual（§3.4）
  reason       TEXT,
  diff_json    TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  created_at   INTEGER NOT NULL,
  UNIQUE (event_id, revision_no)
);

CREATE INDEX idx_event_revisions_event ON event_revisions (event_id, revision_no);
