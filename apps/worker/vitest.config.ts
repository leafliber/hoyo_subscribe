import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// @cloudflare/vitest-pool-workers@0.22 起，配置入口是根导出的 cloudflareTest Vite 插件
// （原 /config 的 defineWorkersConfig 已移除；Cloudflare 后续将本包更名为
// @cloudflare/vitest-plugin，API 相同，届时迁移属独立任务卡）。
// 绑定与 compatibility_date 直接读取 wrangler.jsonc，避免第二份配置源（任务卡 P1-01）。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
