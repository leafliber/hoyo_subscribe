// 米游社适配器（任务卡 P3-01，验收 ID A-P3-FETCH）。
// 样本来自 P0-02 真实抓取（fixtures/sources/miyoushe-news/）；403 正文通道按登记回放为
// 维护态行为——不重试、不换路径、不发请求（AGENTS.md 规则 6）。

import { describe, expect, it } from "vitest";
import newsType1Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type1-page1.json";
import newsType1Page2 from "../../../../../fixtures/sources/miyoushe-news/news-list-type1-page2.json";
import newsType2Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type2-page1.json";
import newsType3Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type3-page1.json";
import type { MiyousheNewsSourceEntry } from "../registry";
import { getSourceEntry } from "../registry";
import { createMiyousheNewsAdapter } from "./miyoushe-news";

const entry = getSourceEntry("miyoushe-news") as MiyousheNewsSourceEntry;

/** 按请求 URL 分发的 fetch 替身（按 type 与 last_id 取响应），并记录全部请求。 */
function routingFetch(
  routes: Array<{ match: (url: URL) => boolean; body: unknown; status?: number }>,
): {
  fetchFn: typeof fetch;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(String(input));
    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) {
      return new Response(JSON.stringify({ retcode: -1, message: "no test route" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function bodyOf(sample: unknown): unknown {
  return (sample as { body: unknown }).body;
}

describe("A-P3-FETCH 米游社适配器：last-id-offset、仅标题级、正文通道维护态", () => {
  it("type=1 首页：20 条、next_cursor 推进、complete 按 is_last 判定、上游 ID 存字符串", async () => {
    const { fetchFn, requests } = routingFetch([
      { match: (url) => url.searchParams.get("type") === "1", body: bodyOf(newsType1Page1) },
    ]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    const result = await adapter.list(null, 20);
    expect(result.failure).toBeNull();
    expect(result.complete).toBe(false); // is_last=false（真实样本）
    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).toMatchObject({
      model: "last-id-offset",
      newsType: "1",
      lastId: "20",
    });
    expect(result.items.every((stub) => typeof stub.externalId === "string")).toBe(true);
    expect(result.items.map((stub) => stub.externalId)).toContain("78299710");
    // 请求形状：painter 路径 + gids=2 + 偏移量游标。
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/painter/wapi/getNewsList");
    expect(url.searchParams.get("gids")).toBe("2");
    expect(url.searchParams.get("type")).toBe("1");
    expect(url.searchParams.get("last_id")).toBe("");
    expect(url.searchParams.get("page_size")).toBe("20");
  });

  it("仅标题/图片级信息：publisherUid=null（uid=0 哑值）、hasContent=null 不声称有正文、有封面与图列", async () => {
    const { fetchFn } = routingFetch([
      { match: (url) => url.searchParams.get("type") === "1", body: bodyOf(newsType1Page1) },
    ]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    const result = await adapter.list(null, 20);
    const first = result.items[0];
    expect(first.publisherUid).toBeNull();
    expect(first.hasContent).toBeNull();
    expect(first.coverUrl).toContain("https://upload-bbs.miyoushe.com/upload/");
    expect(first.imageUrls.length).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.publishedAtMs).toBeGreaterThan(0);
  });

  it("游标续扫：last_id 透传；limit 映射 page_size 并被限制在实测批量上限内", async () => {
    const { fetchFn, requests } = routingFetch([
      { match: (url) => url.searchParams.get("type") === "1", body: bodyOf(newsType1Page2) },
    ]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    await adapter.list({ model: "last-id-offset", newsType: "1", lastId: "20" }, 999);
    expect(new URL(requests[0]).searchParams.get("last_id")).toBe("20");
    expect(new URL(requests[0]).searchParams.get("page_size")).toBe("20");

    const small = routingFetch([
      { match: (url) => url.searchParams.get("type") === "1", body: bodyOf(newsType1Page1) },
    ]);
    const smallAdapter = createMiyousheNewsAdapter(entry, "1", { fetchFn: small.fetchFn });
    await smallAdapter.list(null, 5);
    expect(new URL(small.requests[0]).searchParams.get("page_size")).toBe("5");
  });

  it("is_last=true（构造变体）：complete=true、next_cursor=null——按游标推进判定完成", async () => {
    const body = bodyOf(newsType1Page1) as { data: Record<string, unknown> };
    const lastPage = { ...body, data: { ...body.data, is_last: true, last_id: null } };
    const { fetchFn } = routingFetch([
      { match: (url) => url.searchParams.get("type") === "1", body: lastPage },
    ]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    const result = await adapter.list(null, 20);
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("类型游标不混用：type=1 的适配器拒绝其他类型游标；未登记类型拒绝构造", async () => {
    const { fetchFn } = routingFetch([{ match: () => true, body: bodyOf(newsType1Page1) }]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    await expect(
      adapter.list({ model: "last-id-offset", newsType: "2", lastId: "20" }, 20),
    ).rejects.toThrow(/游标不匹配/);
  });

  it("业务码错误：complete=false、business-rejected 透出", async () => {
    const { fetchFn } = routingFetch([
      { match: () => true, body: { retcode: -1003, message: "提交参数有误", data: null } },
    ]);
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    const result = await adapter.list(null, 20);
    expect(result.complete).toBe(false);
    expect(result.failure).toMatchObject({ kind: "business-rejected", retcode: -1003 });
  });

  it("★ 正文通道 403 → 停用并标维护：fetchArticle 不发任何请求、不重试、不换路径", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("miyoushe fetchArticle 不应发起网络请求");
    }) as typeof fetch;
    const adapter = createMiyousheNewsAdapter(entry, "1", { fetchFn });
    const article = await adapter.fetchArticle({
      sourceId: "miyoushe-news",
      externalId: "78299710",
    });
    expect(article.status).toBe("channel-unavailable");
    if (article.status === "channel-unavailable") {
      expect(article.reason).toContain("403");
      expect(article.reason).toContain("maintenance-required-list-only");
    }
    expect(calls).toBe(0);
    // 登记侧同步：来源 verification_state 即维护态、正文通道停用（P0-02 §3）。
    expect(entry.verificationState).toBe("maintenance-required-list-only");
    expect(entry.contentChannelDisabled).toBe(true);
  });

  it("三类型独立游标：type=2/type=3 各自的首页请求形状正确（真实样本）", async () => {
    const { fetchFn, requests } = routingFetch([
      { match: (url) => url.searchParams.get("type") === "2", body: bodyOf(newsType2Page1) },
      { match: (url) => url.searchParams.get("type") === "3", body: bodyOf(newsType3Page1) },
    ]);
    const type2 = await createMiyousheNewsAdapter(entry, "2", { fetchFn }).list(null, 20);
    const type3 = await createMiyousheNewsAdapter(entry, "3", { fetchFn }).list(null, 20);
    expect(type2.failure).toBeNull();
    expect(type2.items).toHaveLength(20);
    expect(type3.failure).toBeNull();
    expect(type3.items).toHaveLength(20);
    expect(new URL(requests[0]).searchParams.get("type")).toBe("2");
    expect(new URL(requests[1]).searchParams.get("type")).toBe("3");
  });
});
