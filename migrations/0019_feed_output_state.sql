-- P3-06 · 用户已授权从 0019 起编；P2-09 占 0018，合入时按实际顺序调整。
-- D3 §2.6 输出事实，不记录私人节点集合。保留期与逻辑 Feed 一致，账号删除随行清理。
ALTER TABLE calendar_feeds ADD COLUMN last_served_at INTEGER;
ALTER TABLE calendar_feeds ADD COLUMN last_guard_blocked_at INTEGER;
-- 令牌绑定签发时 epoch；旧行失败关闭，P3-07 enable/reset 显式写入用户当前 epoch。
ALTER TABLE calendar_feeds ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT -1;
ALTER TABLE calendar_feeds ADD COLUMN recovery_epoch INTEGER NOT NULL DEFAULT -1;
