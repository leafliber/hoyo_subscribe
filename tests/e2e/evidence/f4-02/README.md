# F4-02 容量呈现证据

2026-10-02 在实际静态构建的 `/subscription` 上由 Playwright 截取。账号、邮件状态、余量和同意结果均为 synthetic API 替身；没有真实账号、真实发信或平台调用。截图仅含脱敏合成地址。

- `desktop-chromium-seat-full.png`、`mobile-chromium-seat-full.png`：席位满；四项说明和未接通的日历入口。
- `desktop-chromium-routine-full.png`、`mobile-chromium-routine-full.png`：仅常规子名额不足；既有席位保留，发送暂停独立呈现。
- `desktop-chromium-partial.png`、`mobile-chromium-partial.png`：两层申请部分完成；新取得席位保留。

生成命令（20 passed）：

```sh
CI=1 WRANGLER_SEND_METRICS=false HOYO_E2E_WRITE_EVIDENCE=1 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/email-capacity.spec.ts
```

普通 `pnpm test:e2e` 仅写入忽略的 test-results，不覆盖这些截图。

这些是 E2 容量呈现证据。F3-04 在开工基线 `33a55f7` 尚未接通，日历启用入口明确置灰，没有跳转到占位页，也没有自动启用日历。
**U22a 的实际日历启用跳转闭环未完成，待 F3-04 接通后复验；本组 API 替身不能作为生产闭环证据。**
完整命令结果、首次端口占用失败与回退点见 PR 交付报告。
