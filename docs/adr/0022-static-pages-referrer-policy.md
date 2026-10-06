# ADR-0022：静态页面的 Referrer-Policy 沿用 strict-origin-when-cross-origin；Worker 响应仍为 no-referrer

- **状态**：已接受（所有者 2026-10-06 决定；无代码改动）
- **日期**：2026-10-06
- **提出者**：验收方（2026-10-06 文档整理时发现），所有者决定
- **需要所有者批准**：是，已批准。所有者 2026-10-06 原话："按代码的来"；确认为"保留 `_headers` 现状"。
- **与已有规则的关系**：修订主方案 §8.3 中 no-referrer 一项的适用范围；与 ADR-0021 同日决定。

## 背景

- 主方案 §8.3："使用 CSP、no-referrer、严格同源 CORS；认证和退订页面不加载第三方追踪代码。"
- Worker 的统一安全头（`apps/worker/src/shell/headers.ts`）为 `no-referrer`，所有经过 Worker 的响应都带它。
- #89（`c66242b`，2026-10-04）新增 `apps/web/public/_headers`，静态页面带 `Referrer-Policy: strict-origin-when-cross-origin`。静态命中由平台直接返回、不经 Worker：`wrangler.jsonc` 的 `run_worker_first` 只覆盖 `/api/*`、`/feeds/*`、`/unsubscribe/*`、`/email/one-click/*`。2026-10-06 线上 `/login/` 实测如此。

## 受影响的合同

| 文档 | 章节 | 现有规定 | 本 ADR |
| --- | --- | --- | --- |
| 主方案 | §8.3 安全、秘密与日志 | no-referrer | 静态页面（首页、详情、登录、恢复、账号、订阅、帮助、状态、管理端）为 `strict-origin-when-cross-origin`，以 `apps/web/public/_headers` 为准；Worker 生成的响应（API、个人 Feed、退订与 one-click 页面）仍为 `no-referrer`，以 `shell/headers.ts` 为准 |

## 决策

保留线上现状。两类响应各有一个定义源：静态页面看 `_headers`，Worker 响应看 `shell/headers.ts`，不在别处另写。

## 价值

不改代码、不重新部署。静态页面对跨源请求只发来源，第三方（Turnstile、Web Analytics 信标的脚本请求）看不到页面路径。

## 成本

无。

## 安全影响

- **带凭证的地址仍是 no-referrer**：个人 Feed `/feeds/u/{token}.ics`、退订 `/unsubscribe/{token}` 与 one-click `/email/one-click/{token}` 都由 Worker 响应，从这些页面发出的请求不带 Referer。
- **静态页面的地址不含凭证**：只有路由与公开参数（如 `/login?returnTo=%2Faccount`、`/events/{eventId}`），不含 token、验证码、恢复码或邮箱。跨源请求按策略只带来源（`https://hoyo.airo.cc/`）；同源请求带完整地址，只发往本站。
- **约束**：静态页面的地址今后也不得承载凭证。这本来就是 §8.3 与 AGENTS.md 硬规则 7 的要求；违反时，同源请求的 Referer 会带出完整地址。

## 预算与容量影响

无。

## 回退

把 `_headers` 里那一行改为 `no-referrer` 并部署即可，不涉及数据。

## 备选方案

改为 `no-referrer`，与 Worker 一致。所有者选择保留现状。

## 待确认

无。
