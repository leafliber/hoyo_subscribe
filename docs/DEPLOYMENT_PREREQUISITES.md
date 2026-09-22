# 部署前置清单

> 各任务卡交付时产生的「需所有者执行」项集中于此，避免散落在 PR 描述里丢失。
> **每项都是上线前必须完成的**；未完成时对应能力按 fail-closed 处理（不降级、不假成功）。
> 新增项由交付卡的验收方登记，注明来源卡与依据章节。

## 1. Secrets（经 Wrangler secret 注入，不进仓库）

| Secret | 来源卡 | 用途 | 未注入时的行为 |
| --- | --- | --- | --- |
| `CRYPTO_MASTER_SECRET` | P1-06 / P1-08 | 七用途 HKDF 派生根 | 写路由 fail-closed 503 |
| `CRYPTO_OTP_PEPPER` | P1-06 / P1-08 | OTP MAC 独立 pepper（§4.3 双根） | 同上 |
| `CRYPTO_UNSUBSCRIBE_KEY_ID` | P1-06 / P1-08 | 退订 token 的 key_id | 同上 |
| `TURNSTILE_SECRET_KEY` | P2-01 | Turnstile 服务端 siteverify（[R09]） | 第 4 步失败关闭 |

生成方式见 `docs/ENGINEERING.md` §4；**八个用途各自独立，不得复用同一份材料**。

## 2. 平台侧配置

| 项 | 来源卡 | 依据 | 说明 |
| --- | --- | --- | --- |
| **按 IP 的边缘限速规则** | P2-01 | §4.2 第 3 步、§8.3、[R16] | ⚠ 应用侧只做**同邮箱**近似限速——附录 A 无 IP 维度参数，按 [R16] 该维度属边缘。**边缘规则未配时，换邮箱即可绕过第 3 步**；这不是应用缺陷，但上线前必须配 |
| 发件子域与 DNS（认证域 / 业务域分开） | P0-05 | §2.2 | 关闭认证域 Email preview；两用途均关闭「静默丢弃受抑制收件人」 |
| Workers AI 可用性确认 | P0-03 | — | 账户 entitlements 中未见任何 `workers_ai.*`，可用性未证实 |

## 3. 待取得的实测值

| 值 | 来源卡 | 现状 |
| --- | --- | --- |
| `MODEL_MAX_INPUT` / `MODEL_MAX_BILLED_OUTPUT` | P0-03 | 未填写；依赖它们的能力默认关闭 |
| 目标 Cloudflare 环境对官方来源的可达性复测 | P3-01 | 本机 E2 已通过；Workers 侧 E3 未做（§2.4 要求） |
| `PLATFORM_MAIL_DAY_LIMIT` 的后续变动 | ADR-0003 | 当前实测 1,000；平台调整时须重跑 `params:verify` |
