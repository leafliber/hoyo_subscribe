-- P3-19 / ADR-0011：版本时间表。
-- game_version_suggestions：AI 草稿从版本公告里逐字核对后摘出的版本时间建议，不可变，按文章版本去重。
-- game_versions：管理员逐项确认后的版本时间；只有这里的值参与"X.Y版本更新后/版本结束"的确定性推导。
-- 每个游戏每个版本一行，年增十余行；作为推导依据长期保留，不清理。
CREATE TABLE game_version_suggestions (
  id                   TEXT PRIMARY KEY,
  game                 TEXT NOT NULL,
  region               TEXT NOT NULL,
  version              TEXT NOT NULL,
  article_version_id   TEXT NOT NULL REFERENCES article_versions (id),
  update_start_ms      INTEGER,
  update_start_json    TEXT CHECK (update_start_json IS NULL OR json_valid(update_start_json)),
  update_duration_json TEXT CHECK (update_duration_json IS NULL OR json_valid(update_duration_json)),
  version_end_ms       INTEGER,
  version_end_json     TEXT CHECK (version_end_json IS NULL OR json_valid(version_end_json)),
  created_at           INTEGER NOT NULL,
  UNIQUE (article_version_id, version)
);

CREATE INDEX idx_game_version_suggestions_version
  ON game_version_suggestions (game, region, version, created_at);

CREATE TABLE game_versions (
  game                TEXT NOT NULL,
  region              TEXT NOT NULL,
  version             TEXT NOT NULL,
  update_start_ms     INTEGER,
  update_start_source TEXT REFERENCES game_version_suggestions (id),
  version_end_ms      INTEGER,
  version_end_source  TEXT REFERENCES game_version_suggestions (id),
  version_end_basis   TEXT CHECK (version_end_basis IS NULL OR version_end_basis IN ('stated','next_update')),
  updated_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (game, region, version),
  CHECK ((update_start_ms IS NULL) = (update_start_source IS NULL)),
  CHECK ((version_end_ms IS NULL) = (version_end_basis IS NULL))
);
