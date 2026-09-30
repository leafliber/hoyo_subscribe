# P4-07 返工报告（2026-09-30—2026-10-01）

本文追加到 PR #41 原描述末尾；此前报告保留为历史。旧报告中的草稿授权阻塞、未关联永不清理和已完成记录占满容量等限制已由本次返工替代。

## 任务卡

P4-07 · 反馈 Queue 消费、关联与抑制 · 阶段 P4。对应任务卡「复核（2026-09-30，`4b36dfb`）」与所有者本轮列出的七项要求。继续原独立工作树及 `p4/P4-07-feedback`，未切换或改写主工作区。

开工及提交前均执行 `git fetch origin main`；最新 main 为 `1a6f41d`，P4-03 PR #38 和 P3-06 PR #35 均已合入。`ffc2125` 合并最新 main，`index.ts` 的冲突保留双方 Feed 与 Queue 接线；相对 main 仍只有本卡 Queue 导出。

## 改动范围

本次返工相对 `ffc2125`：

- `apps/worker/src/mail/feedback/store.ts`：关联准入、到期匿名汇总、容量压力回收、CAS 清理守卫、已关联 pending 重放。
- `apps/worker/src/mail/feedback/feedback.test.ts`：两个容量探针、保护记录、匿名汇总并发、已关联重试、冲突不 ack、投诉优先和 Queue 配置回归。
- `apps/worker/src/mail/feedback/README.md`、`DELIVERY.md`、`REWORK.md`：当前说明、本轮报告与旧报告的历史标注。
- `apps/worker/src/mail/feedback/rows-reporter.mjs`：仅测试的数字证据 reporter；不进入 Worker 运行路径。
- `apps/worker/src/mail/suppression/index.ts`：调用正式精确地址 HMAC 原语。
- `apps/worker/src/storage/crypto/mac.ts`、`mac.test.ts`：经本轮授权新增精确地址原语与兼容性测试。
- `apps/worker/src/storage/expected-schema.ts`、`schema.test.ts`：经授权追加两个清理索引、满容量实际 D1 读量基准。
- `migrations/0021_mail_feedback_cleanup_indexes.sql`：经授权新增两个部分时间索引，不更改既有迁移。
- `apps/worker/wrangler.jsonc`、`apps/worker/worker-configuration.d.ts`：经授权删除 P1 占位 Queue 声明并再生成类型。

首轮保留的 `feedback/schema.ts`、`feedback/index.ts`、`src/index.ts` 仍属于本卡 PR，返工未扩大其行为。没有修改 contracts 参数、回执原语、锁文件、其他任务卡或验收方文档。E2E 自动重绘的两张 F2-01 历史截图已恢复，不纳入交付。

## 继承的合同

