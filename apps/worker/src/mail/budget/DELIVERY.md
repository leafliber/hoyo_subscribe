## 任务卡
P4-04 · 预算池执行 · 阶段 P4

前置 P4-03 PR #38 已于 2026-09-30 合入（`a1b6084`）。本分支为 `p4/P4-04-mail-budget`，工作树独立于主工作区；继续任务时快进至 `origin/main` 的 `1a6f41d`（包含 P3-06）。未修改主工作区。

## 改动范围
- `apps/worker/src/mail/budget/dispatch.ts`：预算与 P4-02 批准计划的原子组合。
- `apps/worker/src/mail/budget/rollover.ts`：旧日未调用预留撤回、意图保留、新日重占与等待过期。
- `apps/worker/src/mail/budget/rejected.ts`：已外调明确可重试拒绝的一次计数及到期收尾。
- `apps/worker/src/mail/budget/budget.test.ts`、`test-support.ts`：合成 D1/邮件替身测试和读量基准。
- `apps/worker/src/mail/budget/README.md`、`DELIVERY.md`、`evidence/**`：交接、报告和实际命令证据。
- `apps/worker/src/executors/delivery/dispatch.ts`、`runtime.ts`：新增业务批次、预算维护及持久 alarm 接线；新增阶段独立退避，保留原发送器和超时份额。
- `apps/worker/src/executors/delivery/runtime.test.ts`：补强 failed 起步下一轮不再读取的断言。
- `apps/worker/src/storage/ledger/mail-ledger.ts`：按卡末 2026-09-30 裁定补授权，只抽出并导出三个纯构造，原入口调用它们；文件头说明理由。原账本测试文件未改。

未修改 P4-02 文件、P4-03 发送器/模板、contracts 参数、任务卡或验收方维护的文档。无新增迁移，无编号争用；当前基线含 0001–0020。新增热查询基准放在获准的 budget 测试目录，未额外修改 `storage/schema.test.ts`。

## 继承的合同
主方案 §9.1–§9.3、附录 A.4/A.5，CONTRACTS_BASELINE §7，ADR-0003；批准/合并遵循 §7.3，状态与不可盲重发遵循 §7.4，发送故障门遵循 §2.3。工程依据 ENGINEERING §5.4、§5.6，及本卡 P4-02/P4-03 交接和 2026-09-30 裁定。

解释与决定：
1. 旧正文中的月池、月末半日、envelope、carry 已被 ADR-0003 明确替换。本卡只实现固定 UTC 日桶，保留旧日 settled/uncertain 供对账，不跨日借用，不在月界额外重置。
2. 日界重排分为两个安全提交：先按原状态/租约/period/sent_at 条件释放旧预留并保留未预留 pending 意图，再按新日阈值申请。中间态不可被 claimMail 领取；新日满额也先退旧日，崩溃可恢复。
3. 认证跨日从既有挑战用途和 generation 恢复原意图类别，仍用 contracts 的 floor 判定，不创建新挑战、不延长 TTL；发送前最终资格快照沿 P4-03。
4. 已外调可重试拒绝首版不自动获得新预算；此决定经验收方认可。认证用户走明确重发，业务不承诺自动补发，到期 expired；已消耗预算不退还。
5. P4-06 未提供可用退订入口时不批准业务邮件，避免制造必然因正文缺配置而失败的意图；测试注入合成入口。动态平台限额压缩缺少可信输入/规则的部分列在已知问题，不自行发明。

