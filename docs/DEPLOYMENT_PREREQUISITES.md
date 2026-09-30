# 部署前置清单

> 各任务卡交付时产生的「需所有者执行」项集中于此，避免散落在 PR 描述里丢失。
> **每项都是上线前必须完成的**；未完成时对应能力按 fail-closed 处理（不降级、不假成功）。
> 新增项由交付卡的验收方登记，注明来源卡与依据章节。

## 1. Secrets（经 Wrangler secret 注入，不进仓库）

| Secret | 来源卡 | 用途 | 未注入时的行为 |
| --- | --- | --- | --- |
| `CRYPTO_MASTER_SECRET` | P1-06 / P1-08 | 除 OTP MAC 外八个用途的 HKDF 派生根 | 写路由 fail-closed 503 |
| `CRYPTO_OTP_PEPPER` | P1-06 / P1-08 | OTP MAC 独立 pepper（§4.3 双根） | 同上 |
| `CRYPTO_UNSUBSCRIBE_KEY_ID` | P1-06 / P1-08 | 退订 token 的 key_id | 同上 |
| `TURNSTILE_SECRET_KEY` | P2-01 | Turnstile 服务端 siteverify（[R09]） | 第 4 步失败关闭 |

生成方式见 `docs/ENGINEERING.md` §4；**九个用途各自独立，不得复用同一份材料**（P2-01 新增第 9 个 `preauth-cookie`）。

## 2. 平台侧配置

| 项 | 来源卡 | 依据 | 说明 |
| --- | --- | --- | --- |
| **按 IP 的边缘限速规则** | P2-01 | §4.2 第 3 步、§8.3、[R16] | ⚠ 应用侧只做**同邮箱**近似限速——附录 A 无 IP 维度参数，按 [R16] 该维度属边缘。**边缘规则未配时，换邮箱即可绕过第 3 步**；这不是应用缺陷，但上线前必须配 |
| ~~发件子域与 DNS（认证域 / 业务域分开）~~ **已完成（2026-09-28）** | P0-05 | §2.2 | 认证 `auth.hoyo.airo.cc`（preview 已关）、业务 `hoyo.airo.cc`；两者都关了「静默丢弃受抑制收件人」，DNS 均 ready。见 `docs/evidence/p0/platform-facts.md` §2 |
| 反馈 Queue 的消费者 | P0-05 / P4-07 | §7.4、§7.7 | Queue `hoyo-mail-events` 与业务域的事件订阅已于 2026-09-28 建好（经所有者批准）；上线时把取证用的 HTTP pull 消费者换成 P4-07 的 Worker 消费者。**一个 Queue 只能有一个消费者**：先摘掉 HTTP pull 消费者，再部署 Worker |
| 反馈 DLQ `hoyo-mail-events-dlq`（P4-07 合入后生效） | P4-07 | §7.5 | P4-07 的消费者配置了 `max_retries = 8` 后转入这个 DLQ，部署前要先建好（Queues 含在 Workers Paid 内）。DLQ 有保留期，要有人定期查看 |
| 反馈消费的普通变量 `MAIL_FEEDBACK_ACCOUNT_ID`、`MAIL_FEEDBACK_SUBSCRIPTIONS`（P4-07 合入后生效） | P4-07 | §7.5 | 前者是 Cloudflare 账户 ID；后者是 JSON 数组，每项 `{id, domain}`，业务域与认证域的事件订阅各一项。缺任一项时消费者整批 retry，最终进 DLQ，不会误 ack |
| 认证域的事件订阅 | P0-05 / P4-07 | §7.5、§7.7 | `auth.hoyo.airo.cc` 的订阅**未建**（订阅按发件域建）。上线前经所有者批准建进同一个 Queue，否则验证码邮件的硬退信与投诉收不到 |
| `send_email` 绑定限定发件地址 | P4-03 | §2.2 | `AUTH_MAILER` / `BIZ_MAILER` 各配 `allowed_sender_addresses`，只放本用途地址（由 P4-03 写进 `wrangler.jsonc`） |
| ~~Workers AI 可用性确认~~ **已解决（2026-09-22）** | P0-03 | — | 可用性与 10,000 Neurons/日免费额度已查实；此前按 entitlements 判断是看错了信号。见 `docs/evidence/p0/platform-facts.md` |
| 带 Workers AI 推理权限的 API token（或 `wrangler login`） | P0-03 | — | **仅在决定做 P0-03 计费基线时需要**。本机 wrangler 当前未登录；测思考 token 分布需要约 30–50 次真实推理调用，落在单日免费额度内 |
| 邮件服务端配置 `AUTH_MAIL_FROM`、`BIZ_MAIL_FROM`、`SITE_ORIGIN`（P4-03 合入后生效） | P4-03 | §2.2 | 普通变量，不是秘密。两个发件地址须与 `wrangler.jsonc` 里各自的 `allowed_sender_addresses` 一致；`SITE_ORIGIN` 是稳定的 HTTPS origin。缺任一项，邮件按未配置失败关闭 |
| 邮件发送开关 `mail_sending_available`（P4-03 合入后生效） | P4-03 | §2.3 | **默认关闭**：关闭时认证入口返回暂不可用，后台也不外发。P5-01 的开关管理上线前，由所有者按 P4-03 README 写明的命令手动打开 |

## 3. 待取得的实测值

| 值 | 来源卡 | 现状 |
| --- | --- | --- |
| `MODEL_MAX_INPUT` / `MODEL_MAX_BILLED_OUTPUT` | P0-03 | 未填写；依赖它们的能力默认关闭 |
| 目标 Cloudflare 环境对官方来源的可达性复测 | P3-01 | 本机 E2 已通过；Workers 侧 E3 未做（§2.4 要求） |
| `PLATFORM_MAIL_DAY_LIMIT` 的后续变动 | ADR-0003 | 当前实测 1,000；平台调整时须重跑 `params:verify` |
| 认证域的真实送达时延 | P0-05 / P4-03 | 未测。业务域取证时第二封 43 分钟才送达，而 `OTP_TTL` 为 10 分钟；开放登录前要在认证域实测 |
| DKIM 签名是否覆盖退订头 | P0-05 / P4-06 | 未核；P4-06 验收前要有 |
