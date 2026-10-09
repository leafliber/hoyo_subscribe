-- ADR-0034 第 7 条 · 一次性清理（所有者 2026-10-09 决定）：删除绝区零 3.3 前瞻兑换码事件"兑换码发放"节点上
-- 那条错误的公开改期更正（官方把预告发放时刻 19:49 改成实际发放时刻 19:43:30 产生），并请求重建一次公共快照。
--
-- 只动这一行更正：条件写死节点、种类与旧/新时刻，对不上就什么也不删。事件、节点、修订历史与通知都不改。
-- 每条语句都可重复执行：再跑一次不会多删、不会重复记审计或重复排重建。中途失败也不会留下坏状态：
-- 已删掉的更正会在下一次任何公共快照重建时从页面消失；"待重建"标记只在重建请求确实待处理时才打开。
-- 重建由 Cron 看门狗（每 10 分钟）完成：快照里这个节点不再带更正，详情页、首页"近期变更"与日历订阅随之不再显示。
--
-- 时刻用 julianday 换算成 UTC 毫秒；审计保留期 = ADMIN_AUDIT_TTL（15,552,000 秒，180 天）。

DELETE FROM calendar_patches
 WHERE milestone_id = '3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88'
   AND patch_kind = 'rescheduled'
   AND old_time_exact_ms = 1791546540000
   AND new_time_exact_ms = 1791546210000;

INSERT OR IGNORE INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, reason,
    detail_ref, created_at, expires_at)
  SELECT 'adr0034-redeem-reschedule-cleanup-2026-10-09', 'admin', 'owner-console',
         'calendar_patch_withdraw', 'milestone',
         '3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88', 'evidence_reviewed',
         'docs/adr/0034-redeem-expiry-and-status-checks.md#7', now_ms, now_ms + 15552000000
    FROM (SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now_ms);

INSERT OR IGNORE INTO outbox (id, topic, dedupe_key, payload_json, dispatch_state, created_at,
    dispatched_at)
  SELECT 'adr0034-redeem-reschedule-cleanup-2026-10-09', 'snapshot_rebuild',
         'manual:adr0034-redeem-reschedule-cleanup-2026-10-09',
         '{"event_ids":["e55afff692f1118b5bfa41a8af258c6b4757dfe2db30cbd8d930b24b0003b8bf"],"reason":"calendar_patch_withdraw"}',
         'pending', now_ms, NULL
    FROM (SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now_ms);

-- 只在上面那条重建请求仍待处理时才标"待重建"：重建器要求待重建时必须有待处理的请求，
-- 重建完成后再跑本文件不会把标记重新打开。
INSERT INTO system_state (key, value_json, updated_at)
  SELECT 'public_snapshot_pending', '{"pending":true}', now_ms
    FROM (SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now_ms)
   WHERE EXISTS (SELECT 1 FROM outbox
                  WHERE dedupe_key = 'manual:adr0034-redeem-reschedule-cleanup-2026-10-09'
                    AND dispatch_state = 'pending')
  ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
