# 一次性清理：删除 2026-10-09 兑换码事件那条错误的改期（ADR-0034 第 7 条）

所有者在自己终端执行。只删正式 D1 里的一行公开更正（`calendar_patches`），再请求重建一次公共快照；
事件、节点、修订历史与已发出的通知都不改。不依赖 ADR-0034 的代码部署，部署前后都可以做。

| 项 | 值 |
| --- | --- |
| 事件 | `e55afff692f1118b5bfa41a8af258c6b4757dfe2db30cbd8d930b24b0003b8bf`（《绝区零》3.3版本前瞻特别节目兑换码） |
| 节点 | `3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88`（兑换码发放） |
| 要删的更正 | `rescheduled`，旧 `1791546540000`（2026/10/09 19:49）→ 新 `1791546210000`（19:43:30） |
| SQL | [`redeem-reschedule-cleanup-2026-10-09.sql`](redeem-reschedule-cleanup-2026-10-09.sql)（条件写死，可重复执行） |
| 验证 | `apps/worker/src/executors/pipeline/live-pipeline.test.ts`「ADR-0034 第 7 条」：用真实活动 ID 复现同一事件与节点 ID、同一条更正，原样执行这份 SQL，看门狗重建后详情与近期变更不再有改期；再执行一次无副作用；时刻对不上的更正不删 |

每条命令都在主检出的 `apps/worker` 目录、带私有部署配置执行（值不要发出来）：

```bash
: "${P504_DEPLOY_CONFIG:?需要私有部署配置}"
```

## 1. 记下 Time Travel 书签（出问题时可按书签恢复）

```bash
WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler d1 time-travel info DB --config "$P504_DEPLOY_CONFIG"
```

## 2. 只读核对（清理前）

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler d1 execute DB --remote --config "$P504_DEPLOY_CONFIG" --command "SELECT id, patch_kind, old_time_exact_ms, new_time_exact_ms, superseded_at, retain_until FROM calendar_patches WHERE milestone_id = '3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88'"
```

应恰好一行：`rescheduled`、`1791546540000` → `1791546210000`、`superseded_at` 为空。不是这样就停下，不要执行第 3 步。把这一行的输出留着（回退时要用）。

这次改期有没有发出通知（清理不撤回已发出的通知，只用于如实记录）：

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler d1 execute DB --remote --config "$P504_DEPLOY_CONFIG" --command "SELECT kind, channel, status, COUNT(*) AS n FROM deliveries WHERE milestone_id = '3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88' GROUP BY kind, channel, status"
```

## 3. 执行清理

```bash
WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler d1 execute DB --remote --config "$P504_DEPLOY_CONFIG" --file <仓库路径>/docs/runbooks/redeem-reschedule-cleanup-2026-10-09.sql
```

wrangler 提示远端执行文件时会短暂占用数据库，确认即可（四条语句，毫秒级）。

## 4. 核对

立即（只读）：更正已删、重建请求已排上。

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler d1 execute DB --remote --config "$P504_DEPLOY_CONFIG" --command "SELECT COUNT(*) AS patches FROM calendar_patches WHERE milestone_id = '3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88'; SELECT dispatch_state FROM outbox WHERE dedupe_key = 'manual:adr0034-redeem-reschedule-cleanup-2026-10-09'; SELECT value_json FROM system_state WHERE key = 'public_snapshot_pending'"
```

应为 `patches = 0`、`pending`、`{"pending":true}`。

等下一次 Cron 看门狗（每 10 分钟）重建公共快照后，公开接口里不再有改期：

```bash
curl -sS https://hoyo.airo.cc/api/v2/events/e55afff692f1118b5bfa41a8af258c6b4757dfe2db30cbd8d930b24b0003b8bf | python3 -I -c 'import json,sys; e=json.load(sys.stdin)["event"]; print("changes:", len(e["changes"]), [(m.get("change") or {}).get("kind") for m in e["milestones"]])'
```

清理前输出 `changes: 1 ['rescheduled']`（2026-10-09 21:0x 实测），清理并重建后应为 `changes: 0 [None]`。上面的 `outbox` 随之变为 `dispatched`、标记变回 `{"pending":false}`。

## 执行记录

- 2026-10-09 所有者按本手册执行。
- 2026-10-09 13:11 UTC 公开接口只读核对：事件详情 `publication.generation` 由 20 变为 21，`changes: 0 [None]`；`/api/v2/events?range=7d&games=zzz` 的 `recentChanges` 为空。

## 回退

清理只删了一行更正、记了一条审计、排了一次重建。若要恢复那条更正：按第 2 步留下的输出把该行原样插回 `calendar_patches`，再照第 3 步文件里后两条语句的写法（换一个新的 `dedupe_key`）排一次重建；或按第 1 步的书签用 Time Travel 恢复（会连同书签之后的所有写入一起退回，一般不需要）。
