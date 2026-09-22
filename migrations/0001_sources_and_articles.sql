-- P1-04 · 数据组 1/14：来源与正文（主方案 §8.1 第 1 组、§3.1、§3.2）
-- 只进不退：本文件发布后不得修改，后续变更新增编号更大的迁移（ENGINEERING.md §6）。
-- 时间口径：INTEGER = ExactTime（UTC 毫秒），TEXT 'YYYY-MM-DD' = DateOnly，两者不互转（§5.1）。

-- 来源注册项（§3.1）。取值（game/region/adapter/verification_state）由来源登记决定，
-- 不在本迁移里枚举；P0-02 草案见 fixtures/sources/registry.draft.json。
CREATE TABLE sources (
  source_id              TEXT PRIMARY KEY,
  game                   TEXT NOT NULL,
  region                 TEXT NOT NULL,
  adapter                TEXT NOT NULL,
  approved_hosts_json    TEXT NOT NULL CHECK (json_valid(approved_hosts_json)),
  verified_publishers_json TEXT NOT NULL CHECK (json_valid(verified_publishers_json)),
  cursor_json            TEXT NOT NULL CHECK (json_valid(cursor_json)),
  poll_policy_json       TEXT NOT NULL CHECK (json_valid(poll_policy_json)),
  verification_state     TEXT NOT NULL,
  last_success_at        INTEGER,            -- 来源侧新鲜度水位分量（§6.5）
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_sources_game_region ON sources (game, region);

-- 文章身份：(source_id, external_id) 唯一（§3.2）；上游 ID 存字符串（§3.1）。
CREATE TABLE articles (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources (source_id),
  external_id     TEXT NOT NULL,
  official_url    TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,          -- 近期公告复查正文（§3.2）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);

-- 近期复查扫描：按来源缩小范围再按时间过滤。
CREATE INDEX idx_articles_source_last_checked ON articles (source_id, last_checked_at);

-- 语义内容变化才新增不可变 ArticleVersion（§3.2）。
-- 同一 (article_id, content_hash) 唯一：重复抓到相同内容不产生新版本。
CREATE TABLE article_versions (
  id                    TEXT PRIMARY KEY,
  article_id            TEXT NOT NULL REFERENCES articles (id),
  version_no            INTEGER NOT NULL,
  content_hash          TEXT NOT NULL,
  body_blocks_json      TEXT NOT NULL CHECK (json_valid(body_blocks_json)),
  media_refs_json       TEXT NOT NULL CHECK (json_valid(media_refs_json)),
  completeness          TEXT NOT NULL,       -- 完整性状态；取值属 P3-02
  official_published_at INTEGER,             -- 官方发布时间（非列表展示时间，§3.1）
  fetched_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (article_id, version_no),
  UNIQUE (article_id, content_hash)
);

CREATE INDEX idx_article_versions_article ON article_versions (article_id, version_no);

-- 正文版本不可变（§8.1 第 1 组约束）。任何 UPDATE 一律拒绝；勘误只能新增版本。
CREATE TRIGGER trg_article_versions_immutable
BEFORE UPDATE ON article_versions
BEGIN
  SELECT RAISE (ABORT, 'article_versions 不可变：正文版本只允许新增（主方案 §8.1）');
END;
