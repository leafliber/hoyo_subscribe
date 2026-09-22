-- P1-04 · 数据组 9/14：Feed（主方案 §8.1 第 9 组、§6.1、§6.4、§6.5、§6.6）
-- 每用户一个逻辑 Feed；重置不清版本；last_served_* 供 §6.5 缩水守卫比对；
-- 所有者取回 URL 的 API 单独保护（§8.1 第 9 组约束）。
-- token_hash 常态校验 + token_ciphertext 受控密文：长期凭证"只存 hash"的明示例外（§6.1）。

CREATE TABLE calendar_feeds (
  user_id                     TEXT PRIMARY KEY REFERENCES users (id),
  namespace                   TEXT NOT NULL UNIQUE,   -- 不含用户身份的随机公开 namespace，进入 UID（§6.4）
  state                       TEXT NOT NULL,          -- 启用/停用状态机属 P3-06/P3-07
  token_hash                  TEXT NOT NULL UNIQUE,   -- 当前 token 校验值；轮换/停用后旧 token 失效
  token_ciphertext            BLOB NOT NULL,          -- 供所有者再次复制同一地址（§6.1）
  token_generation            INTEGER NOT NULL DEFAULT 0,  -- 每次换 token +1；重置不清版本（§6.1）
  view_revision               INTEGER NOT NULL DEFAULT 0,  -- 仅影响 ICS 的用户设置变化才 +1（§5.4、§6.4）
  changed_at                  INTEGER NOT NULL,
  last_feed_poll_at           INTEGER,                -- 活动水位；每 FEED_ACTIVITY_WRITE_INTERVAL 最多写一次（§6.6）
  -- §6.5 缩水守卫三要素：上次成功返回的条目数、当时 view_revision、公共发布代次。
  last_served_node_count      INTEGER,
  last_served_view_revision   INTEGER,
  last_served_generation      INTEGER,
  token_rotated_at            INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

-- 活动水位扫描（回收判定输入之一，§9.4）。
CREATE INDEX idx_calendar_feeds_poll ON calendar_feeds (last_feed_poll_at);

-- namespace 不随换 token / 停用重启用 / 部署变化而改变（§6.1、§6.4：重置不清版本、不重置 namespace）。
CREATE TRIGGER trg_calendar_feeds_namespace_immutable
BEFORE UPDATE OF namespace ON calendar_feeds
WHEN OLD.namespace <> NEW.namespace
BEGIN
  SELECT RAISE (ABORT, 'calendar_feeds.namespace 不随换 token/重置改变（主方案 §6.1/§6.4）');
END;
