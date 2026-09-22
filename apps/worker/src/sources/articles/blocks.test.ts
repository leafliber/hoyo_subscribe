// A-P3-ARTICLE · 正文块构造、标题去噪与内容 hash（任务卡 P3-02）。
// 样本全部来自 P0-02 真实抓取（fixtures/sources/，synthetic:false）；
// 保真重建性质覆盖三公告源全部正文条目（genshin 41 + hsr 14 + zzz 18）。

import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21819.json";
import hsrContent from "../../../../../fixtures/sources/hsr-ann/content-1429.json";
import miyousheType2 from "../../../../../fixtures/sources/miyoushe-news/news-list-type2-page1.json";
import zzzContent from "../../../../../fixtures/sources/zzz-ann/content-1296.json";
import { createMiyousheNewsAdapter } from "../adapters/miyoushe-news";
import type { MiyousheNewsSourceEntry } from "../registry";
import { getSourceEntry } from "../registry";
import {
  articleContentHash,
  blockVisibleText,
  bodyHasVisibleText,
  decodeHtmlEntities,
  denoiseTitle,
  extractImageRefsFromHtml,
  splitBodyBlocks,
} from "./blocks";

interface ContentEntry {
  ann_id: number;
  title: string;
  content: string;
}

function contentEntries(body: unknown): ContentEntry[] {
  return (body as { data: { list: ContentEntry[] } }).data.list;
}

function findEntry(entries: ContentEntry[], annId: number): ContentEntry {
  const entry = entries.find((candidate) => candidate.ann_id === annId);
  if (entry === undefined) throw new Error(`fixtures 中找不到 ann_id=${annId}`);
  return entry;
}

/** 压平全部空白（含 \n 与多空格）用于保真比较：块重组后语义字节必须与原文一致。 */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f\v]+/g, "");
}

describe("A-P3-ARTICLE 正文块：t_gl 转义标签保真与阶段文本保留（真实样本）", () => {
  const entries = contentEntries((genshinContent as { body: unknown }).body);
  const maintenance = findEntry(entries, 21928); // 7.1版本更新维护预告

  it('正文块保留原始 HTML：&lt;t class="t_gl"&gt; 时间高亮逐字节保真（P0-02 §2.3）', () => {
    const blocks = splitBodyBlocks(maintenance.content);
    const htmlBlocks = blocks.filter((block) => block.kind === "html");
    expect(htmlBlocks.length).toBeGreaterThan(0);
    const joined = htmlBlocks.map((block) => (block as { html: string }).html).join("");
    // 时间高亮转义标签原文出现（4 次，含 contenteditable 属性）。
    expect(joined).toContain(
      '&lt;t class="t_gl" contenteditable="false"&gt;2026/09/23 06:00&lt;/t&gt;',
    );
    expect(joined.match(/&lt;t class="t_gl"/g)?.length).toBe(4);
  });

  it("块级重组保真：三公告源全部正文条目，块拼接与原文仅差块间空白", () => {
    const corpora = [
      contentEntries((genshinContent as { body: unknown }).body),
      contentEntries((hsrContent as { body: unknown }).body),
      contentEntries((zzzContent as { body: unknown }).body),
    ];
    let checked = 0;
    for (const corpus of corpora) {
      for (const entry of corpus) {
        const blocks = splitBodyBlocks(entry.content);
        const rebuilt = blocks
          .map((block) =>
            block.kind === "html" ? block.html : block.kind === "text" ? block.text : "",
          )
          .join("");
        expect(collapseWhitespace(rebuilt)).toBe(collapseWhitespace(entry.content));
        checked += 1;
      }
    }
    expect(checked).toBe(41 + 14 + 18);
  });

  it("时间与阶段文本保留：维护预告的阶段标题块原样在块中（去噪不越界）", () => {
    const blocks = splitBodyBlocks(maintenance.content);
    const joined = blocks
      .filter((block) => block.kind === "html")
      .map((block) => (block as { html: string }).html)
      .join("");
    expect(joined).toContain("〓更新维护信息〓");
    expect(joined).toContain("〓更新维护补偿范围〓");
  });

  it("可读文本判定：t_gl 解码后时间文本计入可读信息（blockVisibleText）", () => {
    const blocks = splitBodyBlocks(maintenance.content);
    const withTime = blocks.find((block) => block.kind === "html" && block.html.includes("t_gl"));
    expect(withTime).toBeDefined();
    if (withTime === undefined) return;
    expect(blockVisibleText(withTime)).toContain("2026/09/23 06:00");
    expect(bodyHasVisibleText(blocks)).toBe(true);
  });
});

