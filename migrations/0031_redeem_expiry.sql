-- ADR-0034 · 兑换码截止时间的管理员登记，以及本站核对时官方不再列出某个兑换码的时刻。
-- 只进不退（ENGINEERING.md §6）。只新增一列（可空）与一张表，不改写、不重建已有数据。

-- 本站核对官方兑换码列表时，发现其中不再有这个兑换码的时刻；仍列出为 NULL（官方重新列出时清回 NULL）。
-- 没有截止时间的兑换码据此从「有效兑换码」条移除（contracts redeemCodeVisible）。
ALTER TABLE redeem_codes ADD COLUMN gone_at INTEGER;

-- 管理员照官方说明登记的兑换码截止时间：每场直播一行，优先于官方兑换码说明里认出的有效期。
-- 首页条直接读它；日历由下一次采集写进该直播的正文，再经规则模板发布"兑换码过期"节点。
CREATE TABLE redeem_live_expiry (
  source_id   TEXT NOT NULL REFERENCES sources (source_id),
  act_id      TEXT NOT NULL,      -- 官方直播活动 ID
  expires_at  INTEGER NOT NULL,   -- 截止时刻（UTC 毫秒）
  expression  TEXT NOT NULL,      -- 写进正文的写法"YYYY/MM/DD HH:MM(:SS)"（北京时间）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,   -- 条件写入的版本
  PRIMARY KEY (source_id, act_id)
);
