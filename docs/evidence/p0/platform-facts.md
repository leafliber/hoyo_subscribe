# P0 · 平台事实登记表

> 每一格要么是**实测值**，要么是 `未取得`。**不允许留空、不允许写推测值。**
> 本轮填写：2026-09-22，由 Cloudflare MCP（账户 `0494fd40…ba30`，Leafliber@163.com's Account）**只读 API 查询**取得。
> 取值方式一律 `GET`，未创建、未修改、未部署任何资源。
> **2026-09-28 补充**：验收方经所有者授权（收件 `leaf@airo.cc`、发件 `yoho-sub@hoyo.airo.cc`）发送 1 封测试邮件，其余仍为只读查询；同样未创建、未修改任何资源。

## 1. 计费与资格（§2.2、§2.4、[R01][R02][R03]）

| 事实 | 值 | 取得方式 | 取得时间 |
| --- | --- | --- | --- |
| Workers 计划 | **Paid**（`workers.enabled = true`，全部 entitlement 于 2026-09-22T04:20:07Z 写入，即付费档开通时刻） | `GET /accounts/{id}/entitlements` | 2026-09-22 |
| 账户基础费 | **未取得**（需控制台 Billing 页；API token 无 billing scope） | — | — |
| **账单周期起止** | **不适用**——所有者确认本项目不考虑账单周期（见 ADR-0002） | 所有者确认 | 2026-09-22 |
| Email Sending 资格 | **已启用**（`email.sending.enabled = true`） | `GET /accounts/{id}/entitlements` | 2026-09-22 |
| **账户实际日发送权限** | **1,000 封/日**（`quota.value=1000, unit=day`；当前 `usage.sent=0`、`over_quota=false`） | `GET /accounts/{id}/email/sending/limits` | 2026-09-22 |
| 每周期包含量 | **不存在**——平台侧只有日限额，无周期包含量 | 所有者确认 | 2026-09-22 |
| 超额费率 | **不适用**（无周期计量即无超额） | 所有者确认 | 2026-09-22 |
| 账户其他应用已占用 | **零占用** | 所有者确认 | 2026-09-22 |
| Workers AI 可用性 | **已确认可用**（`GET /accounts/{id}/ai/models/search` → 200，目录 310 个模型）。⚠ **2026-09-22 更正**：此前记「entitlements 中无 `workers_ai.*` 故未证实」是**看错了信号**——Workers AI 在 Free 与 Paid 计划中**均默认包含**，不由 entitlement 行开通，所以该条目本就不存在 | `GET /accounts/{id}/ai/models/search` | 2026-09-22（更正） |
| Neurons 包含量 | **10,000 Neurons / 日**（Free 与 Paid **相同**），超出按 **$0.011 / 1,000 Neurons** 计费，每日 00:00 UTC 重置 | Cloudflare 官方文档 `workers-ai/platform/pricing` | 2026-09-22 |
| 目标模型在册 | `@cf/qwen/qwen3-30b-a3b-fp8` **在目录中**：Text Generation、`context_window = 32768`、`reasoning = true`、`function_calling = true`、`async_queue = true`。**不在「需付费计费方式」的受限模型名单内** | 同上 models/search | 2026-09-22 |
| 目标模型单价 | **$0.0509 / M 输入 token**、**$0.335 / M 输出 token**（官方说明：token 单价与 Neuron 单价等价，只是两种显示单位） | 同上 | 2026-09-22 |
| Neuron 换算（本项目推导） | 输入 **≈ 4.63 Neurons / 1,000 token**；输出 **≈ 30.45 Neurons / 1,000 token**。**输出是输入的 6.58 倍** | 由上两行按 $0.011/1,000 Neurons 换算 | 2026-09-22 |

### 附带取得的其他计量项（供 §4.1 成本护栏参考）

| 项 | 值 |
| --- | --- |
| D1 | 已启用；单库 10,000 MB；账户合计 1,000,000 MB；最多 50,000 个库 |
| Queues | 已启用；最多 10,000 个队列；最大保留 96 小时 |
| Workers 静态资源 | 单文件 26,214,400 B；清单最多 20,000 文件 |

