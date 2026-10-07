# apps/web

HoYo日历的网页端：Astro 静态输出 + 原生 TypeScript 模块，与 Worker 同项目部署（`apps/worker/wrangler.jsonc` 的 `assets`）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/pages/` | 路由与静态骨架；`_Layout.astro` 是统一外壳（页头、读屏播报区、页脚） |
| `src/styles/tokens.css` | 设计 token：颜色、字号、间距、圆角、阴影的唯一定义源 |
| `src/styles/base.css` | 基础排版与组件库：按钮、表单、胶囊/分段、徽标、提示条、卡片、折叠、弹窗、键值列表、空状态 |
| `src/styles/contrast-checks.ts` | 页面实际使用的「前景/背景」token 组合，e2e 逐项校验对比度 |
| `src/lib/` | `dom.ts`（安全的 DOM 构建，不用 innerHTML 拼外部数据）、`icons.ts`、`format.ts`（北京时间格式化）、`toast.ts`、API 客户端与本机存储 |
| `src/features/` | 按功能组织：`schedule`（日程时间轴、详情、公告原文弹窗）、`subscription`（编辑、保存状态机、预览、两步引导——第 2 步为接收方式三选一，ADR-0029；「订阅内容」「接收方式」两个标签页，ADR-0026）、`channels`（日历、邮件、浏览器通知）、`auth`（登录、恢复、账号设置；普通会话的恢复码在账号设置里创建与更换，ADR-0026）、`admin`（审核、版本时间表、运行开关三页，外壳为 `AdminLayout.astro`）、`info`（帮助与状态页样式） |
| `src/components/` | 基础组件：`FormField`、`Icon`、`GameIcon`（官方游戏图标，ADR-0015）、`dialog`、`collapse`、`status`、`header-auth` |
| `public/_headers` | 静态页面的安全响应头与 `/_astro/*` 长缓存（只作用于静态资源，Worker 响应自带安全头）；Referrer-Policy 为 strict-origin-when-cross-origin（ADR-0022），Worker 响应为 no-referrer |
| `public/_redirects` | 详情直达改写的唯一规则（P5-05）；不另加平台侧改写 |
| `public/game-icons/` | 随站点发布的官方游戏应用图标（ADR-0015），页面不向第三方请求图标 |

## 约定

- 颜色字面量只能写在 `tokens.css`（含阴影、遮罩等复合值）；新增前景/背景组合要登记到 `contrast-checks.ts`。
- 每个公共页面在 frontmatter 第一行 `import "../styles/base.css"`，保证基础样式先于功能样式输出；管理端三页由 `features/admin/AdminLayout.astro`（独立外壳：noindex、三个页签）引入。
- 与后端通信的协议细节（CSRF 头、幂等键、revision/generation 等 CAS 字段、结果不确定时的核对、显式操作后才续期）集中在各功能的 api/控制器模块里，改界面时不要绕开它们。
- 业务规则来自 `@hoyo/contracts`，页面只做呈现。

## 本地验证

```sh
pnpm --filter @hoyo/web run build                 # 输出到 apps/web/dist
pnpm test:e2e                                    # 构建后在 127.0.0.1:4173 跑 Playwright
```

并行验证时可隔离端口与构建目录：`WEB_OUT_DIR=./dist-local` 构建到独立目录，
`E2E_DIST=apps/web/dist-local E2E_PORT=4201 pnpm exec playwright test --config tests/e2e/playwright.config.ts <spec>` 使用它（结果写入 `tests/e2e/test-results-4201/`）。
