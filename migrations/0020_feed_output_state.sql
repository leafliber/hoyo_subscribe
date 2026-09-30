-- P3-06 · P2-09 占 0018，P4-03 先合入占 0019，本卡按实际顺序使用 0020。
-- D3 §2.6 输出事实，不记录私人节点集合。保留期与逻辑 Feed 一致，账号删除随行清理。
ALTER TABLE calendar_feeds ADD COLUMN last_served_at INTEGER;
ALTER TABLE calendar_feeds ADD COLUMN last_guard_blocked_at INTEGER;
-- 令牌绑定签发时 epoch；旧行失败关闭，P3-07 enable/reset 显式写入用户当前 recovery_epoch。
ALTER TABLE calendar_feeds ADD COLUMN recovery_epoch INTEGER NOT NULL DEFAULT -1;

-- 整代条目数清单用于发现缺行；存量代次在迁移时建立一次清单。
ALTER TABLE public_snapshots ADD COLUMN node_count INTEGER;
UPDATE public_snapshots SET node_count = (SELECT COUNT(*) FROM public_snapshot_nodes WHERE snapshot_id = public_snapshots.id);
-- P3-07 可直接读取最新输出诊断；不含 token、节点集合或个人 URL。
ALTER TABLE calendar_feeds ADD COLUMN last_output_diagnostic TEXT;
ALTER TABLE calendar_feeds ADD COLUMN last_output_at INTEGER;

-- P3-06 第三轮授权：成功输出的整集合自然退出上界；旧行无证据时不猜测回填。
ALTER TABLE calendar_feeds ADD COLUMN last_served_natural_exit_at INTEGER;