## 交付物
- 完成：四用途复用原账本；既有认证申请/重发路径复测，业务调度在同一提交里核容量、推进公平游标、预留池/用户预算、盖预算日、关联 Delivery。
- 完成：UTC 日桶自然切换，未调用 pending/leased/retry_wait 旧预留安全释放并重排；已调用/unknown 不释放；原租约不能扣新持有者的预算。
- 完成：100 席位取消均可批准，之后恰余 MAIL_URGENT_FLOOR，重要更正/晚发现被阻断，最高档取消仍可用储备。
- 完成：认证 floor 保住既有账号首次登录，注册/重发暂停；原认证入口不改，另测跨日重占的三种认证用途。floor 与 mail_sending_available 不合并。
- 完成：基础/紧急每用户机会独立，合并只计一封，拒绝不推进游标，unknown 不回退机会；次日恢复日额度，公平游标保留。
- 完成：持久批次和 deferred 列表跨 alarm 继续，不因低序号预算拒绝永久挡住后注册用户；失败发生项排除而不复活；仅剩失败展开的 pending Delivery 不触发新批次空转。新增维护阶段失败不停止认证核心。
- 完成：固定原因 `retry_budget_not_scheduled`，每封只计一次；固定 system_state 计数行按四用途累计。并发、重复 watchdog 和到期都不重复记数。
- 不适用：月末半日片段等 ADR-0003 废止项。
- 待确认：平台动态限额进一步降低时的自动分配压缩。当前注册表上限和启动等式已有硬校验；明确限额/不可用错误仍按 P4-03 关闭发送与生成闸门，未新增远端探测或改配额。

## 执行过的命令与结果
所有检查在本分支独立工作树执行；没有远端部署、真实发信或资源开通。最终唤醒边界修复后已复跑 lint、typecheck、test、build 和读量基准；e2e 与迁移/参数检查在同一基线、该修复之前运行（修复未改前端、迁移或参数）。

