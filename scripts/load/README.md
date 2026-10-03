# P5-04 本地负载与离线对账

全部命令统一 `CI=1 WRANGLER_SEND_METRICS=false`。根测试不会自动收集本目录，必须显式执行。

```sh
pnpm exec tsx --test scripts/load/reconcile.test.mjs scripts/load/cli.test.mjs
pnpm exec tsc -p scripts/load/tsconfig.json
pnpm exec tsx scripts/load/policy.mjs
pnpm build
pnpm exec tsx scripts/load/run.mjs
node scripts/load/regression.mjs
pnpm exec tsx scripts/load/reconcile.mjs docs/evidence/p5/reconcile.synthetic.json
```

run 只启动 `wrangler dev --local` 随机回环端口，使用仓库锁定 Worker 配置和本次 `apps/web/dist`。临时配置改 main 为本目录测试包装器，去掉 send_email、Cron、Queue 消费绑定；两个固定 DO 类保持现有声明，未用本次负载证明 alarm 行为。D1 使用临时持久目录并实际重放全部迁移。没有远端参数、平台凭据、真实秘密或供应商连接；拒绝 checkout 中 `.dev.vars`。父进程只传工具运行所需环境，不传平台 token。临时随机 fixture 能力只在内存/源码外临时配置，子进程输出不回显，退出删除临时目录。

生产 Worker 入口处理公开读、有效会话私人预览和有效 Feed。测试包装器仅提供本地数据建立、D1 计量及调用现有发送/维护原语的入口，不进入 production config 或网页产物。所有样本 synthetic；假供应商返回 accepted / unknown / 明确可重试拒绝，实际发送为零。回收动作经现有 confirmReclaim 原语模拟维护者逐项确认；真正管理员鉴权/CSRF/审计由 regression 中现有 routes.test.ts 验证，不能将内部工具调用称为浏览器管理员全链。

输出 JSON 只含白名单聚合计数及时间。样本数/并发数是测试负载形状，不是业务阈值；容量、分页、预算、频率等来自 contracts。cold 是新建生产 shell/FeedPublicCache 的首次请求，不代表冷 isolate 启动耗时。吞吐和 p50/p95 是本机 HTTP wall time，未设置新的性能放行阈值，也不测/换算平台计费 CPU。私人预览计时含全部分页，其 count 是一次完整遍历；撤销场景含多个协议请求。生产维护调用与额外证明查询分开发起，后者不挤占同次共享预算。实际 workerd D1 rows 和语句数不代表云平台账单。

regression 直接运行现有八个 workerd 测试文件（不复制生产业务/测试），覆盖三个日池、认证子额、floor/unknown、跨日预留、并发最后机会、暂停与确认、自动续租、满轮反馈共用查询预算、席位/子席位容量、预览限流。具体测试数看本轮输出，不拿历史绿灯替代。

## 对账输入

reconcile 只读一个严格聚合 JSON，无网络和写库。`synthetic=true` 只标 E1；false 也只标“所有者提供、尚未独立核验”，从不自行赋予 E3/最终放行。示例 JSON 是合成场景，不是空的真实账单。

- days：每个 UTC 日一次，pools 必须含 contracts 的四个用途行 existing_auth/new_registration/base_business/urgent_business，全部是 `user_id IS NULL` 聚合。前两行相加展示一个认证日池；用户行不可再次相加。每行 settled/reserved/uncertain 均独立，缺观测不能填零。
- acceptedKnown / rejectedKnown：按账本归属日从 outbox/可信反馈独立确认的终态数量。settled 包含明确拒绝，不能等同平台已接受；其余 settled 标 unresolvedSettled。unknown 不释放、不自动重发；reserved 未调用，不计入接受量。
- crossDayAccepts：按可信 messageId 对照得到的 `{ledgerDay,acceptedDay,count}` 聚合，两日都需输入；不输入 messageId。用于平台接受时间跨日，不用于把未发送预留结转。未调用预留的释放/新日预占已体现在实际日账本，各日不共享余额。
- platform：每日报 `accountAccepted / otherAccepted / applicationAccepted / dayLimit`，不能观测填 null。分清本应用/账户其他应用和动态日权限，不从历史零其他占用推定当前值。
- meters：workers/d1/do/queue 分列；整项未知填 null。已取证项目为 `{from,to,metrics}`，from/to 为同一平台观测区间的 UTC 毫秒；每个指标 `{unit,application,other,account,included,billedQuantity,billedCost}`，未知字段为 null。费用是平台已报告的该项金额，币种/账单窗口另在证据记录，工具不推定费率或合计不同币种。
- 单位闭合：Workers requests/cpu_ms；D1 rows_read/rows_written/storage_bytes；DO requests/duration_gb_s/rows_read/rows_written/storage_bytes；Queue operations/retry_operations/dlq_messages。DLQ 积压是状态，重试是 operations 子集，不能重复相加当账单总量；存储快照不能直接当 GB-month 费用。

`counts_match` 仅表示可归因的已知接受计数相等，不代表送达、费用匹配或上线通过。`needs_review` 保留账户归因差、跨日量、unknown、未解释结算；`withinUncertainty` 不是核销，必须继续查实际反馈。beyondIncluded 仅为同单位算术差额，不能保证不超费；没有包含量时保持 null。官方标价不能充当账户 E3；取证和关闭门部署步骤见 docs/evidence/p5/owner-handoff.md。
