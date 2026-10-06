# P4-04 预算池执行

按主方案 §9.1–§9.3 的保留条款、附录 A.4/A.5 经 ADR-0003 的替换执行：固定 UTC 日、三个日池、四个用途。所有阈值及 floor 判定沿 contracts，业务批准的容量谓词沿 mail-ledger 构造。

`planBudgetedDispatch` 取得 P4-02 的计划后，追加容量守卫，在末尾多行 Delivery 更新之前追加全局池与用户行预留和预算日盖章。守卫未命中不推进游标，不建 outbox，不扣机会；错误由 D1 整批回滚。不同 priority 同属一个业务池时共享用户日机会。两个认证用途已经在 P2-01/P2-02/P2-09 的申请/重发路径接入，本卡复测而不改认证路径。

`releaseOldReservation` 同一提交核对原状态、lease_version、lease_owner、period_key 与 sent_at IS NULL，并撤回全局/用户旧日预留、递增租约版本、清空旧租约，保留载荷、outbox 和 Delivery 引用。`reserveUnsentIntent` 再按当日 contracts 阈值批准。两阶段之间只有未预留的 pending 意图，发送器不能领取；崩溃重启可恢复。新日满额也先释放旧日，意图按 watchdog 等待并在日界恢复，绝不持有可被误认为新日预算的旧盖章。已调用、unknown、明确拒绝的 settled 占用都不释放。

认证跨日沿原挑战用途/代次辨别首次登录与显式重发；换邮箱走 account_change_auth。旧载荷是否仍有效由 P4-03 发送前快照最终判定；日界重排不延长挑战 TTL、不改验证码、不生成新发送意图。

## 自动重试决定

本卡**不为已外调而明确可重试拒绝的 retry_wait 行自动申请新预算**，认证和业务相同。这是 P4-03 交接明确交由本卡决定的策略：已消耗的 settled 留账，认证用户可走原有显式重发；OTP 载荷已被清除，不能从 MAC 重建。业务邮件不承诺自动补发，到期按 expired 结束，已消耗预算不退还。

`finishRejectedRetryPage` 对每封仅计一次固定原因 `retry_budget_not_scheduled`；`system_state[mail_retry_budget_not_scheduled]` 持久保存累计 `count` 和四用途计数，`jobs.payload_json.retry_budget_not_scheduled` 防止并发重复计数。日志 `mail_retry_not_scheduled` 只带原因码和 `count=1`。交 P5-01 告警，P5-04 公开“不承诺自动补发”；计数是运行累计，不是送达数，也不参与预算暂停。

unknown 等待 P4-07 反馈/对账，deferred 不重投；不增加 unknown 次数/比例暂停，不改外调超时份额。

## 调度与上线接线

Delivery 先跑原认证优先发送与发生项展开，再运行预算批准。业务批次 ID 与本轮 deferred 组合持久保存在 `delivery:dispatch`；每轮工作槽来自 SEND_CONCURRENCY，墙钟来自 EXECUTOR_BATCH_WALL_LIMIT。预算拒绝不堵住后注册用户；下一轮重置 deferred，公平游标一直保留。新增到期项在下一批进入，失败发生项从批次排除，不能借 P4-02 的展开入口复活。

P4-06 尚未提供 `SendDeps.unsubscribe` 时不批准新的业务邮件；运行期开关关闭时也不批准。生产仍须 P4-06 接真实退订入口（现状：P4-06 已在 `mailDependencies` 提供 `SendDeps.unsubscribe`，缺退订配置或开关关闭时仍不批准业务邮件），模板汉化和北京时间展示仍归 P4-06；本卡测试均注入合成 URL 与 MailProvider 替身。认证 floor 与 mail_sending_available 继续是两道独立门。

跨日扫描按 outbox 的活动状态索引定位，每页 MATCH_PAGE；每封坏意图单独留 failed，暂时错误下一 watchdog 才重试。`delivery_budget_failed` 和 `delivery_dispatch_failed` 只输出固定原因码，供 P5-01 登记；不修改验收方维护文档。预算扫描的阶段故障单独写 `delivery:budget-backoff`，调度读失败写 `delivery:dispatch-backoff`；都不关闭认证核心开关。历史 usage_periods / outbox / mail_send jobs 仍按既有 P5 保留合同回收；批次用 P4-02 `pruneExpiredDispatchBatch` 清理，固定 coordinator 与公平游标不按日删除。

## 限制与待确认

- 平台实测上限仍来自 PLATFORM_MAIL_DAY_LIMIT，启动等式验证总日额不超平台。平台明确不可用/限额错误仍按 P4-03 关闭生成与发送闸门；仓库没有动态平台剩余量的可信输入，本卡不凭空增加远端探测或自行分配缩水比例。平台更低限额下的自动压缩分配接口与准则仍需所有者明确。
- 不恢复任务卡旧文中的月末片段、月池与平滑公式；ADR-0003 已明确废止。
- 应用账本不是平台账单的绝对封顶，跨 UTC 接受时刻差异和共享账户占用须 P5 对账；未真实发信，未做生产规模成本验收。


## 成本与测试边界

批准计划固定 8 条 D1 语句（两个零占用铺垫、一个资格/容量/游标守卫、五个效果），参数数目不随合并候选条数增长。沿 P4-02 的批次和合并 JSON 仍受实际字节尺寸限制，规模上界待 P5-04 负载验收，不在此发明截断规则。

watchdog 的租约修复、拒绝收尾、跨日维护共享 SEND_CONCURRENCY 个非空页槽，每页 MATCH_PAGE，并受 EXECUTOR_BATCH_WALL_LIMIT 限制。以每行最多 16 条语句的保守计数，维护部分最多 `SEND_CONCURRENCY × MATCH_PAGE × 16 + SEND_CONCURRENCY + 5 = 647` 条，小于当前 D1 1,000 条调用限制；既有 tick 内合并信复核随条目数增长，完整外发成本仍交 P5-04。仅依赖 watchdog 时维护槽为 `86400 / WATCHDOG_INTERVAL × SEND_CONCURRENCY × MATCH_PAGE = 5760` 行/日，三类共享；alarm 有积压会继续推进。此算式不包含故障退避和慢数据库耗尽墙钟，不能当成吞吐保证。

新增维护/唤醒七条热查询在各加入 2000 条终态 MailOutbox、Delivery、Job 后，实际 rows_read 从 `[5,1,7,4,1,0,1]` 到同一数组。测试在本卡 budget.test.ts 中，未越界修改 storage/schema.test.ts。没有新增迁移。
