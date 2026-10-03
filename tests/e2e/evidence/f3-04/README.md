# F3-04 日历订阅区域证据

采集时间：2026-10-03，Asia/Shanghai。全部截图使用合成账号、合成活动与接口响应；不代表外部日历客户端的新增实测结论。完整私人地址没有写入页面、截图或偏好，日历测试关闭 trace。

## 浏览器合成证据

最终执行：`CI=1 WRANGLER_SEND_METRICS=false pnpm test:e2e`，761 passed、5 skipped。5 项为仓库原有的桌面/移动平台分流跳过。截图直接取自本轮 Playwright 输出，桌面和移动端各一套：

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
