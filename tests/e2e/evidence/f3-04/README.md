# F3-04 日历订阅区域证据

采集时间：2026-10-03，Asia/Shanghai。全部截图使用合成账号、合成活动与接口响应；不代表外部日历客户端的新增实测结论。完整私人地址没有写入页面、截图或偏好，日历测试关闭 trace。

## 浏览器合成证据

首轮执行（基线 683b708；截图沿用该轮，本轮未改 UI）：`CI=1 WRANGLER_SEND_METRICS=false pnpm test:e2e`，761 passed、5 skipped。5 项为仓库原有的桌面/移动平台分流跳过。截图直接取自本轮 Playwright 输出，桌面和移动端各一套：

- `*-saved-confirmation.png`：U20 完整服务端已保存预览、关联节点、再次明确确认入口。
- `*-enabled-states.png`：U20 地址、配置、输出、客户端四种独立事实；不显示完整地址。
- `*-integrity-blocked.png`：U21a 完整性守卫保护文案、上次成功时间与条目数、重试及维护者入口。
- `*-mail-capacity.png`：U22a 邮件满额转向同一个日历区域的真实入口；点击后仍需读取、预览及确认，不自动开通。

测试源：`tests/e2e/calendar.spec.ts`、`tests/e2e/email-capacity.spec.ts`。U11 另覆盖保存后继续、使用已保存设置及保存冲突。

## 本地真实 Worker / D1

在 `pnpm build` 后运行：

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx apps/web/src/features/channels/calendar/testing/local-flow.mjs
```

使用 Wrangler 构建产物、Miniflare/workerd 与实际 D1，重放全部迁移。账号、会话、恢复码确认事实与来源快照均为隔离合成数据；临时密钥不输出、不落入仓库。

实际通过：保存订阅 → 完整已保存预览 → 陈旧版本拒绝 → 未确认/受限恢复码准入拒绝 → 启用 → 同键幂等回放 → 所有者读取 → 无 Cookie ICS 与 VALARM → 停用 → 旧地址拒绝；真实 401/409/429 错误体直接交给前端解析器，验证 `error.details.reason` / `retry_after_ms`。

完整终端日志保存在源码外：`/tmp/f3-04-local-flow-verified.log`。八条完整检查日志在 `/tmp/f3-04-final/`，`results.json` 记录退出码与耗时；build 外层限时 300 秒，实际 1.76 秒、退出 0。这些本机临时日志不作为可永久下载的仓库附件；交付报告保留命令与真实结果摘要。

## 证据边界

没有发送真实邮件、调用生产发送链、开通资源或新增迁移。客户端结论仅继承 2026-09-22 已登记的 Apple Calendar/macOS 实测范围；版本与刷新延迟未记录，Google Calendar/Outlook 仍未测。新的真实设备、生产部署证据需所有者执行。

## 运行门集成返工（2026-10-03）

原分支通过 merge 提交 `1941f9a` 合入 main `304af8b`（含 P5-01 #74），没有 rebase。本轮仅修改本地合成探针与本说明，没有改 Worker 生产默认、门条件、参数或迁移。

修复前独立执行旧探针，确实在原第 236 行 `stale preview refused` 收到 503、期望 409，exit 1；日志 `/tmp/f3-04-r2/before-flow-independent.log`。这是已合入运行门的正确缺省关闭，不以首轮旧基线成功替代本轮集成证据。首轮 CI 曾有既有分页用例 5000ms 超时，原提交重跑通过；完整历史仍保留在 PR 报告中。

正向环境现在仅在隔离 D1 显式写 `calendar_enabled=true`、`read_only=false`。原完整预览、陈旧发布版本 409、恢复码拒绝、启用/同键幂等、无 Cookie ICS/VALARM、停用与真实错误体解析断言全部保留。

新增真实接口矩阵：

| 独立场景 | 被门拒绝的操作 | 仍然允许 |
| --- | --- | --- |
| calendar_enabled 缺失，read_only=false | enable（有效地址及停用后再启用） | 所有者读取、完整已保存预览、有效地址 ICS/VALARM、停用 |
| calendar_enabled=false，read_only=false | enable（有效地址及停用后再启用） | 同上 |
| calendar_enabled=true，read_only=true | enable、reset；停用后再 enable | 同上 |

既有 calendar_enabled 只拦启用，read_only 拦启用与重置，探针按各自实际门断言，不增加生产权限规则。每次拒绝均检查 503 temporarily_unavailable，并逐字比较 Feed、账号、会话、订阅、额度表的前后快照，保证未换地址、未增代次、未改回执/额度；私密数据只在内存比较，失败也不输出。三种场景都验证停用使旧地址返回 404。

本轮统一 `CI=1 WRANGLER_SEND_METRICS=false`，顺序执行 install --frozen-lockfile、lint、typecheck、params:verify、migrate:check、test、build、test:e2e，再执行上面的 tsx 探针，九条全部 exit 0。结果：参数 30/30、迁移 0001–0025/schema 13、contracts 271、Worker 1057、E2E 761 passed/5 既有 skipped；build 1.86 秒正常退出，外层 300 秒未触发；随后探针 3.25 秒通过原闭环与三个运行门场景。

最终日志 `/tmp/f3-04-r2/1-install.log` 至 `9-exec.log`，`results.json` 记录退出码与耗时，`run.py` 记录命令顺序和超时。它们是源码外本机证据，不是仓库可下载附件；新的同提交 CI 结果单列于 PR。专项探针不属于标准 CI 收集，不把 CI 全绿写成它已自动执行。