| 实际命令 | 实际结果 / 证据（均位于本目录 evidence/） |
| --- | --- |
| `git fetch origin main`；`gh pr view 38 --json state,mergedAt,mergeCommit,url` | 前置 MERGED，merge commit `a1b6084`；首次沙箱内 gh 因网络限制失败，获批网络访问后成功。继续任务及发布前再次 fetch 均成功，发布前 main 仍为 `1a6f41d` |
| `git merge --ff-only origin/main` | 保留未提交进度，快进至 `1a6f41d` |
| `pnpm install --frozen-lockfile --offline` | 首轮锁定依赖安装成功；继续任务执行下行要求命令 |
| `pnpm install --frozen-lockfile` | 成功，Already up to date；`install.txt` |
| `pnpm lint` | 成功；`lint.txt` |
| `pnpm typecheck` | 成功；`typecheck.txt` |
| `pnpm test` | 最终结果见 `test.txt`：contracts 211、Worker 697 通过；原账本用例未改 |
| `pnpm migrate:check` | 成功，0001–0020，8 条 schema 检查通过；`migrate.txt` |
| `pnpm params:verify` | 成功，26 条数值等式及语义条款列明；`params.txt` |
| `pnpm build` | Worker dry-run 和 Web 打包均输出完成，但 Wrangler 版本检查网络请求使子进程持续不退出，手动终止本卡该子进程；不能将此次算作自然完成。`build.txt` |
| `CI=1 WRANGLER_SEND_METRICS=false HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 pnpm build` | 仍挂在后台版本检查，亦手动终止；`build-local.txt`，不算通过 |
| `WRANGLER_HIDE_BANNER=true WRANGLER_SEND_METRICS=false pnpm build` | 通过且自然退出 0。使用已安装 Wrangler 自带开关跳过版本检查，无依赖修改；`build-verified.txt`。仍为 `deploy --dry-run`，无部署 |
| `pnpm test:e2e` | 105 通过 / 5 跳过；`e2e.txt`。跳过项是既有按设备区分的 a11y 用例：desktop 的触控目标和窄视口缩放；mobile 的对比度、颜色字面量和 color.ts 算法。未改跳过条件。命令改写的两张 F2-01 截图已恢复，未纳入 PR |
| `pnpm --filter @hoyo/worker exec vitest run src/auth/challenges/challenges.test.ts src/storage/ledger/mail-ledger.test.ts src/executors/delivery/runtime.test.ts` | 开工首轮 81 通过；`initial-inherited-tests.txt` |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/budget/budget.test.ts src/storage/ledger/mail-ledger.test.ts src/executors/delivery/runtime.test.ts` | 首轮 3 失败/48 通过（合成事件缺少正文链接，预检正确失败）；补齐 fixture 后 53 通过；追加测试后 55 通过。`first-budget-tests.txt`、`second-budget-tests.txt`、`third-budget-tests.txt` |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/budget/budget.test.ts` | 最终 27 通过；`final-targeted.txt` |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/budget/budget.test.ts -t rows_read --silent=false --reporter=verbose` | 1 通过 / 26 被筛选跳过；七条热查询加入各 2000 条历史后读量均不增长；`rows-read.txt` |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/budget/budget.test.ts -t '预算在计划之后耗尽'` | 临时删除容量守卫及对应绑定参数后 1 条按预期失败；恢复源码。`mutation-capacity.txt` |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/budget/budget.test.ts -t '同状态下旧租约'` | 临时删除 lease_version 条件及参数后 1 失败/1 通过，其余筛选跳过；恢复源码。`mutation-lease.txt` |
| `pnpm exec biome check --write ...` | 仅格式化本卡授权改动路径；无全仓格式化 |
| `git diff --check` | 无空白错误 |

失败记录另外保留：最初 Worker typecheck 曾因未获准导出和替身类型失败，见 `initial-typecheck.txt`、`second-typecheck.txt`、`third-typecheck.txt`、`awaiting-exports-typecheck.txt`；授权提取后通过见 `exports-typecheck.txt`。首轮全量 test 曾 1 失败/690 通过：暂停态新增日界 alarm 不符合原上游断言，已修复且上游测试不改，见 `first-full-test-failed.txt`。这些失败不计为验收通过。

未执行：生产发送、真实供应商/反馈取证、动态限额探测、部署、P5 规模负载与账单对账。

## 验收测试
| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| A-P4-BUDGET | `mail/budget/budget.test.ts`:「合并多条 Delivery 只扣一个机会…」「两个并发批准抢最后一额…」「预算在计划之后耗尽仍拒绝，SQL 报错整批回滚…」 | 通过；容量变异被击杀 |
| A-P4-BUDGET | 同文件：「100 席位全量取消可批准，恰余 floor 后拒绝更正/晚发现但仍批准取消」「每用户基础/紧急独立限频，UTC 次日恢复且公平游标不清零」 | 通过 |
| A-P4-BUDGET | 同文件：「未调用 pending/leased/retry_wait 旧日撤回…」「同一旧日行并发撤回只退款一次…」「真实外调抢先跨过边界…」「同状态下旧租约 version/owner 不得撤回…」 | 通过；lease_version 变异被击杀 |
| A-P4-BUDGET | 同文件：「新日满额先撤回旧日…」「新日无预算等待到期后终止…」「认证跨日 existing_auth_first_login/auth_resend/signup_auth 沿用原意图且重新核 floor」 | 通过 |
| A-P4-BUDGET | 同文件：「明确可重试拒绝保留已消耗预算…」「已外调可重试拒绝并发只计一次，到期 expired 不退款」 | 通过；MailProvider 全部替身 |
| A-P4-BUDGET | 同文件：「导出构造随外部守卫批准，转换检查全局和用户源占用」「预算扫描错误 terminal=false/true 不停止认证核心…」 | 通过；原账本测试未改且全过 |
| A-P4-BUDGET | 同文件：「调度持久跨批次推进…」「预算拒绝的前排用户不堵住其他用户…」「有 failed 起步的批次仍批准其他发生项…」「只剩失败展开的 pending Delivery 不触发新批次空转」 | 通过 |
| A-P4-BUDGET | 同文件：「旧日扫描 rows_read 不随 2000 条已调用历史增长」 | 通过：七条查询 `[5,1,7,4,1,0,1] → [5,1,7,4,1,0,1]`；另加入 2000 Delivery、2000 Job 历史 |
| A-P4-BUDGET / 继承认证 | `auth/challenges/challenges.test.ts`:「认证池 floor 降级：重发暂停（429）、既有账号首次登录仍放行、新注册发信暂停只留占位」 | 全量复跑通过，不改原路径或测试 |
| A-P4-OUTBOX 补测 | `executors/delivery/runtime.test.ts`:「一个发生项起步失败 terminal=false/true 独立停下…」新增断言：下一轮不再做起步读取；临时失败到 watchdog 才再读 | 通过 |

A-P4-BUDGET 验收矩阵列出的日界、不可退款边界、全量取消、两个 floor 与次日恢复均有本地证据。未覆盖真实外部平台降额和生产吞吐，不将替身当实测。

## 证据
提交于 `apps/worker/src/mail/budget/evidence/**`，均为 2026-09-30 至 2026-10-01 在本机 workerd/miniflare D1、Vitest、Playwright 执行所得；时间戳由工具记录。构建日志仅省略服务端配置中的发件地址，其余结果不改。没有真实邮箱、OTP、Feed/退订令牌、Push 凭证或生产载荷。

批准事务固定 8 条 SQL；新维护部分共享页槽，保守上界 `SEND_CONCURRENCY × MATCH_PAGE × 16 + SEND_CONCURRENCY + 5 = 647` 条/次；不把既有合并正文逐条复核的成本算成常数。仅 watchdog 兜底时三类维护共享 5760 行/日槽位，正常积压通过连续 alarm 推进；数据库慢到耗尽墙钟或故障退避时不保证吞吐。完整成本、D1 字节上限和积压负载仍需 P5-04 实测。

真实 MailProvider、退订 DKIM、跨接收时间日界账单差异：需所有者执行，本卡未产生外部邮件。

## 不在本次范围
未实现 P4-05 通道同意 API、P4-06 退订和模板汉化/北京时间、P4-07 Queue 消费及对账、P5 管理界面/告警/容量回收。未新增供应商、自动重试上限、unknown 次数/比例暂停，未改 P4-03 外调超时份额，未恢复禁止清单中的设计。未更改任何参数或开通付费资源。

## 已知问题与回退点
1. **交 P5-01 / P5-04**：读取固定 `system_state.mail_retry_budget_not_scheduled` 的累计 `count` 与四用途计数，观察增量告警；日志 `mail_retry_not_scheduled` / 原因 `retry_budget_not_scheduled`。明确可重试拒绝本版不自动补发，业务到期 expired，认证须用户明确重发。须在 P5-04 公开该限制；自动补发需另定注册表参数与等式。
2. **交 P5-01**：新增 `delivery_budget_failed`、`delivery_dispatch_failed` 固定原因日志，及 `delivery:budget-backoff`、`delivery:dispatch-backoff`、`delivery:dispatch` 的 failed 状态需监控。未修改验收方管理的 P5 任务卡。
3. **待确认**：平台更低额度的可信输入、刷新时机和压缩分配规则尚未定接口；当前遵循注册表 + 启动校验 + P4-03 明确限额错误停发。未凭空引入动态探测或不受控额度。
4. **交 P4-06**：真实业务发送仍等 `unsubscribe` 注入；本卡不改模板。已有枚举/UTC 展示问题继续由 P4-06 处理。
5. **交 P5**：历史日账本、MailOutbox、mail_send Job 和 P4-02 批次按已有保留规则清理；本卡固定累计计数只一行，不按收件人扩张。批次集合和单用户合并 JSON 的规模/字节上限仍需 P5-04 负载确认。应用账本不等于平台绝对费用封顶。
6. **工具限制**：本机 Wrangler 4.136.0 的 update-check 请求超时后保持连接，普通 build 未自然结束；使用已安装工具的 `WRANGLER_HIDE_BANNER=true WRANGLER_SEND_METRICS=false` 后正常完成。不以手动终止返回 0 冒充构建通过。
7. 回退到 `1a6f41d` 可恢复本卡之前的可用代码。无迁移；若已运行本卡，回退代码不会回滚已记录的预算/外发结果，不能手动清零 settled/uncertain 或重置 unknown，须保留账本供对账。
