import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// 放在 tests/e2e/ 下（而非仓库根）：ENGINEERING §7 的 L5 层就把前端 E2E
// 固定在 tests/e2e/**，配置与用例同目录；仓库根保持只挂根级脚本。
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: ["*.spec.ts"],
  outputDir: "./test-results",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    // 先由根 test:e2e 脚本完成 astro build，这里只负责起静态预览服务
    // （端口固化在 apps/web 的 preview 脚本里：astro CLI 不接受透传参数）
    command: "pnpm --filter @hoyo/web run preview",
    url: "http://127.0.0.1:4173",
    cwd: repoRoot,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
