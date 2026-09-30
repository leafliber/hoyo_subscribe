# P4-07 反馈收件箱与抑制

**草稿，待范围确认**：精确地址 HMAC 当前临时复用 `computeEmailKey` 的 HMAC 运算，但该 API 的注释约定输入为账号 canonical_email。已请求所有者允许只补改 `storage/crypto/mac.ts` 与 `mac.test.ts`，提供带用途标签的精确地址 HMAC 原语；尚未获准，未改这两个文件。此项完成前不标记本卡验收就绪。

合同：主方案 §7.5 后半、§7.7、A.4/A.5；P0-05 platform-facts §2.2；P4-03 验收登记与 outbox/README。只处理 `hoyo-mail-events`，没有 HTTP 反馈入口或外部请求。本地测试均是 P0-05 形状的合成事件。

## 验证与提交

部署配置 `MAIL_FEEDBACK_ACCOUNT_ID` 是预期账户；`MAIL_FEEDBACK_SUBSCRIPTIONS` 是 JSON 数组，每项 `{ "id": "订阅 ID", "domain": "发件域" }`，匹配的是成对关系，不能把两个白名单拆开。业务域订阅与认证域订阅分别登记；没有认证域订阅时不猜 ID。缺配置、密钥缺失、错误 Queue、超批量均失败关闭并重试。

验证 source、accountId、订阅/域配对、sender 域、schemaVersion、eventTimestamp、六类事件名称、terminal 与 delivery.status 一致性。沿用注册表 `API_BODY_MAX_BYTES` 作为受控消息的保守入口上限；不是平台 Queue 大小上限。未来证据确需更大载荷时须通过参数任务调整，不能在本模块私加数值。

`mail_feedback.provider_event_id` 是去重键；messageId 逐字关联，包括尖括号。原始 recipient/subject/SMTP 响应不落库或日志。`raw_ref` 仅存精确地址 HMAC、固定抑制原因、处理状态与租约；不保留原文。回执一律经过 `recordMailReceipt`，不直接写 outbox/Delivery/预算。

处理顺序：校验 → 原子容量判断与收件箱插入 → 租约 CAS → 回执原语 → 同批条件完成标记、抑制、关闭仍匹配的通道 → ack。回执和完成批次分两个事务；其间崩溃会重放，不声称跨 Queue/D1 严格一次。已完成重复事件直接 ack；处理中重复事件 retry；失去租约时本地完成批次没有副作用。D1/配置/载荷错误只留固定原因码，不输出原始异常。

反馈先到时保留在未关联区并 retry，`WATCHDOG_INTERVAL` 延迟、`FEEDBACK_MAX_RETRIES` 后由平台送 DLQ。它不会因为正文主题相同就关联到其他信。`recordMailReceipt` 返回 false 还可能表示晚到状态被已有终态支配，不能一概当未知 messageId。unknown 有精确 messageId 时由原语结算 uncertain；没有 messageId 时仍需要受控对账，不能按地址猜邮件。

## 状态与抑制

accepted 仅为已提交平台；jobs 的 provider_status=delivered 才表示收件服务器接受，二者均不表示已读。deferred 即使有 soft bounce 也不冻结、不重投。投诉、终态 hard bounce、明确 recipient suppressed 拒绝写入本地冻结；普通 failed/rejected 不自行解释成地址问题。后来的 delivered 不恢复同意。

抑制用精确投递地址键，本地部分大小写敏感。已有 `read_only` 不因新反馈降级；没有任何自动解除或供应商写 API。新反馈缺少平台 read_only/expiry 证明时写本地保守只读锁，reason=`feedback_requires_verification`，expires_at=NULL；这是“等待受控核验”的应用锁，**不是声称该平台投诉永久不可解除**。P5/管理功能不能把这个本地锁当作已经读取过平台 read_only 的证据。普通退订归 P4-06，不创建平台全账户抑制，不换域重试。

业务 outbox 的不可变 binding 决定关闭范围；SQL 同时核对当前用户绑定与地址版本，晚到旧地址反馈不会关新地址。历史认证 outbox 没有 binding 时，仅当前版本且解密投递地址的 HMAC 精确匹配才补关联。已换绑或无法恢复历史绑定时保留 `unbound:<HMAC>` 异常，不冒充当前绑定。这类历史异常以及注册前尚无用户的反馈需要受控核验；本卡不改认证发信历史或虚构绑定。

