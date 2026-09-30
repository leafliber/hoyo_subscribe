> 历史记录：这是 `4b36dfb` 的首次交付报告，保留当时的失败与限制。2026-09-30 复核后的最新实现、授权及验收结果见 [返工报告](REWORK.md)；本文的草稿状态与容量解释不再适用于当前版本。

## 任务卡

P4-07 · 反馈 Queue 消费、关联与抑制 · 阶段 P4。

**交付状态：草稿，尚非验收就绪。**需要所有者确认一项最小范围补充：允许修改 `apps/worker/src/storage/crypto/mac.ts` 与 `mac.test.ts`，提供精确地址 HMAC 的正式原语（下文说明）。没有擅自修改这两处。已完成原范围内的实现、测试与交接，并推送供审阅。

## 改动范围

- `apps/worker/src/mail/feedback/schema.ts`：P0-05/R06 事件边界、受控来源验证、固定状态投影。
- `apps/worker/src/mail/feedback/store.ts`：持久去重、租约、回执原语调用、容量、关联重试与到期汇总。
- `apps/worker/src/mail/feedback/index.ts`：逐消息 ack/retry、配置失败关闭、默认 queue handler。
- `apps/worker/src/mail/feedback/feedback.test.ts`：33 条本地 Worker/D1 合成事件测试。
- `apps/worker/src/mail/feedback/README.md`：部署清单、数据处理边界、容量与成本、P5/F4 交接。
- `apps/worker/src/mail/feedback/DELIVERY.md`：本报告。
- `apps/worker/src/mail/suppression/index.ts`：精确地址键、本地冻结、旧绑定隔离。
- `apps/worker/wrangler.jsonc`：只追加 hoyo-mail-events 消费者配置；不修改现有生产者和占位消费者。FEEDBACK_BATCH/max_retries 是注册表的声明式投影，由用例校验，沿用仓库 Cron 配置的做法。
- `apps/worker/src/index.ts`：只 import 并导出 queue handler。

无授权外文件改动，无依赖升级，无新迁移。19 个既有迁移保持原编号，P4-03 的 0019 未动，也未占 P3-06 的迁移号。新增查询基准放在授权范围内的 feedback.test.ts，未改验收方/其他阶段维护的文件。

## 继承的合同

