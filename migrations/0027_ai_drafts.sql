-- P3-17 / ADR-0009：AI 草稿只给人工审核预填，不是候选，不进发布路径；采用须管理员显式操作并留审计。
-- 每个候选至多一份草稿（candidate_id 为主键），网络失败重试覆盖同一行。草稿随候选长期保留，
-- 供审核与 P0-03b 质量复核；proposal_json 只含官方正文引文，不含用户数据。
CREATE TABLE ai_drafts (
  candidate_id       TEXT PRIMARY KEY REFERENCES candidates (id),
  article_version_id TEXT NOT NULL REFERENCES article_versions (id),
  profile_ref        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ready','invalid','failed','skipped')),
  attempts           INTEGER NOT NULL CHECK (attempts >= 0),
  proposal_json      TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
  notes_json         TEXT NOT NULL CHECK (json_valid(notes_json)),
  reason_code        TEXT,
  usage_json         TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 所有模型 profile 共用的 Workers AI 日账本（ADR-0009；以后 P3-09 复用，不碰邮件 usage_periods）。
-- 每个 UTC 日一行，年增约 365 行，作为计费对账证据长期保留、不清理。
-- Neurons 向上取整入账；调用前先预占 reserved，结束后转入 settled，失败与超时按整笔预占结算。
CREATE TABLE ai_usage_days (
  day        TEXT PRIMARY KEY CHECK (length(day) = 10),
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  settled    INTEGER NOT NULL DEFAULT 0 CHECK (settled >= 0),
  calls      INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at INTEGER NOT NULL
);