[R14 最新文档](https://developers.cloudflare.com/email-service/concepts/suppressions/)（2026-09-30 读取）已区分 account / sending_domain，和仓库合同引用的早期平台事实不同。本模块继续执行项目要求的本地地址冻结，不推断平台所有抑制均跨域，也不依据域范围差异绕过投诉。网页恢复码/换邮箱提示由 F4 的真实状态联调接线；本卡授权路径不包含页面或状态 API。

## 容量、保留与后续维护

`MAIL_FEEDBACK_MAX` 限制全部反馈；`MAIL_UNMATCHED_MAX` 保守限制尚未完成的反馈（包括处理中的已知消息），容量判断在同一 INSERT 内。满额拒绝新反馈，Queue retry/DLQ，不删除未决记录腾位置。eventId 与 messageId 查询沿既有唯一索引；未关联计数用 outbox 索引。总量和到期扫描受注册表容量封顶；没有新迁移，无编号冲突。

已完成元数据在 `MAIL_FEEDBACK_TTL` 后分 `FEEDBACK_BATCH` 页汇总到固定 `system_state[mail_feedback:archived:<kind>]` 计数，再删除。每条汇总与删除使用统一 CAS，真实并发清理不重复计数。未决异常保持有限保留、不自动当成功删除。

Queue 每批执行一页清理。没有 Queue 流量时不会运行：P5 维护需循环调用 `pruneFeedbackPage`，在其自身墙钟内清至完成；DLQ 修复后可调用 `reconcileFeedbackPage`，它仅处理当前存在精确 messageId 的未关联项。两者都是本地 D1 原语，未接 Cron（本卡未获准修改 scheduled）。正常重试不依赖这条维护路径。

**容量风险须保留可见**：若持续跑满 MAIL_TOTAL_DAY 且每封都像 P0-05 第二封产生 5 条反馈，30 天有 39,000 条，超过 MAIL_FEEDBACK_MAX=20,000；届时拒绝新增并依赖 DLQ/人工处理。不能把包含量估算当存储容量保证，也不能自动扩大阈值。DLQ 有平台保留期限，需要所有者监控及时处理。

## 需所有者执行的上线前置（本卡均未执行）

1. 配置预期账户、业务订阅/域配对和既有 crypto 秘密；认证域订阅创建后才能把其 ID/域配对写入配置。核对真实载荷的 schema/大小。
2. 将既有 `hoyo-mail-events` 的 HTTP pull 消费者切换为 Worker 消费者；准备并核对 `hoyo-mail-events-dlq`。提交的 Wrangler 配置不表示资源已存在或已修改；没有 DLQ 就不得部署放行。保留原占位 mail-feedback 配置，清理它另由所有者处理。
3. 实测原生 Queue 重试耗尽→DLQ、死信保留/监控/受控重放、认证域事件关联与抑制状态核验。本地测试只验证 ack/retry 与部署声明，不能替代真实 DLQ 取证。
4. 由 F4/P5 接网页恢复码/换邮箱提示、运维观察与无流量维护。没有开放本地锁的 API；可变抑制解除仍需要用户明确请求和受控核验。

## Queue 操作量估算

[Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)（2026-09-30 读取）：Workers Paid 含每月 1,000,000 次标准操作；通常每条写、读、删各一次，重试另计读取，DLQ 另计写入和后续消费。小于 64 KB 的消息按一份计；本模块入口上限远小于该值。

以注册表 MAIL_TOTAL_DAY=260、31 天、P0-05 实测每信 5 个事件估算：40,300 条事件/月，正常 120,900 次操作。为全部事件发生 8 次重试且进入 DLQ 再消费预留**每事件 16 次操作**（含额外余量），共 644,800 次，仍低于包含量，剩余 355,200 次。该估算以小消息、共享账户其他 Queue 不吃掉余量为前提；不是邮件合同中的月度池或发信配额。

供应商延期事件数没有已验证硬上限，不能承诺任何异常流量下绝不计费：同一保守模型每信 8 个事件就是 1,031,680 次。所有者上线前需核对共享账户用量，P5-01 接近包含量时告警并停止扩大。本卡没有任何远程 Queue 操作、真实外发或资源创建。
