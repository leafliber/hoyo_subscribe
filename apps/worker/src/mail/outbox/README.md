# P4-03 发送器与后续接线

依据主方案 §2.2、§2.3、§7.4、§7.5 和 ENGINEERING §5.6。唯一外发实现是 `provider/native.ts` 的原生 `send_email` 适配器。测试全部替身，不代表生产邮件取证。

## 状态、预算与崩溃

`claimMail` 只领取当日已盖预算周期且池有预留的 pending 行，按认证优先级领取并递增 lease_version。`sendOneMail` 与 `tryAuthMailFastPath` 共用领取、资格快照、调用和写回。HTTP 路由当前只安排 DO 唤醒，不同步等待供应商。

- 调用前复核普通/最近认证挑战、代次、截止、账号、邮箱版本、当前会话，或调用 P4-01 的逐条 Delivery 复核。合并信剔除失效条目并保留其终态；剩余条目仍共享原 outbox/去重族。
- 快照在读取正文前取得；进入 calling_provider 的事务再核对快照、租约版本、持有者、截止和预算日。状态变化不会依赖仅有的读侧判断。
- 进入 calling_provider 时，预算由 reserved 转 uncertain，验证码发送载荷清除；短期内存只供此次调用。明确 accepted/rejected 后 uncertain 转 settled；所有这些写入与 outbox/Delivery 同事务。
- 调用前跳过/作废/过期/确定性坏数据，释放 reserved。认证过期清理也使用同一条件提交适配，避免先读后退款误扣其他邮件的聚合预留。
- 调用前暂时失败在下一 WATCHDOG_INTERVAL 才恢复 pending。明确可重试的供应商拒绝落 retry_wait，但那次调用的预算已消耗。**P4-04 接线之前不自动批准新的重试预算**；认证用户可通过既有明确重发路径建立新意图。已经清除的 OTP 不从 MAC 重建。
- calling_provider 租约过期落 unknown，保留 uncertain，不重发。leased 过期可重新领取，旧版本不能写回。超时不能取消已经进入平台的消息，也不能证明未发。

不能保证端到端严格一次；外部已接受而本地未保存 messageId 的结果，只能等待受控反馈/对账。唯一索引不消除这个窗口。

## 回执与 P4-07

现有 `mail_outbox.status` 使用 contracts 的枚举；`accepted` 只表示提交平台成功。每封信的 `jobs.id = delivery:mail:<outbox id>` 保存固定原因码、失败次数、重试时刻，以及 `payload_json.provider_status`：`submitted` 与 `delivered` 分开，后者仅表示收件服务器接受。既有数据库枚举没有 delivered，本卡没有为它重建历史表。

`recordMailReceipt` 是 P4-07 验证 Queue 事件、eventId 去重之后的内部写原语。它按精确 messageId 关联，deferred 不重投；投诉/退信/失败/拒绝不会被晚到成功覆盖，delivered 不被晚到 deferred 倒退。未知 messageId 返回 false，留给 P4-07 的有限未关联保留；不按主题猜关联。它不实现 Queue 消费、抑制或同意恢复。

注意 contracts/enums.ts 既有注释把 accepted 描述为“收件服务器接受”，与 §7.4 平台提交口径不符；本卡不修改未授权的 contracts 文件，交验收方后续修正文案。

## 开关、配置与 P4-04/P4-06/P5

生产默认失败关闭。仅当 `system_state[mail_sending_available]` 是 JSON true，且以下服务端配置齐备时才开放认证生成和后台外发：

- `AUTH_MAIL_FROM`、`BIZ_MAIL_FROM`：所有者核定地址，与 Wrangler 两个绑定各自的 allowed_sender_addresses 对齐；地址不进入模板。
- `SITE_ORIGIN`：稳定 HTTPS origin。
- 既有 `CRYPTO_MASTER_SECRET`、`CRYPTO_OTP_PEPPER`、`CRYPTO_UNSUBSCRIBE_KEY_ID`：只通过部署秘密注入。

供应商不可用/额度类拒绝或未知结果会关闭开关；不自动重新开放、不换域试发。`GET /api/v2/status` 暴露全局 `mail_sending_available`，申请/重发/换邮箱验证码在生成前检查，现有验证、会话、恢复及公共读路径不受此门控制。恢复和开关运维由 P5 的受控操作完成，本卡没有管理写 API。

业务批准调度尚未接通。P4-04 必须先在 P4-02 批准事务中预留预算，再接调度；不能把 `period_key = OUTBOX_UNRESERVED_PERIOD_KEY` 改成非空就冒充预算。未调用的跨日重新预留、新调用预算、日池降级仍由 P4-04 完成。P4-06 接入 `MailContentDeps.unsubscribe`，提供真正可用的正文确认/one-click URL；未接入时业务模板失败关闭，不发送虚假的退订入口。测试注入的 URL 全是合成样例。

认证 binding 的错误枚举和结构化 send 对齐 [Cloudflare Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)（2026-09-30 读取）。仓库锁定的生成类型仍是旧 EmailMessage 签名，因此适配边界使用窄接口断言，不升级依赖、不调用 REST 兜底。需要所有者在真实环境验证原生绑定与退订 DKIM，不能用本地替身通过来替代。

## 执行边界、容量与保留

DeliveryDO/main 串行整个异步工作单元。每个 alarm 的发送尝试和发生项页面均受 SEND_CONCURRENCY 的工作槽上界及 EXECUTOR_BATCH_WALL_LIMIT 限制；每页受众数沿用 MATCH_PAGE。尚有积压立即安排下一持久 alarm；清空后休眠。Cron 仅是 WATCHDOG_INTERVAL 的修复兜底，不是“每个 Cron 只展开一页”。发生项发布信号已由 PipelineDO 生成，Delivery 调用 runOccurrencePass 时不重复消费信号，也不接入任何模型。

最保守的仅 watchdog 唤醒算式：一天可恢复 `86400/WATCHDOG_INTERVAL × SEND_CONCURRENCY × MATCH_PAGE` 个过期租约（当前 5760），正常外发/展开会靠连续 alarm 继续推进。慢供应商最多每个批次墙钟消耗一次未知调用，随后全局暂停，不声称固定送达 SLA。大量单用户合并条目的读取成本与生产积压仍需 P5-04 负载证据。

每条发送记录只复用一条 jobs，不逐重试追加历史。`pruneMailJobPage` 按 MAIL_METADATA_TTL/MATCH_PAGE 清理已完成元数据；P5 调用直到完成并受其墙钟约束。未知、deferred 和未完成任务保留待对账，不假装它们已送达。mail_outbox/Delivery 自身的容量和历史回收沿既有 P5 合同；本卡不提前实现其回收策略。

监控交接：`mail_provider_failed`、`mail_preflight_failed`、`mail_result_persistence_failed`、`delivery_tick_failed`、`delivery_expansion_failed`、`delivery_alarm_read_failed` 都只输出固定原因码/计数；原始供应商异常、OTP、完整收件地址及退订 URL 不进日志。确定性故障落 failed；其余故障延至下一 watchdog。`delivery:backoff` 失败行需受控修复后解除，不能盲目重置 unknown。