AGENTS 全文、BUILD_PLAN §2、P4-07 全卡及复核、P4-03 验收登记、platform-facts §2.2、outbox/README；主方案 §7.5 后半、§7.7、A.4 `FEEDBACK_*` 与 A.5 保留参数；[R06](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)、[R14](https://developers.cloudflare.com/email-service/concepts/suppressions/)。

采用验收方已裁定的含义：TTL 为保留上限；未关联异常的「有限」同时限制数量和时间；已关联不等于已完成。满 TTL 的未关联行按 kind 只留匿名异常计数；容量压力只提前汇总 done。继续采用已认可的入口大小限制、本地 `feedback_requires_verification` 锁、R14 scope 差异下不降低冻结、历史无绑定时保留 unbound HMAC 等保守解释。所有回执仍通过 `recordMailReceipt`；accepted/delivered 都不代表已读。

容量余量由 `MAIL_FEEDBACK_MAX - FEEDBACK_BATCH` 推导，没有新增业务阈值。参数只引用 contracts 注册表；文中数字是当前注册表和实测结果的展开，不是第二份运行配置。

## 交付物

按所有者本轮七项逐条对应：

| 项 | 完成情况与证据 |
| --- | --- |
| 1 未关联反馈生命周期与直接关联 | 完成。先精确查询 messageId，已知 outbox 直接带 ID 插入，不占未关联名额。每次新准入前清理到期页；满 TTL 的未知反馈通过 CAS 汇总至 `mail_feedback:unmatched_expired:<kind>` 后删除。计数不含地址、用户或 messageId。新的未知消息在未关联池真满时仍 retry。 |
| 2 总容量压力回收 | 完成。临近容量先汇总最旧显式 done 行至 `mail_feedback:archived:<kind>`，之后原子 INSERT 再查硬上限。无可回收完成行时允许用剩余硬容量。处理中、待重试、未过期未知行不删；清理以 raw_ref 与关联 ID 的快照作 CAS，选页后的领取/关联/完成不会被旧清理者删除。 |
| 3 两个原失败探针 | 完成。1000 条满 TTL 的未知行在库时，已知投诉 ack、关两层通道、加 complaint 抑制，后续分页最终匿名计数为 1000。20000 条新近完成行时，10 条新反馈含投诉全部 ack、关闭通道并抑制，总量不越上限。另测 1000 条未到期未知行同样不阻挡可关联投诉。 |
| 4 迁移、索引与读量 | 完成。0021 增加完成和未关联清理的 `(created_at,id)` 部分索引；expected-schema 与 schema.test 同步。三个清理查询验证索引且无临时排序；两个 COUNT 路径和完整满容量处理批次都有实际 rows_read 断言，月读量见下文。 |
| 5 正式精确地址 HMAC | 完成。新增 `computeExactAddressKey`，复用 hmacSign，保留 `suppression-address:v1` 与编码；生产调用改用它。三条测试验证确定性/旧 wrapper 字节一致、本地部分大小写区分、账号身份键隔离。 |
| 6 两项存活变异回归 | 完成。同 eventId 内容冲突不 ack，整条已存记录不变；先投诉后硬退信，抑制 kind 保持 complaint。 |
| 7 删除占位 Queue | 完成。仅本地删除 `mail-feedback` producer/consumer，再生成 d.ts 移除 MAIL_FEEDBACK_QUEUE；测试断言无 producer、只留 hoyo-mail-events consumer，其批量与重试参数等于注册表。没有删除远端资源。 |

七项代码要求无遗漏。任务卡中额外列出的真实部署前置没有执行，见下文。原交付的受控消费、乱序优先级、旧地址隔离、只读抑制保护、提交后 ack 等继续由 40 条反馈测试覆盖。网页恢复码/换邮箱提示仍由 F4 接线，本卡未擅自写页面或状态 API。

## 执行过的命令与结果

均为本次实际执行，时间 2026-09-30—2026-10-01（UTC+8）。

| 命令 | 真实结果 |
| --- | --- |
| `git fetch origin main`、在原工作树合并最新 main | 成功；main `1a6f41d`，合并提交 `ffc2125`；手工解决 index.ts 接线冲突并保留双方 |
| `pnpm install --frozen-lockfile` | 退出 0；锁文件不变 |
| `pnpm lint` | 最终退出 0，Checked 364 files，无修改 |
| `pnpm typecheck` | 最终退出 0，contracts/worker/web/e2e 全部通过 |
| `pnpm test` | 最终退出 0，contracts 211 / 26 files，Worker 715 / 53 files；本卡反馈 40 条包含其中 |
| `pnpm migrate:check` | 退出 0；0001–0021 空库重放与预期 schema/索引，10 条测试通过 |
| `pnpm params:verify` | 退出 0；26 条数值等式成立、0 不成立，另有 1 条语义条款声明 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/P4-07-rework-build-wrangler.log pnpm build` | Web 22 页构建完成；Worker dry-run 生成产物后超过五分钟未退出。按 ENGINEERING §3 终止本次 Wrangler PID 33950/33938。外层退出 0，**人工中断，不计本地 build 通过**；PR CI 的原始 build 结果另补在 PR 末尾 |
| `pnpm test:e2e` | 退出 0；105 passed / 5 skipped，8.6 秒。5 个既有设备分工跳过：3 个纯计算仅桌面执行、2 个移动视口只在移动端执行；未算作通过 |
| `WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/P4-07-rework-types.log pnpm --filter @hoyo/worker run types` | d.ts 已生成，实际 diff 仅生成 hash 与移除占位绑定；进程超过八分钟未退出后手动终止 PID 25143/25036，不声称命令自然成功。生成物已由 typecheck/Queue 配置用例验证 |
| `pnpm --filter @hoyo/worker exec vitest run src/mail/feedback/feedback.test.ts src/storage/crypto/mac.test.ts src/storage/schema.test.ts --reporter=default --reporter=./src/mail/feedback/rows-reporter.mjs` | 62/62 通过：40 feedback、12 mac、10 schema |
| `pnpm --filter @hoyo/worker exec vitest run src/storage/schema.test.ts --reporter=default --reporter=./src/mail/feedback/rows-reporter.mjs` | 最后补齐第二 COUNT 路径后 10/10 通过，输出下述读量 |
| `pnpm exec biome check --write <本卡修改文件>` | 完成；仅格式化本卡文件 |
| 新 schema 基准首轮 lint / test | 首次 lint 失败：forEach 箭头返回 push 数值，改为 void 块；首次 schema 测试 9 过 / 1 失败：未知 TTL 页读 2001 行，SQLite 选旧索引后排序。显式选新部分索引后 10/10 通过，读 10 行。未隐去这两次失败 |
| `ps -eo ...`（沙箱） | 被系统拒绝 operation not permitted；获执行权限后只定位并终止本次本地 Wrangler |
| `git diff --check` | 通过 |
| 远端 D1 / Queue / 发信 / 部署 | 未执行；没有创建、删除或修改 Cloudflare 资源，没有真实邮件 |

## 验收测试

| 验收 ID | 测试文件:用例名（或用例组） | 实际结果 |
| --- | --- | --- |
| A-P4-FEEDBACK | feedback.test.ts: 探针一：1000 条过期未关联不阻挡可关联投诉，异常到期汇总 | 通过；关两层通道、加抑制、匿名计数 1000 |
| A-P4-FEEDBACK | feedback.test.ts: 未过期未关联已满，可关联投诉仍直接入库且不占未关联池 | 通过；保留 1000 条未到期未知记录 |
| A-P4-FEEDBACK | feedback.test.ts: 探针二：20000 条新近完成记录时一批新反馈含投诉全部处理 | 通过；10 条 ack，投诉生效，容量/汇总守恒 |
| A-P4-FEEDBACK | feedback.test.ts: 压力回收只删最旧 done，不删处理中、待重试、未过期未关联 | 通过；保留更晚完成行与三种保护行 |
| A-P4-FEEDBACK | feedback.test.ts: 过期异常汇总并发只计一次，已取得活跃租约的旧行不删 | 通过 |
| A-P4-FEEDBACK | feedback.test.ts: 已关联待重试的反馈可由维护重放，关联不代表完成 | 通过 |
| A-P4-FEEDBACK | feedback.test.ts: 相同 eventId 内容冲突不能覆盖已有记录或伪造关联 | 通过；不 ack，整条存储快照不变 |
| A-P4-FEEDBACK | feedback.test.ts: 先投诉后硬退信，抑制种类仍为投诉 | 通过 |
| A-P4-FEEDBACK | feedback.test.ts: Queue 配置由注册表约束、默认导出、边界验证、原 P0-05 序列与故障恢复 | 所有 40 条反馈测试通过 |
| A-P4-FEEDBACK / A-P1-CRYPTO | mac.test.ts: 精确投递地址 HMAC 三条（确定性/旧键一致、大小写、身份隔离） | 3 条通过；文件 12 条全过 |
| A-P4-FEEDBACK / A-P1-DB | schema.test.ts: 容量 COUNT 按上限封顶、TTL/压力清理使用时间索引；满容量实际批次月度估算 | 2 条通过；文件 10 条全过 |

未覆盖且不计通过：A-P4-FEEDBACK 的真实 Queue 重试耗尽转 DLQ、认证域订阅事件、平台抑制 read_only/expiry 核验、网页真实提示联调；分别属于所有者真实环境前置与 F4 后续范围。没有用模拟事件替代外部证据。

## 证据

合成事件来自 P0-05 形状，所有地址/ID 均为测试数据；测试执行在本地 workerd/D1，**不是生产 D1 性能取证**。可重跑源码：feedback.test.ts、mac.test.ts、schema.test.ts 与 rows-reporter.mjs。

实际本地日志：`/tmp/P4-07-rework-checks.json`、`/tmp/P4-07-rework-{install,lint,typecheck,test,migrate-check,params-verify}.log`、`/tmp/P4-07-rework-final-{lint,typecheck,test,focused}.log`、`/tmp/P4-07-rework-rows-final.log`、`/tmp/P4-07-rework-build.log`、`/tmp/P4-07-rework-build-wrangler.log`、`/tmp/P4-07-rework-e2e.log`、`/tmp/P4-07-rework-types.log`。临时日志不进入仓库；PR CI 提供可访问的命令证据。

满容量实测数字：

| 路径 | rows_read |
| --- | ---: |
| 20000 行时总容量 INSERT 拒绝 | 20002 |
| 19999 行、其中 1000 未关联时，未知 INSERT 经两个 COUNT 拒绝 | 21002 |
| 已完成 TTL / 已完成压力 / 未关联 TTL 各选一页 | 各 10 |
| 20000 行起步的一批 10 个已知反馈（末条投诉），包含容量失败重试、回执、清理、匿名计数与批末清理 | 240052（210 条 SQL 调用，12 次 INSERT 尝试） |

满日量 `MAIL_TOTAL_DAY=260`，按每封 3–5 个事件、31 天，月度读量为 `240052 / FEEDBACK_BATCH × MAIL_TOTAL_DAY × 31 × (3…5)` = **580,445,736–967,409,560 行**，约占 Workers Paid 250 亿包含读量的 **2.32%–3.87%**。[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)（2026-09-30 复查）。这是正常可关联反馈模型；未知消息另走最多 1000 行的 COUNT，额外重试和同账户其他查询不包含在此估算内，不能将它宣称为全账户总账。

Queue 按同一满日量、P0-05 实测 5 事件/封、31 天：40,300 条事件，通常每条 3 操作 = **120,900 次/月**；含每条 8 次重试与 DLQ 后续消费，按每条 16 操作保守预留 = **644,800 次/月**，均在 Workers Paid 每月 **1,000,000** 标准操作包含量内。[Queues 定价](https://developers.cloudflare.com/queues/platform/pricing/)（2026-09-30 复查）。前提是小消息、共享账户其他 Queue 不耗尽剩余 355,200；供应商延期事件数量没有实测硬上限，8 事件/封同模型将达 1,031,680，因此异常流量仍需 P5 观测与所有者限制开放量。未引入月度邮件池，也没有开通额外收费资源。

**需所有者执行的前置（均未执行）**：准备/核对 `hoyo-mail-events-dlq`；配置预期账户与业务/认证订阅域成对关系、crypto secrets；认证域事件订阅创建与取证；先摘取证用 HTTP pull consumer 再部署 Worker；验证真实重试耗尽/DLQ/重放、平台抑制属性、共享账户用量。与 DEPLOYMENT_PREREQUISITES.md 已登记项一致，本卡不重复修改该文档。

## 不在本次范围

未实现 P4-04 预算执行、P4-05 同意 API、P4-06 退订及模板/DKIM、F4 页面提示接线、P5 全局观测/Cron 清理。未修改认证发信与回执记账语义，没有自动解除抑制、猜关联、换域重试、真实发信或 Cloudflare 资源操作。AGENTS §3 的废弃撤销池、SEQUENCE、隐式筛选、月度池/envelope 等均未引入。

## 已知问题与回退点

1. **迁移编号**：提交前 main 最后是 P3-06 的 0020，本卡暂占 0021；P3-14 等并行卡可能也占该号，后合入的一方必须按届时 main 下一个编号改号并重跑 migrate:check。0019/0020 未改动。
2. 无 Queue 流量时，到期删除与 DLQ 修复重放仍需 P5 调用有限页入口；已关联待重试行保留，不能因其有 outbox ID 就删除。若容量全部被保护记录占用，正常失败关闭并 retry/DLQ，需要运维处理。
3. 历史无绑定反馈和新本地只读锁的核验、R14 平台 scope 事实更新、网页提示仍沿用首轮已认可的交接，不自行发明业务含义。
4. 本地 Wrangler build/types 未自然退出已明确记录；构建是否通过以本次 PR CI 原始命令结果为准，后续状态在 PR 末尾追加。
5. 返工回退点 `ffc2125`（保留主干集成的原实现，**仍含本轮修复前容量缺陷**）；若撤销整张卡，回到当前 main `1a6f41d`。新增迁移只有索引，代码回退无需删除反馈/抑制数据；不执行远端回滚或资源删除。
