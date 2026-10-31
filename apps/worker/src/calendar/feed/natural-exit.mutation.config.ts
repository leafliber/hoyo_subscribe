// P3-13：只在测试转换阶段注入 P3-06 第 3 轮存活变异，不修改生产源文件。
// 从 apps/worker 运行：pnpm exec vitest run --config src/calendar/feed/natural-exit.mutation.config.ts src/calendar/feed/handler.test.ts -t '展示时间早于事实时间'
// 预期退出 1：上界回归必须击杀把事实时间退出项替换为 now 的变异。
import { mergeConfig } from "vitest/config";
import config from "../../../vitest.config";

export default mergeConfig(config, {
  plugins: [
    {
      name: "p3-13-natural-exit-fact-time-mutant",
      enforce: "pre",
      transform(code: string, id: string) {
        if (!id.endsWith("/personal-calendar.ts")) return;
        const original =
          "item.node.tombstone ? now : windowExit(item.node.projection.milestone.time)";
        if (!code.includes(original)) throw new Error("P3-13 变异目标已改变，请更新探针");
        return { code: code.replace(original, "now"), map: null };
      },
    },
  ],
});
