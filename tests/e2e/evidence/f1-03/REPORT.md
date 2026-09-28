## 任务卡

F1-03 · 事件详情 · 阶段 F1。分支 `f1/F1-03-event-detail`，仓库外 worktree `/tmp/hoyo-f1-03`，基线 `origin/main` 的 `fd3dc977de1b53ef64a722f3c7d26e15a41549bc`。开工前 `git fetch origin` 成功，`git show origin/main:docs/tasks/F1-F2.md | grep -c '公告原文与证据片段'` 输出 `1`；F1-02 已合入主干。

## 改动范围

- `apps/web/src/features/schedule/fixtures.ts`：沿用 F1-02 的 synthetic 快照补充详情样例，覆盖结束与领奖截止并存、仅领奖截止、改期、取消、本站撤回、纯日期和未知精度。
- `apps/web/src/features/schedule/detail.ts`、`detail.css`：详情的受控文本渲染、固定分区、时间线、变更对照、依据折叠与响应式样式。
- `apps/web/src/features/schedule/render.ts`：首页样例节点指向同名详情；保留既有 `later → /events/sample` 返回路径。
- `apps/web/src/pages/events/[event_id].astro`：以静态 synthetic 样例生成详情路由。
- 获准跨卡：新建 `tests/e2e/event-detail.spec.ts` 与 `tests/e2e/evidence/f1-03/**`，包含本报告、桌面/移动截图、日志和可重跑变异脚本。

以上均在任务卡允许范围或其明确获准的跨卡范围。未改 `tests/e2e/schedule.spec.ts`、`_Layout.astro`、订阅页、合同、迁移或其他任务卡文档。全量 e2e 会重写 F1-02 的四张既有截图，运行后已在本分支还原，未纳入改动。

## 继承的合同

- 前端 v1.0 §5：四区顺序、实际节点、历史与当前并列、官方依据逐级展开、三项操作、旧通知语义与纯文本安全。
- 前端 §4.5：公告发布时间、发布代次时间等字段不混同；本卡详情分别列示样例公告发布时间与记录更新时间。
- 主方案 v2.1 §3.3：`start/end/phase_unlock/reward_deadline/expected_end/actual_end`、事件状态、时间依据与精度。消费 `@hoyo/contracts` 的 `nodeAction`、`nodeStatus`、`nodeTime`、`TimeValue` 与北京时间格式；日期和未知精度不转换为午夜或时刻。

实现推断：F1 原型尚无真实公告 URL 和事件详情 API，所以外链使用 `example.com` 占位，并在页面两处明确说明它**不对应真实官方公告**。静态页只承载 synthetic 样例，不作为生产事实。取消、撤回的原安排时间在线上标为历史；改期的旧时间只在变更对照中出现。

## 交付物

| 交付项 | 状态 |
| --- | --- |
| 固定顺序与当前重要安排 | 完成。当前重要安排 → 完整节点时间线 → 变更说明 → 官方依据；e2e 检查 DOM 顺序。 |
| 实际存在的时间线 | 完成。`morning` 同时含玩法结束和奖励截止；`reward` 仅含奖励截止，不补结束节点。 |
| 改期、取消、本站撤回 | 完成。改期并排展示历史原时间和当前时间；取消与本站纠错用 contracts 状态文案区分。 |
| 官方依据和文本安全 | 完成。外链位于页首和依据区；公告原文、原始时间表述、证据片段、源时区、更新时间逐级展开；公告与证据转义。 |
| 三项主要操作 | 完成。“返回日程”“查看官方公告”“设置订阅”；后者仅导航 `/subscription`，不附活动参数或修改配置。 |
| 两视口与反向验证 | 完成。桌面、移动实际截图；键盘 Tab、焦点环、Enter 展开和 320px 无横向溢出；两项变异均失败且还原后通过。 |

## 执行过的命令与结果

环境：macOS / Node `v26.8.1` / pnpm `11.11.0` / Playwright `1.63.0`，均在 `/tmp/hoyo-f1-03` 执行，2026-09-28。日志归档只去除行尾空白和多余文件尾空行，未改命令结果；以下不把手动中断或沙箱拒绝记为通过。

