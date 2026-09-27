import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// 放在 tests/e2e/ 下（而非仓库根）：ENGINEERING §7 的 L5 层就把前端 E2E
// 固定在 tests/e2e/**，配置与用例同目录；仓库根保持只挂根级脚本。
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baseURL = "http://127.0.0.1:4173";

// Playwright 在启动 webServer.command 前就会检查 URL；先报告监听者，避免它的
// 通用 "already used" 错误隐藏占用本次构建端口的进程。
if (process.env.TEST_WORKER_INDEX === undefined) {
  // Playwright worker 会再次加载此配置；那时本次 webServer 已经在监听。
  const listener = spawnSync("lsof", ["-nP", "-iTCP:4173", "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (listener.status === 0 && listener.stdout.trim()) {
    throw new Error(`E2E 端口 4173 已被占用：\n${listener.stdout.trim()}`);
  }
}

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
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    // 根 test:e2e 脚本先完成 astro build；前台进程直接服务本次构建。
    command: "node scripts/e2e/serve.mjs",
    url: baseURL,
    cwd: repoRoot,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
