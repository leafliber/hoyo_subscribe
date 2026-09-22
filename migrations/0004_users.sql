-- P1-04 · 数据组 4/14：用户（主方案 §8.1 第 4 组、§4.1、§9.4）
-- 所有私有对象通过不可变 user_id 归属（§8.1）。
-- email_key 唯一；实际投递地址不可由普通登录请求改写（P2-03 的写路径职责，schema 提供唯一键与地址版本）。

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  "order"               INTEGER NOT NULL UNIQUE,  -- 受众扫描顺序：只服务公平完整扫描，不代表发送优先级（§7.3）
  status                TEXT NOT NULL,            -- 活动与回收状态（§8.1）；取值属 P5-02 生命周期业务
  email_key             TEXT NOT NULL UNIQUE,     -- HMAC(lookup_key, canonical_email)（§4.1）
  email_binding_id      TEXT NOT NULL UNIQUE,     -- 不可变邮箱绑定；退订 token 绑定它（§7.6）
  email_ciphertext      BLOB NOT NULL,            -- 加密的已验证实际投递地址（§4.1，受控密文）
  email_version         INTEGER NOT NULL,         -- 地址版本；消费时核对（§4.1）
  auth_epoch            INTEGER NOT NULL DEFAULT 0,
  recovery_epoch        INTEGER NOT NULL DEFAULT 0,
  -- 账号活动水位（§9.4）：max(last_interactive_at, last_feed_poll_at, last_push_processed_at)，
  -- 低频合并写入，不每 GET 写 last_seen。
  last_interactive_at   INTEGER,
  last_feed_poll_at     INTEGER,
  last_push_processed_at INTEGER,
  reclaim_grace_until   INTEGER,                  -- 回收宽限（§9.4）
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- 受众展开 / keyset 分页：先缩小状态范围，再按 order 游标推进（§7.3、§8.1 访问路径"分页 order"）。
CREATE INDEX idx_users_status_order ON users (status, "order");
