## 任务卡

F6-03 · 中文兑换码修复与后台信息分区 · 阶段 F6

对应 [任务卡](../../tasks/F6-03.md) 与 [ADR-0035](../../adr/0035-chinese-redeem-codes-and-admin-pages.md)。所有者 2026-10-31 已明确授权上述三项工作，按一张卡交付。

## 改动范围

- `apps/web/src/features/admin/AdminLayout.astro`
- `apps/web/src/features/admin/admin.css`
- `apps/web/src/features/admin/controls.ts`
- `apps/web/src/features/admin/settings-page.ts`
- `apps/web/src/features/admin/versions-page.ts`
- `apps/web/src/pages/admin/redeem-codes.astro`
- `apps/web/src/pages/admin/settings.astro`
- `apps/worker/src/executors/pipeline/live-pipeline.test.ts`
- `apps/worker/src/sources/adapters/miyolive-article.ts`
- `apps/worker/src/sources/adapters/miyolive.test.ts`
- `apps/worker/src/sources/adapters/miyolive.ts`
- `docs/adr/0035-chinese-redeem-codes-and-admin-pages.md`
- `docs/evidence/f6-03/REPORT.md`
- `docs/evidence/f6-03/desktop-chromium-admin-redeem-codes.png`
- `docs/evidence/f6-03/desktop-chromium-admin-redeem-failed.png`
- `docs/evidence/f6-03/desktop-chromium-admin-versions-completed.png`
- `docs/evidence/f6-03/desktop-chromium-admin-versions-pending.png`
- `docs/evidence/f6-03/mobile-chromium-admin-redeem-codes.png`
- `docs/evidence/f6-03/mobile-chromium-admin-redeem-failed.png`
- `docs/evidence/f6-03/mobile-chromium-admin-versions-completed.png`
- `docs/evidence/f6-03/mobile-chromium-admin-versions-pending.png`
- `docs/evidence/f6-03/verification.json`
- `docs/tasks/F6-03.md`
- `fixtures/sources/miyolive/index-hsr-47-ended.json`
- `fixtures/sources/miyolive/refresh-code-hsr-47-live.json`
- `packages/contracts/src/public-api.ts`
- `packages/contracts/src/redeem-codes.test.ts`
- `packages/contracts/src/redeem-codes.ts`
- `packages/contracts/src/version-time.test.ts`
- `packages/contracts/src/version-time.ts`
- `tests/e2e/admin-review.spec.ts`

全部在本卡范围内。Worker 与 contracts 是修复采集/日历链路的必要跨层改动；未改既有任务卡、BUILD_PLAN、ACCEPTANCE 或 CONTRACTS_BASELINE。主工作区保持 main，原有未跟踪 `promo/` 未触碰；实现位于独立工作树及 `f6/F6-03-redeem-admin` 分支。

## 继承的合同

- 主方案 §3.1、§3.3、§3.4：官方来源、带证据的时间与规则发布；§8.2、§8.3：既有管理 API、管理员权限和 CSRF。
- 前端 §1.3、§11：管理端独立权限域、状态明确且可操作。
- ADR-0011：版本时间只采用原文摘录或紧接着的下一版本已确认更新开始；确认值、CAS、引用锁与理由不变。
- ADR-0030/0033/0034：直播发现、来源开关、截止时间登记与轮询节奏不变；ADR-0035 记录本次修复及页面调整。
- 实现解释：版本“已完成选择”指两个字段均有已保存的确认值，不是有候选建议；部分选择的版本仍列入待办。兑换码为空只说明未读取到，不能推断官方尚未发放。
- 既有兑换码 1–64 字符格式上限归并到 contracts 的单一 schema；没有新增阈值、配置项、日池或 A.5 等式。

## 交付物

1. **完成**：contracts `RedeemCodeSchema` 支持汉字与原有英文/数字/下划线/连字符，采集、正文读回和公开响应共用；仍拒绝 HTML、控制字符和正文分隔符。真实中文样本能入库、生成日历事件、公开读取，保留官方原码与时间。
2. **完成**：新增 `/admin/redeem-codes/`，直播来源开关、维护解除、手动登记、码列表和截止时间迁入；运行开关页给出入口。读取失败明确告警，展示上次成功时间；空列表写“尚未读到兑换码”，没有截止时间写“尚未登记或识别”。写入仍复用现有确认、理由和 CAS。
3. **完成**：版本表按游戏先列待选择节点；已选节点显示时间与出处，修改入口收起；两个字段都已选的版本归入收起的“已完成选择”。采用后移入完成组、清除后回到待选组；下一版本引用锁继续生效。
4. **完成**：真实样本回归、全仓检查、桌面/手机浏览器交互及截图。生产部署未执行，见下文。

