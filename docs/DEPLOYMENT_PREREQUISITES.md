# 部署前置清单

> 各任务卡交付时产生的「需所有者执行」项集中于此，避免散落在 PR 描述里丢失。
> **每项都是上线前必须完成的**；未完成时对应能力按 fail-closed 处理（不降级、不假成功）。
> 新增项由交付卡的验收方登记，注明来源卡与依据章节。
>
> **所有者 2026-09-30 同意在上线前执行本清单的平台操作。**同意不等于已执行：下面的项目仍按"未完成"对待，执行一项、登记一项（写明日期）。

## 1. Secrets（经 Wrangler secret 注入，不进仓库）

| Secret | 来源卡 | 用途 | 未注入时的行为 |
| --- | --- | --- | --- |
| `CRYPTO_MASTER_SECRET` | P1-06 / P1-08 | 除 OTP MAC 外八个用途的 HKDF 派生根 | 写路由 fail-closed 503 |
| `CRYPTO_OTP_PEPPER` | P1-06 / P1-08 | OTP MAC 独立 pepper（§4.3 双根） | 同上 |
| `CRYPTO_UNSUBSCRIBE_KEY_ID` | P1-06 / P1-08 | 退订 token 的 key_id | 同上 |
| `TURNSTILE_SECRET_KEY` | P2-01 | Turnstile 服务端 siteverify（[R09]） | 第 4 步失败关闭 |
| `ADMIN_BOOTSTRAP_SECRET`（P3-10 合入后生效） | P3-10 | 管理员引导交换：只经 HTTPS POST 请求体提交，换取短期管理员会话。用 CSPRNG 生成 `SECRET_BITS` 位，存小写 hex；不进 URL、仓库、日志或前端环境变量 | 引导入口统一拒绝，管理员无法登录 |

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
| ~~带 Workers AI 推理权限的 API token（或 `wrangler login`）~~ **首版不需要（2026-09-30）** | P0-03 | — | 所有者决定首版不带模型抽取，P0-03 不做。以后要加模型时再提供 |
| 邮件服务端配置 `AUTH_MAIL_FROM`、`BIZ_MAIL_FROM`、`SITE_ORIGIN`（P4-03 合入后生效） | P4-03 | §2.2 | 普通变量，不是秘密。两个发件地址须与 `wrangler.jsonc` 里各自的 `allowed_sender_addresses` 一致；`SITE_ORIGIN` 是稳定的 HTTPS origin。缺任一项，邮件按未配置失败关闭 |
| 邮件发送开关 `mail_sending_available`（P4-03 合入后生效） | P4-03 | §2.3 | **默认关闭**：关闭时认证入口返回暂不可用，后台也不外发。P5-01 的开关管理上线前，由所有者按 P4-03 README 写明的命令手动打开 |
| 管理员 Access 入口 `ADMIN_ACCESS_ISSUER`、`ADMIN_ACCESS_AUD`（可选，P3-10 合入后生效） | P3-10 | §8.3 | 前者形如 `https://<team>.cloudflareaccess.com`，后者是管理员应用的 Audience。两项都配了才开启 Access 换会话入口，缺一即关闭。Access 应用**只保护 `/api/v2/admin/*`**，不得给 `/feeds/u/*` 加交互登录墙 |
| 管理员入口的边缘限速（P3-10 合入后生效） | P3-10 | §8.3、[R16] | 代码里的近似限速只挡单个 isolate 内的突发。`/api/v2/admin/session/*` 要在边缘另配按 IP 的限速 |
| 登录页 Turnstile 站点密钥 `PUBLIC_TURNSTILE_SITE_KEY`（F3-01 合入后生效） | F3-01 | §4.2 | 构建期的公开变量，与 Worker 的 `TURNSTILE_SECRET_KEY` 配对，站点域名要在 Turnstile 的允许列表里。没配时登录页失败关闭，无法申请验证码 |
| 正式 D1 应用迁移 | P1-04 起各卡；本批 P3-10 | §8.1；`ENGINEERING.md` §6 | 上线前、以及之后每次带迁移的发布前，按编号顺序把 `migrations/` 应用到正式 D1。当前最新是 0024（P3-10，管理员审计到期清理的部分索引，只加索引）。代码先于迁移上线时，依赖新表或新索引的路径会报错 |
| 站点静态资源随 Worker 部署（P5-05 合入后生效） | P5-05 | §2.1 | 网页构建产物与 Worker 同一个项目部署（`wrangler.jsonc` 的 `assets`）。站点域名的路由要让静态页面、`/api/*`、`/feeds/*`、`/unsubscribe/*` 都进这个 Worker 项目；详情直达靠构建产物里的 `_redirects`，不要另加平台侧的重写规则 |

## 3. 待取得的实测值

| 值 | 来源卡 | 现状 |
| --- | --- | --- |
| `MODEL_MAX_INPUT` / `MODEL_MAX_BILLED_OUTPUT` | P0-03 | 未填写；依赖它们的能力默认关闭。首版不带模型抽取（所有者 2026-09-30），首版不需要取得 |
| 目标 Cloudflare 环境对官方来源的可达性复测 | P3-01 | 本机 E2 已通过；Workers 侧 E3 未做（§2.4 要求） |
| `PLATFORM_MAIL_DAY_LIMIT` 的后续变动 | ADR-0003 | 当前实测 1,000；平台调整时须重跑 `params:verify` |
| 认证域的真实送达时延 | P0-05 / P4-03 | 未测。业务域取证时第二封 43 分钟才送达，而 `OTP_TTL` 为 10 分钟；开放登录前要在认证域实测 |
| DKIM 签名是否覆盖退订头 | P0-05 / P4-06 | 未核；P4-06 验收前要有 |