| 实际命令 | 实际结果 | 输出 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 首次 npm registry DNS `ENOTFOUND`，等待重试后手动中断，exit 130；授权环境原命令复跑 exit 0，258 包安装完成、lockfile 未变。 | [首次](logs/install.txt)、[复跑](logs/install-retry.txt) |
| `pnpm lint` | 首次与实现完成后复跑均 exit 0，Checked 263 files；补充 CI 证据 JSON 并格式化后执行 `CI=1 pnpm lint`，exit 0，Checked 264 files，No fixes applied。 | [首次](logs/lint.txt)、[实现完成后](logs/lint-final.txt)、[证据格式修复后](logs/lint-ci-evidence.txt) |
| `pnpm typecheck` | exit 0，contracts、web、worker 与 e2e TypeScript 通过；最终复跑同为 exit 0。 | [首次](logs/typecheck.txt)、[最终](logs/typecheck-final.txt) |
| `pnpm test` | exit 0，contracts 18 文件 / 175 测试；worker 37 文件 / 376 测试；未出现并行 flake。 | [全量单测](logs/test.txt) |
| `pnpm params:verify` | 首次 tsx IPC pipe 受沙箱限制 `EPERM`，exit 1；授权环境复跑 exit 0，25 条成立、0 条不成立。 | [首次](logs/params.txt)、[复跑](logs/params-retry.txt) |
| `pnpm migrate:check` | 首次 Wrangler 日志与 Miniflare 回环监听受沙箱限制 `EPERM`，exit 1；授权环境复跑 exit 0，15 迁移静态检查与 6 条空库重放测试通过。 | [首次](logs/migrate.txt)、[复跑](logs/migrate-retry.txt) |
| `pnpm build` | **本地未正常退出**。Web 22 页完成；Worker 打印 `--dry-run: exiting now` 后约 65 秒无后续输出，手动 Ctrl-C，exit 130。不能记作本地通过。 | [本地构建](logs/build.txt) |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/hoyo-f1-03-wrangler.log pnpm build` | 按所有者指定写法复跑；Web 22 页完成，Worker 打印 `--dry-run: exiting now`，超过约 90 秒仍未退出；手动 Ctrl-C，**实际 exit 130**，不能记作构建通过。 | [指定环境复跑](logs/build-ci-env.txt) |
| `pnpm test:e2e` | 最终 exit 0，**59 passed / 5 skipped**。5 条为既有 a11y 设备分工跳过，本卡 18 个设备用例全部执行通过。首次全量运行 57 passed / 5 skipped，后补强 1 条用例并复跑最终结果。 | [首次全量](logs/e2e.txt)、[最终全量](logs/e2e-final.txt) |
| `python3 tests/e2e/evidence/f1-03/mutate-event-detail.py` | 两次 grep 特征计数均为 1；去除证据转义 → 两视口 XSS 用例失败且 `onerror` 实际执行；虚构缺失节点 → 两视口 U02 用例失败；每次还原后同一测试 2 passed。 | [最终变异日志](logs/mutation-final.txt) |
| `git diff --check` | exit 0，无输出。 | 命令输出为空 |
| `git push -u origin f1/F1-03-event-detail` | 所有者明确确认目标仓库归属后 exit 0；仅推送本卡分支，无 force push 或 remote 修改。此前两次自动审批因目的地归属未由可信用户明确确认而拒绝，未发生上传。 | [PR #28](https://github.com/leafliber/hoyo_subscribe/pull/28) |
| `gh pr create --base main --head f1/F1-03-event-detail --title 'F1-03 · 事件详情' --body-file tests/e2e/evidence/f1-03/REPORT.md` | exit 0，创建 [PR #28](https://github.com/leafliber/hoyo_subscribe/pull/28)。 | 同左 |
| `gh run watch 36409608150 --exit-status --interval 10`、`gh run view 36409608150 --json conclusion,headSha,jobs,url` | exit 0；PR head `3b51140` 的 `verify` job success，冻结安装、lint、typecheck、test、params:verify、migrate:check、**build**、test:e2e 均 success。 | [CI 原始结果](logs/ci-verify.json)、[Actions run](https://github.com/leafliber/hoyo_subscribe/actions/runs/36409608150) |
| `gh run view 36410126069 --log-failed` | 提交 `3531ead` 的 CI 在 lint 步骤失败：新归档的 `ci-verify.json` 是单行原始 JSON，Biome 要求格式化。读取失败日志后执行 `node_modules/.bin/biome check --write tests/e2e/evidence/f1-03/logs/ci-verify.json`，exit 0，Fixed 1 file；随后 `CI=1 pnpm lint` exit 0。此前 `pnpm exec biome check --write` 因 pnpm 非 TTY 模块清理报错，未完成格式化。 | [失败的 Actions run](https://github.com/leafliber/hoyo_subscribe/actions/runs/36410126069) |
| `gh run watch 36410534124 --exit-status --interval 10` | exit 0；提交 `88ae554` 的 `verify` job success，冻结安装、lint、typecheck、test、params:verify、migrate:check、**build**、test:e2e 均 success。 | [修复后的 Actions run](https://github.com/leafliber/hoyo_subscribe/actions/runs/36410534124) |

定向 e2e 的真实失败也留档：沙箱内监听 4173 首次 `EPERM`；获准重跑后 14 passed / 2 failed，原因是测试把折叠证据里的“公告发布时间”误纳入未知精度节点时刻断言。将断言限到 `.milestone-time` 后 16 passed，最终全量亦通过。[沙箱失败](logs/e2e-target-first.txt)、[断言失败](logs/e2e-target-retry.txt)、[修正后](logs/e2e-target-final.txt)。

## 验收测试

| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| U02 | `tests/e2e/event-detail.spec.ts`: 玩法结束与奖励领取截止在实际节点时间线中分别出现 | 桌面、移动通过；核对四区顺序。 |
| U02 | 同文件: 从日程条目进入对应事件详情 | 桌面、移动通过。 |
| U02 | 同文件: 只有奖励截止时不补玩法结束 | 桌面、移动通过；补虚构节点变异使两视口失败。 |
| U02 | 同文件: 纯日期与未知精度只展示已知信息，不猜午夜或时刻 | 桌面、移动通过。 |
| U04 | 同文件: 改期的历史原时间与当前时间并列，旧时间不作当前安排 | 桌面、移动通过。 |
| U04 | 同文件: 官方取消和本站撤回分开呈现，不宣称撤回旧副本 | 桌面、移动通过。 |
| U04 | 同文件: 公告与证据的 img onerror 只显示文字，不执行 | 桌面、移动通过；去掉证据转义后 `onerror` 实际执行并使两视口失败。 |
| U04 | 同文件: 官方依据逐级展开，三项主要操作可用且设置订阅只跳整份草稿 | 桌面、移动通过。 |
| U02/U04 | 同文件: 桌面与手机截图、窄屏和键盘展开留证 | 桌面、移动通过；320px 无横向溢出。 |

本卡 U02、U04 均覆盖；无未覆盖验收 ID。U28 的全站既有 e2e 在本次全量运行中亦通过既定设备分工。

## 证据

E2 采集时间：2026-09-28 13:17（Asia/Shanghai）。截图来自 Playwright Chromium 的实际静态页渲染，数据全部为 `synthetic`，无真实账号、官方来源、邮件或客户端 E3 证据。

- [桌面详情](desktop-detail.png)、[桌面改期](desktop-rescheduled.png)、[桌面依据展开](desktop-evidence-expanded.png)：Desktop Chrome，1280×720 CSS px，fullPage。
- [移动详情](mobile-detail.png)、[移动改期](mobile-rescheduled.png)、[移动依据展开](mobile-evidence-expanded.png)：Pixel 7 浏览器仿真，详情截图收窄至 320×800 CSS px，fullPage。
- [最终全量 e2e](logs/e2e-final.txt)、[最终变异日志](logs/mutation-final.txt) 与各标准命令日志均位于 `logs/`。
- [PR #28 的 CI 原始步骤结果](logs/ci-verify.json)：2026-09-28 18:27（Asia/Shanghai）提交 `3b51140` 的 `verify` 成功，`build` 步骤成功。后续提交 `3531ead` 因本证据 JSON 未格式化而 lint 失败；修复提交 `88ae554` 的 [CI 全绿](https://github.com/leafliber/hoyo_subscribe/actions/runs/36410534124)，包含独立的 `build` 成功。CI 是 Linux 隔离环境，未将其写作本机 `pnpm build` 成功。

## 不在本次范围

真实事件详情接口、真实官方 URL 与来源接入、F1-04 全量错误映射、F2-01 订阅页/草稿实现、真实邮件与 Push、私人 ICS、生产部署均未实现。设置订阅入口不添加活动或游戏，不写云配置。本卡未触碰 F1-04 并行修改的 `tests/e2e/schedule.spec.ts` 与 `_Layout.astro`。

## 已知问题与回退点

- 本机 `pnpm build` 的 Wrangler dry-run 退出等待与既有 F1-02 报告一致；所有者指定的 `CI=1`、关闭遥测、定向日志路径写法仍复现。两次本地尝试都由人工中断，exit 130。PR #28 在提交 `88ae554` 的 Linux CI `build` 步骤成功，本机退出等待仍作为环境差异保留。
- 详情页日期在静态构建时生成；首页交互样例按浏览器时钟生成。因此原型在跨日或测试冻结时钟下可有样例日期差异。真实数据与版本绑定需后续接口卡处理。
- 首页 F1-02 样例场景说明仍写“详情沿用占位页”；`index.astro` 不在本卡允许范围，留给验收方分配后续文案修正。
- 样例公告外链是 `example.com` 占位，页面明确标记，不能作为官方依据或联调证据。没有访问真实外部发送链。
- 回退到基线提交 `fd3dc977de1b53ef64a722f3c7d26e15a41549bc` 可恢复上一可用状态；本卡无迁移和生产写入。
