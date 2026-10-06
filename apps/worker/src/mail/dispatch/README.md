# P4-02 邮件调度交接

依据主方案 §7.3、CONTRACTS_BASELINE §6.1–6.2。仅服务端逻辑，不接供应商，不扣预算，不声称已送达。

## 执行入口

1. P4-01 消费发布信号后，编排器用持久批次 ID 调用 `startDispatchBatch`。该次 SQL 快照固定发生项集合和 `startedAt + MAIL_DIGEST_WINDOW` 上界。重复 ID 恢复原批次，新的发生项进入下一批。
2. 反复调用 `expandDispatchBatchPage` 至 `ready`；每次最多推进一个 `MATCH_PAGE` 的受众页。所有本批已到期发生项完成展开前，选择和批准的 SQL 守卫均阻断发送。发生项的 order 上界与页事务复用 P4-01。
3. `selectDispatchCandidate` 返回 `expanding / advanced / empty / candidate`。`advanced` 表示暂存了未来候选或标记了失效项，编排器在本轮墙钟允许时继续。选择不会推进公平游标；可用 `deferred` 排除本轮预算拒绝的用户/优先级组合。下一轮不要永久沿用该列表。
4. `planDispatchAttempt` 重新核对资格后返回条件提交计划。**调用它不代表批准**，只有执行计划并取得 `committed` 才产生一个机会。计划守卫再次比对资格快照、展开完成状态及持久游标。过期或资格已变返回 `null`；并发抢占返回 `condition_missed`，重新选择即可。
5. **P4-04 必须把预算谓词和单行账本效果并入同一计划**，在末尾多行 Delivery UPDATE 之前插入效果；不得先提交该计划再单独申请预算。输出 outbox 初始 `period_key = OUTBOX_UNRESERVED_PERIOD_KEY`，本卡的合成批准测试不冒充真实预算或真实发送。
6. P4-03 从 `payload_kind = notification_digest`、`payload_ref = mail_outbox.id` 反查 `deliveries.mail_outbox_ref` 构造正文并继续即时复核；引用中只有服务端 ID。一次合并的多条 Delivery 保持各自去重族。unknown/失败不回退游标，也不由本模块重试供应商。

优先级数值复用 P4-01 `occurrencePriority`，预算池复用 contracts `poolOfMailIntent`。同节点的更正、晚发现、公布仅在同计划版本的本轮候选中去重；低档条目记录 `superseded / higher_priority_same_node`，不附进高档邮件。其他节点和常规提前提醒不被顺带吞掉。较高档若没获批准，低档不会抢先发送。

## 提前合并与保留

未来候选必须搭乘同优先级已到期邮件，不自行触发。仅为当前用户暂存待处理 Delivery；不提前建立未来 occurrence 的全体受众上界或扫描 Job。原定到期时仍正常展开，可以覆盖在提前合并之后、原 due_at 之前新增兴趣的其他用户。未获批准的未来候选失去资格时，也不在原定到期之前写终态。

已过期、尚未关联 outbox 的 Delivery 由 `expireDispatchCandidates` 每次最多处理 `MATCH_PAGE`，保留 expired 原因；已关联 outbox 的生命周期归 P4-03。Delivery 去重记录和 MailOutbox 的清理由 P5 按既有保留合同处理，不在此删除。

`pruneExpiredDispatchBatch` 提供按批次 ID 的清理原语：达到 `MAIL_METADATA_TTL`、所有发生项过期且无未完成 Delivery 后才删除批次 Job。发生项展开 Job 保留，防止重新展开；公平游标固定按池/优先级保留，永不因批次或 UTC 日边界重置。P5 负责有界扫描和调用，P4-03/执行器负责墙钟与唤醒接线。本卡未接入生产定时器（现状：由 `scheduled/reclaim.ts` 调用）。

## 原子性与规模

普通批准计划固定三条语句：游标守卫、一个 outbox INSERT、末尾多行 Delivery UPDATE。候选 ID 和资格快照用 JSON 参数承载，绑定数不随候选数增长。SQL 错误回滚整批；守卫零行时全部效果零行。

资格快照复用 P4-01 的当前账号、订阅、兴趣、两层同意、抑制和邮箱版本读法，并包含事件计划版本、发生项及 Delivery 有效期。单用户候选热查询先按 pending 状态走索引；测试向同一用户加入 200 条历史终态记录后，D1 `rows_read` 不增加。120 条已到期候选的合并测试覆盖超过单条 SQL 100 绑定参数的常见退化。

批次集合和单用户合并集合不截断，否则会破坏“全部候选合并”。大规模 JSON 字节量与实际 D1 读放大仍需 P5-04 负载验收；本卡不据合成测试承诺生产成本上界。