完整读取 AGENTS.md、BUILD_PLAN §2、P4-07 全卡（含 P0-05 与 P4-03 交接）、P4-03 卡末验收登记、platform-facts §2.2、outbox/README；读取主方案 §7.5、§7.7、A.4 FEEDBACK_* 及 A.5 保留参数，并在线读取 [R06](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)、[R14](https://developers.cloudflare.com/email-service/concepts/suppressions/)。

前置 PR #38 已 MERGED，2026-09-30T12:13:38Z，main `a1b60841210a861b8863f00811f2c06865e642a4`。工作树从最新 origin/main 建立；提交前再次 fetch，仍是该提交。G-P1 已开；本卡仅本地逻辑，未使用真实外发门禁。

实现中的保守解释与待确认项：

1. 反馈大小沿用现有 `API_BODY_MAX_BYTES`，没有新建字面阈值；它是保守入口限制，不冒充 Cloudflare 平台载荷上限。
2. `MAIL_UNMATCHED_MAX` 保守覆盖所有尚未完成处理的反馈，包括正在处理但已知 messageId 的反馈。满额 retry/DLQ，不删未决行腾位。
3. Queue 没有提供 read_only/expiry 的实测证据。新本地冻结以 `feedback_requires_verification` 标明需核验，先锁住解除；这不等于认定平台投诉永久不可变。没有任何删除/解除抑制 API。
4. R14 当前已区分 account/sending_domain，和旧合同中的平台范围描述有差异。本卡保留合同要求的本地地址冻结，不把平台全部抑制宣称为账户级，不以域差异绕过投诉。
5. 反馈收件箱、回执、完成批次之间采用可恢复的分阶段提交。所有回执均经 recordMailReceipt，不声称端到端严格一次；反馈去重完成之前不 ack。
6. 历史认证 outbox 未写 binding。仅当前地址版本与解密实际投递地址精确匹配才补关联；无历史绑定时记录 unbound HMAC，不能猜当前绑定。该异常需受控核验，见已知问题。

## 交付物

- 已实现：账户/发件域/订阅配对/schema/大小验证，eventId 去重，精确 messageId 关联，FEEDBACK_BATCH 消费，FEEDBACK_MAX_RETRIES 与 DLQ 声明，提交后 ack。
- 已实现：先到反馈有限保留并 Queue retry，管理用有限页再关联入口；没有按相同标题猜关联。
- 已实现：投诉/终态硬退信/明确 suppressed 拒绝的本地冻结；同批关闭仍匹配的旧绑定通道；晚到成功不解冻；只读抑制不解除。
- 已实现：accepted=提交平台，jobs.provider_status=delivered 才是收件服务器接受；deferred 不重投。沿用现有状态源，没有新增“已读”语义。
- 待完成（本卡范围补充待确认）：正式精确地址 HMAC 原语。目前 wrapper 产生的 HMAC 用例正确，但复用 `computeEmailKey` 的输入不符合其“账号 canonical_email”注释约定，故草稿不作为最终交付。
- 网页恢复码/换邮箱提示的真实联调需 F4；当前授权范围没有前端/API 接线，未擅自扩范围。
- 真实 Queue 重试耗尽→DLQ、认证域订阅取证：未执行，需所有者执行。

## 执行过的命令与结果

以下均实际执行；本地时间为 2026-09-30 UTC+8。

| 命令 | 真实结果摘要 |
| --- | --- |
| `cat AGENTS.md`、读取上述合同/任务卡/交接文档 | 完成；按门禁与范围开展工作 |
| `gh pr view 38 --json state,mergedAt,mergeCommit,baseRefName,url`（首次沙箱） | 失败：无法连接 api.github.com；随后获网络执行权限重试成功，MERGED |
| `git fetch origin main` | 成功；基线 a1b6084，提交前复核相同 |
| `git switch -c p4/P4-07-feedback` | 只在独立工作树执行成功 |
| `pnpm install --frozen-lockfile` | 成功；锁文件未改，258 packages |
| `pnpm exec biome check --write <本卡新增目录及授权接线文件>` | 只格式化本卡文件，成功 |
| 首轮 `pnpm --filter @hoyo/worker typecheck` | 失败：Worker 无 zod 直接依赖；改用现有依赖与原生边界验证，未加依赖 |
| 第二轮 typecheck | 失败：测试 raw JSONC 导入声明、合成 MessageBatch 缺 metadata；改用项目已有 import.meta.glob 模式并补真实类型字段 |
| 首轮定向 `pnpm --filter @hoyo/worker exec vitest run src/mail/feedback/feedback.test.ts` | 26 通过 / 1 失败；换绑数据库触发器已经关闭通道，测试前置未模拟新邮箱重新同意。补正确前置后 27/27 通过 |
| 后续同一定向命令 | 新增故障/接线用例后依次 29/29、最终 33/33 通过 |
| 两条临时变异 + 同一定向命令 | deferred 误冻结：1 失败 / 32 通过，退出 1；提前 ack：4 失败 / 29 通过，退出 1。两条均击杀并自动还原 |
| `pnpm lint`（最终） | Checked 351 files；无修改，退出 0 |
| `pnpm typecheck`（最终） | contracts/worker/web/e2e 类型检查全过，退出 0 |
| `pnpm test`（首轮全量） | contracts 198，Worker 647 通过 |
| `pnpm test`（最终全量） | contracts 198 / 24 files，Worker 651 / 49 files 全过，退出 0；本卡 33 条包含在 Worker 中 |
| `pnpm params:verify` | 25 条数值等式成立、0 不成立；另有 1 条语义约束声明 |
| `pnpm migrate:check` | 0001–0019 静态检查通过；7 条真实 D1 schema/索引/重放测试通过 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/P4-07-wrangler.log pnpm build` | Web 22 页完成；Worker dry-run 产物已生成但 5 分多钟未自行退出。按 ENGINEERING §3 终止本次 Wrangler PID 70334/70317；外层最终返回 0，但因为人工中断，**不计为构建验证通过**，以 CI 为准 |
| `ps -eo ...`（沙箱） | 失败：operation not permitted；获执行权限后只定位本次构建进程 |
| `git diff --check` | 通过 |
| `pnpm test:e2e` | 未执行：本卡不改页面，属于 Worker 反馈处理；未借用历史截图作为本卡证据 |
| 远端 D1/Queue/邮件/部署命令 | 未执行；没有真实外发、没有创建/删除/修改 Cloudflare 资源 |

## 验收测试

全部本卡测试在 `apps/worker/src/mail/feedback/feedback.test.ts`，标题带 A-P4-FEEDBACK；以下为实际通过的用例组。

| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| A-P4-FEEDBACK | feedback.test.ts: P0-05 四次 deferred soft bounce 后 delivered | 通过；无抑制、不重投、不当已读 |
| A-P4-FEEDBACK | feedback.test.ts: eventId 并发去重与重复投递，unknown 预算只结算一次 | 通过；真实并发 D1 |
| A-P4-FEEDBACK | feedback.test.ts: 反馈先到保留后 retry，精确 messageId 后到自动重试关联 | 通过；去尖括号的错误 ID 不匹配 |
| A-P4-FEEDBACK | feedback.test.ts: complained/bounced 优先于晚到成功，两层关闭且既有只读抑制不被解除 | 2 条通过 |
| A-P4-FEEDBACK | feedback.test.ts: 旧绑定投诉只冻结旧地址；当前认证 outbox 缺失 binding 时按版本和精确地址补关联 | 通过；区分旧地址、当前绑定与历史不可恢复 |
| A-P4-FEEDBACK | feedback.test.ts: 回执已提交但抑制事务失败，不 ack；重试补齐 | 通过；真实 D1 trigger 注入失败与回滚 |
| A-P4-FEEDBACK | feedback.test.ts: 完成提交前租约已被接管，旧处理者不关闭通道或写抑制 | 通过；守卫未命中零副作用 |
| A-P4-FEEDBACK | feedback.test.ts: 处理者崩溃租约到期后可恢复 | 通过 |
| A-P4-FEEDBACK | feedback.test.ts: 拒绝错误 account/subscription/domain/sender/version/type/terminal/size/shape/recipient | 10 条通过；最终尝试仍 retry，不伪造 ack；日志无载荷 |
| A-P4-FEEDBACK | feedback.test.ts: 未关联容量并发边界；反馈总容量上限；孤儿反馈维护；并发汇总 | 通过；1000/20000 实际注册表容量形状 |
| A-P4-FEEDBACK | feedback.test.ts: Queue 配置由注册表约束；Worker 默认导出接线，原生测试批次只 ack 已提交事件 | 通过；原生 cloudflare:test 批次确认 ack/retry |
| A-P4-FEEDBACK | feedback.test.ts: eventId 热查询加入大量无关历史后 rows_read 不增长 | 通过；加 2000 行历史后读数不增 |
| A-P4-FEEDBACK | feedback.test.ts: 不同 eventId 乱序并发投诉与成功；认证域配对；明确 suppressed 拒绝；相同 eventId 内容冲突 | 通过 |

未覆盖的真实证据：平台自动转入 DLQ 的最终资源行为、认证域事件订阅/时延/平台 read_only 核验、网页真实状态联调。前两项需要所有者真实环境，页面不在本卡授权范围。没有把这些写成通过。

## 证据

- 已提交合成事件与可重跑测试：`apps/worker/src/mail/feedback/feedback.test.ts`。
- 模块行为、公式、部署清单：`apps/worker/src/mail/feedback/README.md`。
- 本机临时日志（不提交，含实际测试输出）：`/tmp/P4-07-test.log`、`/tmp/P4-07-test-final.log`、`/tmp/P4-07-build.log`、`/tmp/P4-07-wrangler.log`、`/tmp/P4-07-mutation-deferred-freeze.log`、`/tmp/P4-07-mutation-premature-ack.log`。
- 平台事实来自仓库现有 P0-05 登记；本卡未新取真实收件人/邮件证据，不复刻真实地址、messageId 或邮件正文。
- **需所有者执行的前置**：认证域订阅创建与 ID/域配置，HTTP pull→Worker 消费者切换，DLQ 存在性及重试耗尽/重放取证，crypto 配置注入，平台抑制受控核验，账户共享用量核对。本卡没有执行这些动作。

Queue 操作量（来源：[Cloudflare Pricing](https://developers.cloudflare.com/queues/platform/pricing/)，2026-09-30 读取）：Paid 包含 1,000,000 次/月。MAIL_TOTAL_DAY=260 × 31 天 × 实测 5 事件/封 = 40,300 条；通常 3 操作/条即 **120,900** 次。为每条 8 次重试、DLQ 写入与后续消费保守留 16 操作/条，**644,800** 次，在包含量内。余量 355,200 必须扣除同账户其他 Queue 使用；每封事件数没有已验证硬上限，8 事件/封同模型会超过包含量，因此不能宣称异常流量绝对零超额。没有引入任何月度邮件池或扩大配额。

## 不在本次范围

任务卡未另列“不在范围”清单；按授权边界确认未实现：邮件预算批准/重试预算（P4-04）、两层同意 API（P4-05）、退订 API 与模板/DKIM（P4-06）、P5 全局观测及 Cron 维护接线、F4 页面真实状态联调。没有改动回执原语、认证发信路径或其他任务卡。没有新增供应商、切换发件域绕过抑制、真实发信或 Cloudflare 资源操作。

## 已知问题与回退点

1. **待所有者确认的本卡最小范围补充**：现有 `computeEmailKey` 的文档约定只接收账号 canonical_email；精确地址抑制要求保留本地部分大小写。当前 wrapper 临时使用其底层 HMAC 运算并带 `suppression-address:v1` 标签，字节结果有测试，但不应让正式实现违反该原语的输入约定。拟仅在 mac.ts 新增 `computeExactAddressKey(EmailLookupKey, deliveryAddress)`，内部复用已有 hmacSign 并带相同标签，mac.test.ts 补确定性/大小写区分/与身份键隔离用例；调用侧改用正式函数，键字节保持不变。已异步请求授权，**未获回答，不当作同意**。此项完成前 PR 保持 Draft。
2. 注册前尚无 user/binding、已换绑且历史认证 outbox 没有 binding 的反馈，无法凭现有表重建旧绑定。保留精确地址 HMAC 的 unbound 异常，不关闭新地址、不靠主题或账号身份猜测；需要所有者核验/后续卡补历史绑定来源。本卡没有修改认证任务的存储含义。
3. 新本地抑制的 read_only 锁不是来自平台查询；必须受控核验后才讨论解除。R14 当前 scope 变化需所有者后续更新合同平台事实；本卡不降低本地冻结要求。
4. 满日额度 × 每封 5 个反馈 × 30 天 = 39,000，超过 MAIL_FEEDBACK_MAX=20,000。容量满会拒绝新反馈、重试至 DLQ；既定参数不改，需 P5 观测与所有者控制实际开放量。DLQ 有保留期，不能长期无人处理。
5. 无 Queue 流量时没有自动清理/再关联：已导出有限页原语，P5 需在墙钟内循环调用。当前每 Queue 批一页清理；单页大小直接来自 FEEDBACK_BATCH。未关联异常不会为了腾位自动删除。
6. eventId/messageId 点查使用既有索引；总容量计数、到期选页仍在 MAIL_FEEDBACK_MAX 封顶内扫描，没有为它们扩范围新增迁移。生产读量与大量故障下 DLQ 成本需 P5-04 的真实负载验证。
7. 本地 build 经人工终止，不能视作自然完成；以本 PR CI 构建结果为准。
8. 回退点：`a1b60841210a861b8863f00811f2c06865e642a4`。本卡无迁移，代码回退不需数据库回滚；已留存的反馈/抑制不要为了回退而删除。未创建任何远端资源。
