import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// @cloudflare/vitest-pool-workers@0.22 起，配置入口是根导出的 cloudflareTest Vite 插件
// （原 /config 的 defineWorkersConfig 已移除；Cloudflare 后续将本包更名为
// @cloudflare/vitest-plugin，API 相同，届时迁移属独立任务卡）。
// 绑定与 compatibility_date 直接读取 wrangler.jsonc，避免第二份配置源（任务卡 P1-01）。
// 这四个文件包含 3000 次恢复凭证读取、6000 节点回收、120 节点展开或
// 1000 条反馈归档。单文件/组合/全量对照显示，独立 workerd 争用会放大
// D1 往返耗时；让它们在其余文件完成后逐文件运行，保留默认超时与所有断言。
const loadFiles = [
  "src/auth/recovery/recovery.test.ts",
  "src/executors/pipeline/runtime.test.ts",
  "src/mail/dispatch/dispatch.test.ts",
  "src/mail/feedback/feedback.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["src/**/*.test.ts"],
          exclude: loadFiles,
          sequence: { groupOrder: 0 },
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker-load",
          include: loadFiles,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
