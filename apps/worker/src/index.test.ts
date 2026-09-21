import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// 占位用例（任务卡 P1-01）：证明 Vitest + @cloudflare/vitest-pool-workers
// 能在真实 workerd + miniflare 上执行 Worker 代码（绑定来自 wrangler.jsonc）。
// 业务测试由后续任务卡补充。
describe("A-P1-REPO 仓库骨架与工具链", () => {
  it("A-P1-REPO 占位用例在真实 workerd（vitest-pool-workers）上执行 Worker 入口", async () => {
    const res = await SELF.fetch("https://skeleton.local/");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("P1-01");
  });
});
