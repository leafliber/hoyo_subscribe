## 任务卡

F2-01 · 订阅页骨架与四类设置的语义分离 · 阶段 F2

## 改动范围

- `apps/web/src/pages/subscription.astro`、`apps/web/src/features/subscription/page.ts`、`apps/web/src/features/subscription/subscription.css`：页面与仅存于本页内存的交互。
- `packages/contracts/src/subscription-copy.ts`、`subscription-copy.test.ts`、`index.ts`：从现有规则注册表投影文案，补齐显示名称并追加出口。
- `tests/e2e/subscription.spec.ts`、`tests/e2e/evidence/f2-01/**`：U09、U09a、U10 的浏览器测试、反向验证、日志与 E2 截图。

以上均为任务卡及其「开工前还要知道的」列明的授权路径。全量 e2e 曾重新生成 F1-02 截图，已还原，未纳入改动。

## 继承的合同

- 前端 v1.0 §3.2、§6.1—§6.4：四类设置分别控制关注范围、提前提醒、日历基础显示与变更消息；`alarms_enabled` 仅属待保存的日历配置。
- 主方案 v2.1 §5.1、§5.3：规则可为空；变更消息范围取 `scope ∩ (calendar.event_types ∪ 规则所涉事件类型)`；接收方式不写入订阅配置。
- `packages/contracts/src/params/registry.ts` 的 `DEFAULT_*`、`CHANGE_DEFAULTS` 与 `CALENDAR_ALARMS_DEFAULT` 仅作界面预选。

实现推断：本卡没有云端读写，页面一律显示「尚无已保存订阅」；「保存订阅」仅校验本机必填选择，并明确回报「未写入云端」。本机状态不持久化，避免提前实现 F2-03/F2-04。按本次交付要求展示三个接收方式区域，其中 Push 仅显示「尚未开放」且无启用控件。

## 交付物

- 完成：按①关注的游戏、②提前提醒、③日历显示、④变更消息、⑤实际日历预览的顺序排版；保存栏下方是日历、邮件、浏览器通知三个独立区域。
- 完成：规则文案从 `rules.ts` 的现有 `user_copy_zh` 单源投影至新文案模块；推荐分组只按 `DEFAULT_RULE_IDS`，其余放「更多提醒」。页面没有规则 ID 常量表。
- 完成：日历显示折叠摘要列出事件、节点和日历提醒选择；变更消息折叠摘要列出已选开关。变更范围的动态说明调用 `changeNotificationScope`。
- 完成：关闭日历提醒不清空规则；规则全空仍可操作变更开关；未启用 Feed 时仅显示「已选择日历提醒」。没有每游戏独立配置、通道专属提前量或自由分钟输入。
- 完成：唯一主按钮为「保存订阅」。保存栏在正常文档流内；移动端错误可聚焦，末项可滚入视口。

## 执行过的命令与结果

完整原始输出见 `logs/`。以下为实际结果，失败记录保留：

| 命令 | 实际输出摘要 |
| --- | --- |
| `git fetch origin`；`git show origin/main:docs/tasks/F1-F2.md \| grep -c '目前只有规则定义、没有文案'` | fetch 首次因沙箱拒写 `.git/FETCH_HEAD` 失败，获准重跑成功；同步检查输出 `1`，符合开工条件（`document-gate.txt`）。 |
| `pnpm install --frozen-lockfile` | 首次沙箱内执行遇 npm DNS `ENOTFOUND`，中止，见 `install.txt`；获准重跑成功，258 包、`Done in 4.5s`，见 `install-retry.txt`。 |
| `pnpm lint` | 首轮 3 个格式错误、1 个非空断言警告；修正后最终 `Checked 265 files`、无修复，见 `lint-first.txt`、`lint-final.txt`。 |
| `pnpm typecheck` | 首轮 `DEFAULT_RULE_IDS.includes` 类型过窄；修正后 contracts、web、worker 与 e2e TypeScript 均通过，见 `typecheck-first.txt`、`typecheck-final.txt`。 |
| `pnpm test:contracts` | 19 文件、177 测试通过，见 `contracts-first.txt`。 |
| `pnpm test` | 首轮因沙箱拒绝 Miniflare 监听 `127.0.0.1` 失败；获准重跑：contracts 177、worker 376 测试通过，见 `test.txt`、`test-rerun.txt`。 |
| `pnpm params:verify` | 首轮因沙箱拒绝 tsx IPC 失败；获准重跑：25/25 数值等式通过，见 `params.txt`、`params-rerun.txt`。 |
| `pnpm migrate:check` | 首轮因沙箱拒绝 Miniflare 监听失败；获准重跑：15 个迁移静态检查通过，空库重放 6/6 测试通过，见 `migrate.txt`、`migrate-rerun.txt`。 |
| `pnpm build` | 首轮退出码 0，但 Wrangler 本地日志写入被沙箱拒绝；获准重跑后 8 个 Web 页面构建完成、Worker dry-run 完成，见 `build.txt`、`build-final.txt`。 |
| `lsof -nP -iTCP:4173 -sTCP:LISTEN`；`pnpm test:e2e` | 每次启动前检查 4173。首轮 4 条失败：两项目的规则 DOM 顺序断言与动态选择器写法；修正后最终 55 通过、5 条按项目跳过，见 `e2e-first.txt`、`e2e-final.txt`。中途一次发现其他任务监听 4173，未干预，待端口释放后继续。 |