## 执行过的命令与结果

工作目录为本卡独立工作树。Node `v26.10.0`，pnpm `11.11.0`；未升级依赖。

| 实际命令 | 实际结果 |
| --- | --- |
| `git fetch origin`；`git switch -c f6/F6-03-redeem-admin` | 退出 0；从最新 origin/main `d1d2c99` 创建独立工作树分支 |
| `pnpm install --frozen-lockfile --offline` | 首次受沙箱写权限限制 EPERM，退出 255；获得工作树写权限后原命令退出 0，从缓存安装，无锁文件变更 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true WRANGLER_LOG_PATH=/private/tmp/f6-03-wrangler.log pnpm --filter @hoyo/worker test src/sources/adapters/miyolive.test.ts src/executors/pipeline/live-pipeline.test.ts -t A-F6-REDEEM` | **修复前退出 1**：新增两例均失败，29 例按名称过滤跳过；真实中文返回 `code_value`，D1 码列表为空 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true WRANGLER_LOG_PATH=/private/tmp/f6-03-wrangler.log pnpm --filter @hoyo/worker test src/sources/adapters/miyolive.test.ts src/executors/pipeline/live-pipeline.test.ts src/extraction/redeem-rules.test.ts` | 修复后退出 0，3 文件 / 40 项通过 |
| `pnpm --filter @hoyo/contracts test src/redeem-codes.test.ts src/version-time.test.ts` | 退出 0，2 文件 / 65 项通过 |
| `pnpm typecheck` | 退出 0，contracts、Worker、Web 与 E2E 类型检查通过 |
| `pnpm exec biome check --write`（参数为本卡 16 个变更的 TS/CSS/JSON 文件，见改动范围） | 退出 0，仅格式化本卡文件；随后 `pnpm lint` 两次均退出 0，649 文件无错误；加入证据 JSON 后再跑一次，650 文件无错误 |
| `pnpm exec biome check --write docs/evidence/f6-03/verification.json` | 退出 0，新增证据 JSON 已格式化 |
| `pnpm params:verify` | 退出 0，40/40 等式成立 |
| `pnpm migrate:check` | 退出 0，31 个迁移静态检查及本地顺序重放，15 项测试通过 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true WRANGLER_LOG_PATH=/private/tmp/f6-03-wrangler.log pnpm test` | 退出 0：contracts 38 文件 / 403 项、Worker 93 文件 / 1346 项通过。既有 migration-0030 反例测试输出一次 FOREIGN KEY 回滚诊断，其预期拒绝断言通过 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true WRANGLER_LOG_PATH=/private/tmp/f6-03-wrangler.log pnpm build` | 退出 0，12 个静态页面，包含新兑换码页；Worker dry-run 正常退出，没有部署 |
| `CI=1 E2E_PORT=4185 pnpm exec playwright test --config tests/e2e/playwright.config.ts admin-review.spec.ts --workers=4` | 退出 0，桌面与手机共 76 项通过，无失败或重试 |
| `CI=1 E2E_PORT=4185 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm test:e2e --workers=4` | 退出 0，重新构建最新页面，全站 1071 通过 / 5 跳过 / 0 失败，2.2 分钟，无 flaky |
| `git diff --check` | 退出 0 |

五项跳过是套件原有的按项目条件跳过：桌面项目不运行 2 项手机布局检查，手机项目不重复运行 3 项不依赖视口的颜色/token 工具检查；对应项在另一项目运行。没有把跳过写作通过。

未执行：正式部署、生产数据库写入、真实发信/Push/模型调用、生产管理员写操作。读取和构建检查不代替这些外部证据。

## 验收测试

| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| A-F6-REDEEM / A-P3-FETCH | `apps/worker/src/sources/adapters/miyolive.test.ts`：2026-10-30 官方三个中文码完整读入，并可从日历正文读回 | 修复前失败，修复后通过 |
| A-F6-REDEEM | `apps/worker/src/executors/pipeline/live-pipeline.test.ts`：官方真实响应离线回放：三个中文码入库、生成日历事件并出现在公开读取中 | 修复前失败，修复后通过，真实本地 D1；没有访问官方或发送链 |
| A-F6-REDEEM | `packages/contracts/src/redeem-codes.test.ts`：官方兑换码共用格式 | 中文、英文、混合、长度边界、控制字符/HTML/分隔符 18 例通过 |
| A-F6-REDEEM / A-P3-VERSION | `packages/contracts/src/version-time.test.ts`：版本时间选择状态 | 记录缺失、未选、部分已选、全部已选及 0 时刻通过 |
| A-F6-REDEEM | `tests/e2e/admin-review.spec.ts`：兑换码独立入口、来源错误与空列表如实显示，中文码按文本呈现 | 桌面/手机 2/2 通过，含 noindex、设置页不再显示直播管理、空与失败状态、刷新、无横向溢出 |
| A-F6-REDEEM / A-P3-VERSION | 同文件：版本节点按已保存时间区分，采用后归入完成、清除后回到待选；写入保留理由与 CAS | 桌面/手机 2/2 通过 |
| A-F6-REVIEW / A-P3-VERSION | 同文件既有登录、秘密清除、401/409、引用锁、下一版本采用、来源开关与截止时间确认等 | 管理端总计 76/76；迁移到新页面的 ADR-0033/0034 场景继续通过 |

本卡无未覆盖的验收 ID。没有新增验收导航条目，新增 ID 定义在本任务卡，交验收方纳入其维护的导航。

## 证据

- [`verification.json`](verification.json)：上述命令的结果摘要及执行边界。
- `fixtures/sources/miyolive/index-hsr-47-ended.json`、`refresh-code-hsr-47-live.json`：2026-10-30 北京时间 23:45–23:46 的真实官方公开响应；元数据内保留精确 UTC 捕获时间、端点与活动 ID。取证使用诚实 UA、无 Cookie/凭据、无重试；本次实施只离线复用。
- 桌面/手机截图各四张，均为 **E2 合成管理 API**，不冒充生产管理端截图：
  - [桌面兑换码](desktop-chromium-admin-redeem-codes.png)、[手机兑换码](mobile-chromium-admin-redeem-codes.png)
  - [桌面读取失败](desktop-chromium-admin-redeem-failed.png)、[手机读取失败](mobile-chromium-admin-redeem-failed.png)
  - [桌面待选节点](desktop-chromium-admin-versions-pending.png)、[手机待选节点](mobile-chromium-admin-versions-pending.png)
  - [桌面完成选择](desktop-chromium-admin-versions-completed.png)、[手机完成选择](mobile-chromium-admin-versions-completed.png)
- 完整本地输出保留 `/private/tmp/f6-03-test.log`、`/private/tmp/f6-03-admin-e2e.log`、`/private/tmp/f6-03-e2e.log`、`/private/tmp/f6-03-lint.log`；可按上表重新执行，不依赖这些临时文件完成复核。
- 正式部署后的采集恢复与管理员页面：**需所有者执行**；本次没有生产写入。

## 不在本次范围

未实施生产部署或数据写入、新来源/供应商、真实邮件/Push/模型调用、手填版本时间、自动确认、批量审核、F6-02 的投递终态解除或其他任务卡导航维护。未修改日历 UID/SEQUENCE、缩水守卫、提醒资格、邮件预算、会话名额、恢复码或订阅配置。

## 已知问题与回退点

- 正式站点需合入并部署后才会使用修复；本次没有数据库迁移或新配置。部署后按原轮询和来源开关重新读取，不需要手工写入兑换码。
- 兑换码有效期仍须官方明确说明或管理员照官方说明登记，不按惯例猜测。中文格式放行不等于验证某个码在游戏中兑换成功。
- 新共享校验保留原字符上限，只增加汉字；若官方未来使用其他文字/符号，仍需按实际样本扩展。
- 回退点 `d1d2c99`。回退会恢复旧管理布局及中文码解析故障；已经保存/发布的中文兑换码事件不删除、不重新编号，已发通知无法撤回。
