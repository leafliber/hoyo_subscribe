# F4-04 · U29 页面证据

2026-10-02 使用锁定 Playwright Chromium，在实际构建的 `/account` 页面操作后截图。
全部账号事实、验证码、恢复码、CSRF 和接口结果均为 synthetic 测试替身；仅通过初始化脚本提供公开测试 sitekey，未注入替代页面或模块。Turnstile 脚本被本地替身拦截，没有真实邮件、真实账号或生产写入。

- `desktop-chromium-email-changed.png` / `mobile-chromium-email-changed.png`：服务端换邮箱成功回执后，旧身份视图清空；说明旧会话撤销、新邮箱业务邮件尚未开启、配置仍归原账号，并提供现有登录页的新会话激活入口。
- `desktop-chromium-deleting.png` / `mobile-chromium-deleting.png`：删除用途 OTP 与确认操作后，收到 `deleting` 才显示权限停止、数据仍在清理。没有宣称清理完成。

四张截图已目视检查。提交截图不含完整邮箱、验证码、恢复码、Cookie 或私人 URL。它们是 E2 合成页面证据，不是 E3 真实邮箱/Turnstile/生产生命周期取证。

生成命令（先使用最终 `pnpm build` 产物）：

```sh
CI=1 WRANGLER_SEND_METRICS=false HOYO_E2E_WRITE_EVIDENCE=1 pnpm exec playwright test --config tests/e2e/playwright.config.ts account-maintenance.spec.ts --grep '成功页面证据|删除 OTP 流程 success'
```

实际结果：4 passed。普通 `pnpm test:e2e` 将截图写入被忽略的 `tests/e2e/test-results/`，不会覆盖本目录。

完整命令与结果、70 条本卡标准 E2E 及原账号管理 100 条回归见本卡 PR 交付报告；真实外部服务联调需所有者在另行授权的环境执行。
