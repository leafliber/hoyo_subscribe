# F4-01 · 邮件提醒两层呈现与同意流程

本目录提供 `mountEmailChannel(root, host)`，由宿主显式挂载并调用返回值的 `refresh()`。
本卡只改 `apps/web/src/features/channels/email/**`；**尚未挂进正式订阅页**，不能据此声称正式页面已完成 F4-01。

## 组件边界

- GET/PUT `/api/v2/me/email-channel`，携带同源 Cookie，读取 `no-store`，写入读取当前 CSRF。
- 开启可用性调用 contracts 的 `emailChannelEnableAvailability`；错误 `blocked_reason` 使用
  `EmailChannelBlockReason` 穷尽文案表。缺失或不合法的响应保持未知，不能用默认值制造正常状态。
- 开启前重新 GET，分别勾选两层；请求绑定该次 GET 的通道、邮箱、订阅和同意说明版本。
  409 / validation 清掉本次同意并重读，请用户重新开启确认流程；其他拒绝也重读。
- `partial` 分别展示席位与常规层的实际结果。传输失败只核对当前状态，不重发写请求。
- 同意记录、租期与余量、可投递性、全站发送状态分别呈现。P4-06 未接通时服务端返回发送暂停，组件照实显示。
  后台续租 `background_processing = unknown` 也保持未知；不声称 P5-02 的后台处理已运行。
- 日限频与租期取 GET 的 `disclosure`，名额上限取 contracts 注册表。文案按 UTC 日解释，不做本地午夜倒计时。
- 草稿适配调用现有 F2-03 `SubscriptionSaveMachine`，宿主的 `save` 应传 F2-04 `drafts.save`。
  保存后仍 dirty / conflict / uncertain 时不进入邮件确认；使用已保存设置保留草稿，摘要只读邮件 GET 中的订阅。
- 组件只保留内存状态；身份事件、跨页失效广播或 pagehide 会 dispose，并拒绝旧异步响应。
  宿主确认新身份后须重新挂载，不能复用旧实例。
- 不新增数据迁移、后台租期计算、真实邮件发送、逐封收件箱、退订 token 或候补体验。

## 待授权的最小接线位置

以下行号以基线 `9ee5e18281f23d8ebc63c4c14fd02df3b9de1392` 为准，**本次均未修改**。

1. `apps/web/src/features/subscription/page.ts`：
   - 导入区：导入 `mountEmailChannel` 与宿主类型。
   - 约 165 行（`let drafts`）附近：保存当前 `Phase` 和邮件实例引用。
   - 171–172 行（保存状态机 `render`）：记录 phase，在身份已确认、读取完成后挂载 / 更新宿主；不在 loading/身份未知时展示旧私人状态。
   - 244–260 行（身份 reset）：dispose 旧实例；新身份读取完成后重新挂载。
   - 318–319 行（`drafts.start`）：读取完成后在现有 `#mail-channel` 挂载，并传递
     `machine: () => machine`、`readDraft: draftFromForm`、`phase`、`save: () => drafts.save()`、`current: () => drafts.current()`。
     生命周期细节以首次读取与跨标签身份切换测试为准，不能只在页面初始化时挂一次。
2. `apps/web/src/pages/subscription.astro`：142 行当前写死“邮件与浏览器通知尚未开启”，接入后需改为
   “这里的选项只定义消息内容，不授予发送权限；接收状态请查看下方接收方式”，避免与实际开启状态矛盾。
   180–183 行占位区可保留作未挂载时的静态提示；组件已有同名标题 ID，满足原 `aria-labelledby`。
3. `tests/e2e/email.spec.ts`：新增正式订阅页的挂载、草稿处理、账号切换用例，纳入现有完整 E2E。
   当前隔离测试使用 Vite 源码入口，**不由根 `pnpm test:e2e` 自动发现**，不能直接导入到静态站点测试配置里运行。

## 验证

邮件专项：

```sh
pnpm exec playwright test --config apps/web/src/features/channels/email/playwright.config.mjs
```

使用真实 Chromium（桌面与手机 viewport）、实际邮件模块、实际 F2-03 保存状态机与 API 请求序列，
HTTP 响应由 Playwright 合成替身提供。没有连接真实账号、Worker 发送链或真实邮件。
测试专用页面由路由拦截注入，未在正式站点新增路由。`--ignore-lock` 使 Astro 留在前台供 Playwright 管理。
运行输出写 `/tmp/f4-01-email-results`，不会覆盖已提交截图。

正常命令仍需运行：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、
`pnpm params:verify`、`pnpm migrate:check`、`pnpm test`、`pnpm build`、`pnpm test:e2e`。
日志与截图见 `evidence/`，每次执行结果以 PR 交付报告为准。
