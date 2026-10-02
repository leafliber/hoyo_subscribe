import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("U02 构建只包含无事实详情壳；重写不覆盖 API、Feed、退订", async ({ request }) => {
  expect(readdirSync(resolve("apps/web/dist/events"))).toEqual(["detail"]);
  const html = readFileSync(resolve("apps/web/dist/events/detail/index.html"), "utf8");
  expect(html).not.toContain("巡游拾光");
  expect(html).not.toContain("synthetic");
  expect(readFileSync(resolve("apps/web/dist/_redirects"), "utf8").trim()).toBe(
    "/events/* /events/detail/ 200",
  );
  for (const path of [
    "/api/v2/events/evt_unmatched",
    "/feeds/unmatched",
    "/unsubscribe/unmatched",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('id="event-detail"');
  }
});

test("U02 本地服务读取同份规则；不支持的写法在监听端口前直接失败", () => {
  const root = mkdtempSync(join(tmpdir(), "f1-06-routing-"));
  try {
    mkdirSync(join(root, "scripts/e2e"), { recursive: true });
    mkdirSync(join(root, "apps/web/dist"), { recursive: true });
    writeFileSync(
      join(root, "scripts/e2e/serve.mjs"),
      readFileSync(resolve("scripts/e2e/serve.mjs")),
    );
    for (const rule of [
      "/events/* /events/detail/index.html 301",
      "/events/id /events/detail/index.html 200",
      "/events/* https://example.test 200",
      "/events/* //example.test/detail 200",
      "/events/* /../private.html 200",
    ]) {
      writeFileSync(join(root, "apps/web/dist/_redirects"), rule);
      const result = spawnSync(process.execPath, [join(root, "scripts/e2e/serve.mjs")], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("仅支持站内 200 + 尾部通配改写");
      expect(result.stdout).not.toContain("E2E 静态服务：");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