## 2. 域与配置（§2.2、[R04]）

2026-09-28 经 API 只读取得（`GET /zones/{zone}/email/sending/subdomains`、`…/dns/status`）；认证域于 2026-09-28T17:06:45Z
按所有者决定（方案 B）经 API 创建，创建前先用 `…/subdomains/preview` 空跑确认只新增该子域下的记录、无冲突。

| 事实 | 值 |
| --- | --- |
| 站点 origin | 未取得（所有者尚未指定） |
| 发件子域 | **两个，按用途分开**：认证 `auth.hoyo.airo.cc`（2026-09-28 创建，id `00d5aa64a69b4708b99f4aa292aed2e4`，退信域 `cf-bounce.auth.hoyo.airo.cc`）；业务 `hoyo.airo.cc`（2026-09-22 创建，退信域 `cf-bounce.hoyo.airo.cc`）。DKIM selector 都是 `cf-bounce` |
| 认证域 Email preview 已关闭 | ✅ `auth.hoyo.airo.cc` 的 `preview_enabled = false`。业务域 `hoyo.airo.cc` 仍为 `true`（原文留存约 7 天、可经 API 取回，便于排查；合同只要求关认证域） |
| 两用途"静默丢弃受抑制收件人"已关闭 | ✅ 两个子域的 `drop_suppressed_recipients` 都是 `false` |
| DNS 已 verified | ✅ 两个子域的 `dns/status` 都是 `ready`：各自的 `cf-bounce` MX（route1–3）与 SPF、DKIM、`_dmarc`（`p=reject`） |
| 确认未覆盖既有收信系统 | ✅ 创建后复查：`airo.cc` 的 MX 仍是阿里企业邮（`mx1–3.qiye.aliyun.com`）、SPF 未动；新记录全部在 `auth.hoyo.airo.cc` 之下 |

两个子域的 DKIM 公钥相同（同一份账户级密钥），但签名的 `d=` 分别是各自的子域，收件方按域计的信誉仍然分开；
抑制名单与账户信誉则是整个账户共用的（§7.7 已写明）。

### 2.1 真实收件人发送实测（2026-09-28）

| 收件邮箱类型 | 发件子域 | messageId | 反馈 Queue 是否收到事件 | 事件序列 | 收件服务器接受 | 进收件箱/垃圾箱 |
| --- | --- | --- | --- | --- | --- | --- |
| 阿里企业邮（`leaf@airo.cc`） | `hoyo.airo.cc` | `<K1KCchFjlnFJ7q4wNOAxp8ti2FA1zAcdTOlf@hoyo.airo.cc>` | **未取得**：账户里还没有 Queue 与事件订阅 | 发送 API 返回 `queued`（05:19:12Z）；GraphQL `emailSendingAdaptive` 显示 `delivered` | ✅ `delivered` | ✅ 所有者 2026-09-28 确认已收到（收件箱还是垃圾箱未说明） |

同一次实测取得的其他事实：

