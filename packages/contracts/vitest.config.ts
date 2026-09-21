import { defineConfig } from "vitest/config";

// L1 纯函数测试（ENGINEERING.md §7）：跑默认 Node 环境，不需要 workerd；
// 用例与被测模块同目录（packages/contracts/src/**/*.test.ts）。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