反向验证按 ACCEPTANCE §2.1 逐条先确认变异落地（`mutation-*-landed.txt` 均为 `1`），再运行对应 e2e：

| 人为回归与运行命令 | 预期失败与还原 |
| --- | --- |
| 规则为空时禁用变更消息；`pnpm test:e2e --grep 'U09a U10 清空全部'` | 桌面/手机均在 `toBeEnabled` 失败；还原标记计数 `0`，同命令 2/2 通过。 |
| 关闭日历提醒时清空规则；`pnpm test:e2e --grep 'U09 关闭日历提醒'` | 桌面/手机均在已选规则数组断言失败；还原标记计数 `0`，同命令 2/2 通过。 |
| 把预选显示为「云端已保存订阅」；`pnpm test:e2e --grep 'U09 初始值'` | 桌面/手机均在 `#cloud-state` 断言失败；还原标记计数 `0`，最终全量 e2e 55 通过。 |

## 验收测试

| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| U09 | `tests/e2e/subscription.spec.ts:U09 关闭日历提醒只改变日历选择…`；`U09 初始值来自 DEFAULT_*…`；`U09 U10 一个主按钮…` | 桌面与手机通过；第二、第三条也核对未启用 Feed 的表达、移动端焦点与遮挡。 |
| U09a | `tests/e2e/subscription.spec.ts:U09a U10 清空全部提前规则…`；`U09a 规则选项与推荐分组…`；`U09a 页面仅维护本机选择…` | 桌面与手机通过；空规则时变更开关可用，本机提交入口不报规则错误，无 API 请求。 |
| U10 | `tests/e2e/subscription.spec.ts:U09a U10 清空全部提前规则…`；`U09 U10 一个主按钮…` | 桌面与手机通过；最后一条取消后仅展示一句提示，无确认弹窗。 |

本卡三个验收 ID 均有覆盖；无未覆盖项。新增 contracts 文案测试 2 条也已执行。

## 证据

- E2：`desktop-subscription.png`、`mobile-subscription.png`，由本 worktree 的 Playwright 在 2026-09-28、`127.0.0.1:4173` 实际渲染生成；均是本机预选页面，无真实账户或 Feed。
- E1：`logs/e2e-final.txt`、`logs/test-rerun.txt`、`logs/lint-final.txt`、`logs/typecheck-final.txt`、`logs/params-rerun.txt`、`logs/migrate-rerun.txt`、`logs/build-final.txt`、`logs/install-retry.txt`。
- 反向验证：`logs/mutation-1-*`、`logs/mutation-2-*`、`logs/mutation-3-*`。失败断言与恢复绿色结果见各文件。

## 不在本次范围

实际日历预览正式版（F2-02，需 G-D2）、保存状态机与两设备冲突（F2-03）、本机草稿持久化（F2-04）、后端订阅 API（P2-06）、Feed/邮件/Push 启用流程均未实现。

## 已知问题与回退点

- 「保存订阅」当前只做本机校验并明确提示未写入云端；云端保存待 F2-03 与 P2-06 接入。实际预览保留无结果状态，待 F2-02 与 G-D2。
- Push 区域当前仅说明尚未开放，不提供开关；能力开放后的入口由后续任务决定。
- 回退点为本分支基线 `fd3dc97`（`origin/main` 建 worktree 时的提交）；合并后可 revert 本卡单个逻辑提交，不需数据迁移。
