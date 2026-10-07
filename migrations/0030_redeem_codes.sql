-- ADR-0030 · 米游社直播兑换码：事件类型增加 redeem_code，并保存「有效兑换码」条的兑换码。
-- 只进不退（ENGINEERING.md §6）。应用前按备份手册先做备份（docs/runbooks/backup-restore.md）。
--
-- SQLite 改不了已有的 CHECK 约束，events 只能重建；列、列序、默认值与其余约束不变，
-- 已发布事件的 ID、三类版本号、人工锁与时间戳原样保留。D1 不能关闭外键检查，做法是：
--   1. 推迟外键检查到本事务结束（defer_foreign_keys）；
--   2. 把全部行复制到暂存表；
--   3. 删除旧表——隐式删除让 milestones、candidates、evidence、event_revisions、calendar_projections、
--      occurrences 里引用它的行暂时成为"孤儿"，被推迟的违反计数增加；
--   4. 以原表名建新表，再把行插回——每插回一行，引用它的子行重新有了父行，计数相应减少，回到 0；
--   5. 删除暂存表、重建索引。事务提交时计数为 0，外键检查通过。
-- 子表按表名 events 引用父表，新表同名，引用照常生效。events 没有被 ON DELETE CASCADE 引用，
-- 也没有触发器或视图引用它（2026-10-07 核对 0001–0029）。
PRAGMA defer_foreign_keys = true;

CREATE TABLE events_rebuild_0030 AS SELECT * FROM events;

DROP TABLE events;

CREATE TABLE events (
  id                 TEXT PRIMARY KEY,
  game               TEXT NOT NULL,
  region             TEXT NOT NULL,
  event_type         TEXT NOT NULL CHECK (event_type IN ('livestream','maintenance','limited_event','gacha','redeem_code')),
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

INSERT INTO events (id, game, region, event_type, status, title, summary, official_url,
                    detail_path, event_revision, schedule_revision, human_locked,
                    first_published_at, created_at, updated_at)
SELECT id, game, region, event_type, status, title, summary, official_url,
       detail_path, event_revision, schedule_revision, human_locked,
       first_published_at, created_at, updated_at
  FROM events_rebuild_0030;

DROP TABLE events_rebuild_0030;

CREATE INDEX idx_events_catalog ON events (game, region, event_type, status);
CREATE INDEX idx_events_updated ON events (updated_at);

-- 「有效兑换码」条（ADR-0030）：官方直播页接口取得的兑换码。码、奖励说明与时刻照官方原样保存；
-- 不经审核，只按 contracts redeemCodeVisible 决定是否显示。日历里的兑换码事件另走文章版本与发布流程。
CREATE TABLE redeem_codes (
  source_id      TEXT NOT NULL REFERENCES sources (source_id),
  act_id         TEXT NOT NULL,      -- 官方直播活动 ID
  code           TEXT NOT NULL,
  game           TEXT NOT NULL,
  live_title     TEXT NOT NULL,
  reward         TEXT NOT NULL,      -- 奖励说明（官方 HTML 整理成的纯文本）
  revealed_at    INTEGER NOT NULL,   -- 官方发放时刻 to_get_time（UTC 毫秒）
  expires_at     INTEGER,            -- 官方说明写明的有效期截止；没写为 NULL
  expiry_text    TEXT,               -- 有效期原文；没写为 NULL
  live_closed_at INTEGER,            -- 本站观察到官方返回"活动已结束"的时刻
  first_seen_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (source_id, act_id, code),
  CHECK ((expires_at IS NULL) = (expiry_text IS NULL))
);

CREATE INDEX idx_redeem_codes_revealed ON redeem_codes (revealed_at);