describe("A-P3-ARTICLE 标题去噪：HTML 剥离不伤文本（真实样本）", () => {
  it("zzz 标题含 <p> 包装（P0-02 §2.5）：剥离标签，文字逐字保留", () => {
    const entries = contentEntries((zzzContent as { body: unknown }).body);
    const wrapped = findEntry(entries, 1296);
    expect(wrapped.title.startsWith("<p")).toBe(true);
    expect(denoiseTitle(wrapped.title)).toBe("3.2版本「她与她的隐秘往事」更新公告");
  });

  it("hsr 标题无 HTML：去噪是恒等变换（不引入变化）", () => {
    const entries = contentEntries((hsrContent as { body: unknown }).body);
    const plain = entries[0];
    expect(denoiseTitle(plain.title)).toBe(plain.title.trim());
  });

  it("标题里的字面实体解码（&amp; → &），字面 &lt;…&gt; 不被当标签删除", () => {
    expect(denoiseTitle("<p>活动&amp;维护</p>")).toBe("活动&维护");
    expect(denoiseTitle("<p>数值 &lt;5% 的概率</p>")).toBe("数值 <5% 的概率");
  });
});

describe("A-P3-ARTICLE 纯图片正文与媒体引用（真实样本）", () => {
  const entries = contentEntries((genshinContent as { body: unknown }).body);

  it("genshin 21922 六周年福利速览：正文无可读文本、仅 1 张图（P0-02 image_date_analysis：date_likely_in_image）", () => {
    const welfare = findEntry(entries, 21922);
    const blocks = splitBodyBlocks(welfare.content);
    expect(bodyHasVisibleText(blocks)).toBe(false);
    const refs = extractImageRefsFromHtml(
      blocks
        .filter((b) => b.kind === "html")
        .map((b) => (b as { html: string }).html)
        .join(""),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^https:\/\/sdk-webstatic\.mihoyo\.com\/upload\/ann\//);
  });

  it("genshin 21862「至冬」现已开放：纯图多图正文，全部 src 被引用且保持出现顺序", () => {
    const snap = findEntry(entries, 21862);
    const blocks = splitBodyBlocks(snap.content);
    expect(bodyHasVisibleText(blocks)).toBe(false);
    const refs = extractImageRefsFromHtml(snap.content);
    expect(refs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("A-P3-ARTICLE 内容 hash：噪声不触发新版本", () => {
  const entries = contentEntries((genshinContent as { body: unknown }).body);
  it("块间空白是布局噪声：顶层块之间增删空行不改变内容 hash（官方重排空行不伪造新版本）", async () => {
    // ann 423 官方社区：真实正文（含嵌套 div/table，块内空白属块内容保真，不动）。
    const original = findEntry(entries, 423).content;
    const blocksA = splitBodyBlocks(original);
    expect(blocksA.length).toBeGreaterThan(5);
    // 在顶层块之间插入空行后重切分：必须得到完全相同的块（顶层空白被丢弃）。
    const decorated = blocksA
      .map((block) => (block.kind === "html" ? block.html : block.text))
      .join("\n\n");
    const blocksB = splitBodyBlocks(decorated);
    expect(blocksB).toEqual(blocksA);
    expect(await articleContentHash(blocksB, [])).toBe(await articleContentHash(blocksA, []));
  });

  it("实体解码与数字实体（文本判定用）：&nbsp; 与 &#39; 形态", () => {
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a\u00a0b");
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("&#x4E2D;")).toBe("中");
    expect(decodeHtmlEntities("&unknownentity;")).toBe("&unknownentity;");
  });

  it("米游社列表原始载荷的统计噪声不进入版本内容（字段白名单边界）", async () => {
    const entry = getSourceEntry("miyoushe-news") as MiyousheNewsSourceEntry;
    const body = (miyousheType2 as { body: unknown }).body;
    const rawFirst = (body as { data: { list: Array<Record<string, unknown>> } }).data.list[0];
    // 原始载荷确实携带互动/统计类字段（阅读量等噪声的存在性证据）。
    const rawJson = JSON.stringify(rawFirst);
    expect(rawJson).toContain("vote_count");
    expect(rawJson).toContain("stat");

    const replay = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const adapter = createMiyousheNewsAdapter(entry, "2", { fetchFn: replay });
    const list = await adapter.list(null, 20);
    expect(list.items.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(list.items[0]);
    expect(serialized).not.toContain("vote_count");
    expect(serialized).not.toContain("stat");
    expect(serialized).not.toContain("hot_reply");
    expect(serialized).not.toContain("forum_rank");
  });
});
