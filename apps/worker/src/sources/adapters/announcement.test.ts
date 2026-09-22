// 公告 API 适配器（任务卡 P3-01，验收 ID A-P3-FETCH）。
// 样本全部来自 P0-02 真实抓取（synthetic:false，fixtures/sources/<source_id>/），
// 以 fetch 替身回放，不发真实网络请求。

import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import genshinList from "../../../../../fixtures/sources/genshin-ann/list-page-1.json";
import hsrList from "../../../../../fixtures/sources/hsr-ann/list-page-1.json";
import zzzList from "../../../../../fixtures/sources/zzz-ann/list-page-1.json";
import type { AnnouncementSourceEntry } from "../registry";
import { getSourceEntry } from "../registry";
import { createAnnouncementAdapter } from "./announcement";

const genshinEntry = getSourceEntry("genshin-ann") as AnnouncementSourceEntry;

/** 回放固定 JSON 响应并记录请求的 fetch 替身。 */
function replayFetch(
  body: unknown,
  status = 200,
  contentType = "application/json",
): {
  fetchFn: typeof fetch;
  requests: Array<{ url: string; init: RequestInit }>;
} {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe("A-P3-FETCH 公告适配器：全量快照模型（真实样本回放）", () => {
  it("genshin-ann getAnnList：41 条全集、complete=true、next_cursor=null、上游 ID 存字符串", async () => {
    const { fetchFn, requests } = replayFetch((genshinList as { body: unknown }).body);
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const result = await adapter.list(null, Number.POSITIVE_INFINITY);
    expect(result.failure).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(41);
    expect(result.skippedItems).toBe(0);
    expect(result.items.every((stub) => typeof stub.externalId === "string")).toBe(true);
    expect(result.items.map((stub) => stub.externalId)).toContain("21928");
    expect(result.items.map((stub) => stub.externalId)).toContain("762");
    expect(result.envelope?.timezone).toBe(8);
    expect(result.envelope?.total).toBe(41);
    expect(result.envelope?.typeLabels).toEqual(["游戏公告", "活动公告", "千星奇域"]);
    // 请求形状：已核验参数集（level/uid 门控，ADR-0001）+ 与采集一致的 page/page_size。
    const url = new URL(requests[0].url);
    expect(url.hostname).toBe("hk4e-ann-api.mihoyo.com");
    expect(url.pathname).toBe("/common/hk4e_cn/announcement/api/getAnnList");
    const params = url.searchParams;
    for (const [key, value] of Object.entries(genshinEntry.request.listParams)) {
      expect(params.get(key)).toBe(value);
    }
    expect(params.get("page")).toBe("1");
    expect(params.get("page_size")).toBe("20");
  });

  it("hsr-ann 与 zzz-ann：同一适配器、各自登记的参数与主机", async () => {
    const hsrEntry = getSourceEntry("hsr-ann") as AnnouncementSourceEntry;
    const { fetchFn: hsrFetch, requests: hsrRequests } = replayFetch(
      (hsrList as { body: unknown }).body,
    );
    const hsr = await createAnnouncementAdapter(hsrEntry, { fetchFn: hsrFetch }).list(
      null,
      Number.POSITIVE_INFINITY,
    );
    expect(hsr.complete).toBe(true);
    expect(hsr.items).toHaveLength(14);
    expect(new URL(hsrRequests[0].url).hostname).toBe("hkrpg-ann-api.mihoyo.com");
    expect(new URL(hsrRequests[0].url).searchParams.get("region")).toBe("prod_gf_cn");

    const zzzEntry = getSourceEntry("zzz-ann") as AnnouncementSourceEntry;
    const { fetchFn: zzzFetch } = replayFetch((zzzList as { body: unknown }).body);
    const zzz = await createAnnouncementAdapter(zzzEntry, { fetchFn: zzzFetch }).list(
      null,
      Number.POSITIVE_INFINITY,
    );
    expect(zzz.complete).toBe(true);
    expect(zzz.items).toHaveLength(18);
    // zzz 的 title 含 HTML：保真透出，去噪属 P3-02（P0-02 §2.5）。
    expect(zzz.items.some((stub) => stub.title.startsWith("<p"))).toBe(true);
  });

  it("全量快照型不接受 last-id-offset 游标（模型不混用）", async () => {
    const { fetchFn } = replayFetch((genshinList as { body: unknown }).body);
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    await expect(
      adapter.list({ model: "last-id-offset", newsType: "1", lastId: "20" }, 20),
    ).rejects.toThrow(/全量快照型/);
  });

  it("HTTP 200 但 retcode=-1003：complete 必须为 false，业务码透出", async () => {
    const { fetchFn } = replayFetch({ retcode: -1003, message: "提交参数有误", data: null });
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const result = await adapter.list(null, Number.POSITIVE_INFINITY);
    expect(result.complete).toBe(false);
    expect(result.failure).toMatchObject({ kind: "business-rejected", retcode: -1003 });
  });

  it("信封 message 命中访问限制标记：按 restricted 分类（停用标维护，不绕过）", async () => {
    const { fetchFn } = replayFetch({ retcode: -100, message: "请登录后重试", data: null });
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const result = await adapter.list(null, Number.POSITIVE_INFINITY);
    expect(result.complete).toBe(false);
    expect(result.failure?.kind).toBe("restricted");
  });

  it("非 JSON 响应体：malformed-body、complete=false", async () => {
    const { fetchFn } = replayFetch("<html>not json</html>", 200, "text/html");
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const result = await adapter.list(null, Number.POSITIVE_INFINITY);
    expect(result.complete).toBe(false);
    expect(result.failure?.kind).toBe("bad-content-type");
  });

  it("fetchArticle：全量正文集合在单条上的投影（getAnnContent 忽略 announcement_id，P0-02 §2.2）", async () => {
    const { fetchFn, requests } = replayFetch((genshinContent as { body: unknown }).body);
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const article = await adapter.fetchArticle({ sourceId: "genshin-ann", externalId: "21928" });
    expect(article.status).toBe("fetched");
    if (article.status !== "fetched") return;
    expect(article.contentHtml.length).toBeGreaterThan(0);
    // 正文保留官方转义标签（&lt;t class="t_gl"&gt; 时间高亮，P0-02 §2.3）。
    expect(article.contentHtml).toContain('&lt;t class="t_gl"');
    expect(article.signals.contentEmpty).toBe(false);
    expect(article.signals.contentBytes).toBeGreaterThan(0);
    // 请求不带单篇参数——单篇通道不存在。
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/common/hk4e_cn/announcement/api/getAnnContent");
    expect(url.searchParams.get("announcement_id")).toBeNull();
  });

  it("fetchArticle：集合中无此 ann_id → missing-from-content-set（缺口原料，不是失败）", async () => {
    const { fetchFn } = replayFetch((genshinContent as { body: unknown }).body);
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const article = await adapter.fetchArticle({ sourceId: "genshin-ann", externalId: "999999" });
    expect(article.status).toBe("missing-from-content-set");
  });

  it("完整性信号：图片数与空正文（信号传出去，缺口判定属 P3-02）", async () => {
    const body = (genshinContent as { body: { data: { list: unknown[] } } }).body;
    const entries = body.data.list as Array<{ ann_id: number; title: string; content: string }>;
    const withImage = entries.find((entry) => entry.content.includes("<img"));
    expect(withImage).toBeDefined();
    if (withImage === undefined) return;
    const { fetchFn } = replayFetch(body);
    const adapter = createAnnouncementAdapter(genshinEntry, { fetchFn });
    const article = await adapter.fetchArticle({
      sourceId: "genshin-ann",
      externalId: String(withImage.ann_id),
    });
    expect(article.status).toBe("fetched");
    if (article.status !== "fetched") return;
    expect(article.signals.imageCount).toBeGreaterThan(0);

    // 构造空正文条目（验证信号通路，非官方样本）：contentEmpty=true 如实传出。
    const emptied = entries.map((entry) => ({ ...entry, content: "" }));
    const emptyFetch = replayFetch({ ...body, data: { ...body.data, list: emptied } });
    const emptyAdapter = createAnnouncementAdapter(genshinEntry, { fetchFn: emptyFetch.fetchFn });
    const emptyArticle = await emptyAdapter.fetchArticle({
      sourceId: "genshin-ann",
      externalId: String(entries[0].ann_id),
    });
    expect(emptyArticle.status).toBe("fetched");
    if (emptyArticle.status !== "fetched") return;
    expect(emptyArticle.signals.contentEmpty).toBe(true);
    expect(emptyArticle.signals.imageCount).toBe(0);
  });
});