- **自定义头可以设置**：发送时带的 `List-Unsubscribe` 与 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` 原样出现在平台保存的原文里。
  **DKIM 签名是否覆盖这两个头：未取得**——平台保存的是签名前的原文，要看收件箱里收到的原始邮件头。
- **日额度窗口不是 UTC 日**：首封发出后 `usage.resets_at = 2026-09-29T05:19:12Z`，即首封发送 + 24 小时。
  应用侧按 UTC 日计（`MAIL_TOTAL_DAY`）；任何 24 小时窗口最多跨两个 UTC 日，所以真正需要的是
  `2 × MAIL_TOTAL_DAY ≤ PLATFORM_MAIL_DAY_LIMIT`。当前 520 ≤ 1,000 成立，但 A.5 里只校验了 `MAIL_TOTAL_DAY ≤ PLATFORM_MAIL_DAY_LIMIT`。
- 本次走的是 REST `POST /accounts/{id}/email/sending/send`；P4-03 计划的首版路径是 Worker `send_email` 绑定，届时在绑定路径上复核一次。

所有者 2026-09-28 反馈：第一封进了**收件箱**，但阿里企业邮提示"由 bounces@cf-bounce.hoyo.airo.cc 代发，请谨慎处理"。
原因是信封发件人（退信地址 `cf-bounce.hoyo.airo.cc`）与 From 的域不完全相同；发件子域的 API 只开放 `preview_enabled` 与
`drop_suppressed_recipients` 两项，**退信域不能改**，这条提示无法靠配置消除。验证码邮件的收件人会看到它——登录页要提前说明（已写进 F3-01 卡）。

### 2.2 反馈事件链路（2026-09-28，经所有者批准创建）

| 资源 | 值 |
| --- | --- |
| Queue | `hoyo-mail-events`（`298784a98e974ad0aa7eceb293bebc5a`），当前消费者为 HTTP pull（取证用；P4-07 上线时换成 Worker 消费者） |
| 事件订阅 | `hoyo-mail-events-hoyo-airo-cc`（`c1c84820b159438d9670f3dd74a07a95`）：来源 `email.sending`、域 `hoyo.airo.cc`，六类事件全开 |
| 认证域的事件订阅 | **未建**。订阅按发件域建，认证域 `auth.hoyo.airo.cc` 的退信与投诉也要进同一个 Queue（§7.5、§7.7）；上线前经所有者批准再建 |
| 第二封测试 | 发件 `hoyo-sub@hoyo.airo.cc` → `leaf@airo.cc`，2026-09-28T12:50:45Z 发出，messageId `<peL3Jr9nVcZeqAT08LcMA4PFONudMVndkkPu@hoyo.airo.cc>`，发送 API 返回 `queued` |

发件地址以所有者确认的 `hoyo-sub@hoyo.airo.cc` 为准（第一封用的 `yoho-sub` 是笔误）。

**第二封的实际结果（2026-09-29 复查定稿）**：Queue 收到 `cf.email.sending.message.deferred` 事件，`payload.messageId`
与发送接口返回值**逐字相同**，`terminal: false`，SMTP `400 … Temporary failure`——**事件进 Queue、按 messageId 关联，这条链路已经证实**。
阿里企业邮在 12:50:46、12:51:01、12:52:15、13:02:38 四次临时拒收，平台自行重试（间隔约 15 秒、74 秒、10 分钟、31 分钟），
**13:33:53 送达**：Queue 收到 `cf.email.sending.message.delivered`，`terminal: true`，同一 messageId，`delivery.deliveryTimeMs = 8898`。
Queue 积压共 5 条（4 条 deferred + 1 条 delivered），与分析数据集的 5 行一致；分析数据集把中间态记为 `deliveryFailed`、
Queue 记为 `deferred`，两处叫法不同，P4-07 以 Queue 事件的 `terminal` 为准。`deferred` 事件还带
`bounce: {type: "soft", classification: "temporary_failure"}`，不是退信。第一封（发件 `yoho-sub@`）则是一次送达。

**一个上线前要看清的风险**：第二封从发出到送达用了 **43 分钟**，而验证码有效期 `OTP_TTL = 600` 秒。
如果验证码邮件也这样被暂缓，用户收到时码已过期。两封样本不足以判断原因（第一封一次送达；第二封换了 local-part、
带了 List-Unsubscribe 头、是当天第二封）。认证域 `auth.hoyo.airo.cc` 还没发过信，建议所有者批准后从认证域发 1–2 封
不含真实验证码的测试信量时延，再决定是否需要处理。

G-P0-MAIL 的两项条件都已满足（普通收件人的 messageId 与 Queue 关联、`PLATFORM_MAIL_DAY_LIMIT` 实测值）。
`leaf@airo.cc` 是普通收件人而非 routing verified destination：2026-09-29 查 `GET /accounts/{id}/email/routing/addresses`，账户里没有任何目标地址（§2.4 的前提成立）。
第二家不同的邮箱服务商所有者 2026-09-28 决定暂缓：在此之前**只对阿里企业邮有送达实测**，不得外推到其他服务商。

## 3. 对预算基线的影响（§9.1、§9.3、附录 A.5）

| 校验项 | 结论 |
| --- | --- |
| 预算模型 | **纯日额度**（ADR-0003；月度池、envelope、carry 全部取消） |
| `MAIL_TOTAL_DAY = 260 <= PLATFORM_MAIL_DAY_LIMIT = 1,000` | ✅ **成立**（占 26%） |
| `MAIL_BASE_DAY 50 >= MAIL_ROUTINE_SEATS_MAX 40 × MAIL_USER_BASE_DAY 1` | ✅ **成立**（1.25x 重试余量） |
| `MAIL_URGENT_DAY 120 >= MAIL_SEATS_MAX 100 + MAIL_URGENT_FLOOR 20` | ✅ **成立**（取等号） |
| ~~包含量 − 其他应用占用 ≥ MAIL_TOTAL_MONTH~~ | **已删除**——平台无周期计量（ADR-0003） |

### 一个需要写进设计判断的发现

**平台侧只有一个约束：1,000 封/日。**没有周期包含量，没有超额计费，没有其他应用占用。

这直接推翻了 v2.1 §9 的整个月度预算框架——月度池保护的是一个不存在的稀缺资源。
所有者据此决定改为**纯日额度模型**（ADR-0003）：

- `MAIL_TOTAL_DAY` 从 175 提到 **260**，仍只占平台日上限的 26%。
- `MAIL_SEATS_MAX` 从 50 提到 **100**；`MAIL_URGENT_DAY` 必须跟着从 60 提到 **120**，
  否则一次官方取消只能覆盖 60/100 个席位——而取消正是邮件唯一不可替代的价值。
- envelope、`carry`、`E=1` 兜底、认证软线、月末半日片段**全部删除**。
  这些是 §9.2 里最容易写错的部分，现在整块消失。
- 两个 floor 的口径从"月剩余"改为"当日剩余"，**降级行为不变**。

**跨日保护反而更强**：月度模型下几天的异常流量能烧掉整月的登录能力，floor 触发后要等下个月；
日模型下最坏只影响当天，次日自动恢复。

**代价**：跨日结转没有了。一天内两次全量取消时，第二次只能覆盖 20 个席位——
该场景的概率与后果已由所有者接受（ADR-0003）。

## 4. 仍需所有者在控制台取得的（按优先级）

| # | 事实 | 为什么卡着 |
| --- | --- | --- |
| 1 | ~~**Workers AI 的可用性与 Neuron 包含量**~~ **已解决（2026-09-22）**，不再需要所有者执行 | 可用性已证实、包含量 10,000 Neurons/日已查明。**关键结论：`AI_HARD_DAY = 8,000` < 免费额度 10,000，硬线守住即零费用。** 剩余未知只有一个数——`reasoning = true` 的**思考 token 计入计费输出**，其分布未测，见 P0-03 |
| 2 | ~~发件域与 DNS（§2 整节）~~ **已解决（2026-09-28）**：认证与业务两个子域都已就绪 | — |
| 3 | 收到的测试信原始邮件头（阿里企业邮"显示原文"） | 核对 DKIM 签名的 `h=` 是否覆盖 `List-Unsubscribe` 与 `List-Unsubscribe-Post`（§7.6 要求）；P4-06 验收前要有 |
| 4 | 是否批准从认证域发 1–2 封测试信 | 量验证码邮件的实际时延（见 §2.2 的风险） |

> 邮件计量口径的三项已由所有者确认关闭（见上）。

## 5. 结论

| 门禁 | 状态 | 依据 |
| --- | --- | --- |
| G-P0-MAIL | **已开（2026-09-29）** | 计量口径已全部确定（日限额 1,000、无周期包、零占用），A.5 相关等式成立；两个发件子域 DNS 就绪；真实收件人的 messageId ↔ 反馈 Queue 关联已证实（§2.2）。已知限制：只测了阿里企业邮；DKIM `h=` 未核；验证码时延风险待量 |
