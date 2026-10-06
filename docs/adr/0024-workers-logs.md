# ADR-0024：开启 Workers Logs（含调用日志），部署配置与仓库配置同步

- **状态**：已接受（所有者 2026-10-06 在面板开启，并要求同步仓库配置）；**调用日志里含 token 一项待所有者确认**，见文末
- **日期**：2026-10-06
- **提出者**：所有者
- **需要所有者批准**：是。所有者 2026-10-06 原话："我刚修改了下面的部署策略，同时帮我修改这个的代码和相关文档"，配置为 `observability.logs.enabled = true`、`invocation_logs = true`。
- **与已有规则的关系**：新增一个计量项（ENGINEERING §4.1 规则 2 要求写 ADR）；与主方案 §8.3、AGENTS.md 硬规则 7 冲突的部分见"安全影响"和"待确认"。

## 背景

- 此前正式 Worker 没有开 observability，排障只能靠 GraphQL 分析数据。
- 2026-10-06 所有者在 Cloudflare 面板为正式 Worker 开启 Workers Logs，面板提示把下面的块写进 wrangler 配置，保持本地开发与线上一致：

```jsonc
"observability": { "logs": { "enabled": true, "invocation_logs": true } }
```

- 仓库的 `apps/worker/wrangler.jsonc` 只用于本地开发、vitest 与 `pnpm build` 的试运行；正式部署用源码外的私有配置（`$P504_DEPLOY_CONFIG`）。两份都要有这个块。

Workers Logs 的行为（Cloudflare 文档 Workers › Observability › Workers Logs、Pricing，2026-10-06 查）：

- 每次调用写一条**调用日志**，含请求、响应与相关元数据；fetch 调用的日志消息就是"`<方法> <URL>`"。`console.log` 的输出同样收进来。
- 保留 7 天（Workers Paid）。
- Workers Paid 每月含 2,000 万条日志事件，超出每百万条 0.60 美元。**2026-12-01 起改用 Cloudflare Observability 计价**：Paid 每个账单周期含 50 GB 写入与 10 GB-月存储，超出按 GB 计费。
- `invocation_logs` 设为 `false` 可以只留代码自己的日志。

## 受影响的合同

| 文档 | 章节 | 现有规定 | 本 ADR |
| --- | --- | --- | --- |
| 主方案 | §8.3 安全、秘密与日志 | "应用日志与平台 invocation 配置均排查 Cookie、OTP、恢复码、完整邮箱、Feed/退订 URL、Push endpoint 和密钥泄漏" | 平台 invocation 日志开启；它记下的完整 URL 含个人 Feed 与退订 token（见安全影响）。应用自身日志仍按白名单，不变 |
| ENGINEERING | §4.1 成本护栏 | 不新增计量项，确需新增写 ADR | 新增 Workers Logs，由本 ADR 记录；用量远低于包含量 |
| 仓库配置 | `apps/worker/wrangler.jsonc` | 无 observability | 加入上面的块；源码外的正式部署配置同样加入 |

## 决策

1. 保持正式 Worker 的 Workers Logs 开启，调用日志也开启。
2. 仓库 `apps/worker/wrangler.jsonc` 与源码外的正式部署配置都写入同一个 `observability` 块，部署不改变这一设置。
3. 代码自己的日志仍走 `shell/logger.ts` 的字段白名单，不输出 Cookie、OTP、恢复码、完整邮箱、Feed/退订 URL、Push endpoint 与密钥（ENGINEERING §5.5）。

## 价值

排障可以直接看每次调用的请求、状态码、异常和代码日志，不再只靠 GraphQL 聚合数据。

## 成本

- 仓库只改一处配置，无迁移。
- 计量：本站每月调用量（页面动态请求、每 10 分钟的 Cron、两个 DO 的 alarm、Queue 消费）远低于 2,000 万条；2026-12-01 改计价后按写入字节计，同样远低于 50 GB。不扩大邮件、模型等任何预算。

## 安全影响

- **调用日志含 token**：fetch 调用日志的消息就是完整 URL。个人 Feed `/feeds/u/{token}.ics`、退订 `/unsubscribe/{token}`、one-click `/email/one-click/{token}` 的 token 都在路径里，会进入 Workers Logs、保留 7 天。能打开该账户 Workers Logs 的人可以拿到它们：
  - Feed token 能只读该用户的个人日历，直到用户重置链接；
  - 退订 token 能关闭对应地址的业务邮件。
- **请求头**：文档说调用日志记录"请求元数据与请求头"，没有说明 Cookie 会不会打码。若不打码，`__Host-session`、`__Host-preauth` 的值也会进日志，能被拿来冒用会话。**验收方没有读取生产日志去核实**（生产日志可能含秘密）；需要所有者在面板里打开一条带 Cookie 的请求日志看一眼。
- 这些与主方案 §8.3 和 AGENTS.md 硬规则 7 冲突，见下方"待确认"。

## 预算与容量影响

不影响邮件池、模型日预算、账号存量与 D1。A.5 等式不变。

## 回退

- 只关调用日志：把 `invocation_logs` 改为 `false`（两份配置都改），重新部署；代码自己的日志仍保留。
- 全关：把 `logs.enabled` 改为 `false`，或在面板关闭。
- 已写入的日志按 7 天保留期过期，本站无法提前删除。

## 备选方案

1. **只开代码日志（`invocation_logs: false`）**：不写调用日志，URL 里的 token 和请求头都不进 Workers Logs；排障看代码自己的结构化日志与 GraphQL。
2. **调用日志开启，但用 `head_sampling_rate` 抽样**：只能降低量，不能避免 token 入日志。

## 待确认

所有者需要在两项里选一项：

- **接受**：调用日志记下的 Feed / 退订 token（以及若未打码的 Cookie）进入 Workers Logs、保留 7 天。选这项时，硬规则 7 的例外从 ADR-0021 扩大到 Workers Logs，本 ADR 状态改为全部接受；
- **改为只开代码日志**：两份配置把 `invocation_logs` 改为 `false`，硬规则 7 与 §8.3 不用开例外。
