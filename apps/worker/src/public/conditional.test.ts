// ADR-0032 · 公开读取的条件请求：经完整 Worker 外壳，真实本地 D1，合成快照。
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
import { seedOperationalControls } from "../shell/observability/test-support";
import { etagMatches, publicEtag } from "./conditional";
import { makeNode, migratePublicTest, resetPublicTest, seedNodes } from "./test-support";

const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://app.test/api/v2/${path}`, { headers }), env, {
    waitUntil() {},
  } as unknown as ExecutionContext);

beforeAll(migratePublicTest);
beforeEach(async () => {
  await resetPublicTest();
  await seedOperationalControls(env.DB);
  await seedNodes([makeNode()]);
});

describe("ADR-0032 公开读取的 ETag 与 304", () => {
  it.each(["catalog", "events?range=all", "status", "redeem-codes", "events/event"])(
    "%s：首次 200 带 ETag；带回 If-None-Match 得 304、无正文；仍是 no-cache",
    async (path) => {
      const first = await get(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
      expect(first.headers.get("cache-control")).toBe("no-cache");
      await first.text();
      const second = await get(path, { "if-none-match": etag ?? "" });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");
      expect(second.headers.get("etag")).toBe(etag);
      expect(second.headers.get("cache-control")).toBe("no-cache");
    },
  );

  it("内容变了（换代发布）ETag 随之变化，旧 ETag 得到完整新内容", async () => {
    const first = await get("events?range=all");
    const etag = first.headers.get("etag") ?? "";
    const node = makeNode("second", "event-2");
    await seedNodes([makeNode(), node], 2);
    const next = await get("events?range=all", { "if-none-match": etag });
    expect(next.status).toBe(200);
    expect(next.headers.get("etag")).not.toBe(etag);
    expect(
      ((await next.json()) as { publication: { generation: number } }).publication.generation,
    ).toBe(2);
  });

  it("只有 cache 字段（每次都是当时的生成时间）不同的两份响应 ETag 相同", async () => {
    const body = { publication: { generation: 1 }, nodes: [1, 2] };
    expect(
      await publicEtag({ ...body, cache: { generatedAt: 1, freshUntil: 2, stale: false } }),
    ).toBe(await publicEtag({ ...body, cache: { generatedAt: 9, freshUntil: 10, stale: false } }));
    expect(await publicEtag({ ...body, nodes: [1] })).not.toBe(await publicEtag(body));
  });

  it("If-None-Match 按弱比较：列表、强弱写法、* 都认；不相干的值不认", () => {
    const etag = 'W/"abc"';
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('W/"x", W/"abc"', etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches('W/"abd"', etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
  });

  it("错误响应不带 ETag，条件请求也照常报错", async () => {
    const bad = await get("events?range=forever", { "if-none-match": "*" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("etag")).toBeNull();
  });
});
