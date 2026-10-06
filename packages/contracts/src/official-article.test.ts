// A-P3-ARTICLE-VIEW · 官方公告原文的共用定义与公开响应形状（ADR-0014，纯函数与 schema）。
import { describe, expect, it } from "vitest";
import {
  ARTICLE_COMPLETENESS_NOTES,
  ARTICLE_COMPLETENESS_STATES,
  unwrapOfficialTimeTags,
  unwrapOfficialTimeTagsAcross,
} from "./official-article";
import { PublicEventArticlesResponseSchema } from "./public-api";

const valid = {
  publication: { generation: 3, publishedAt: 1_790_000_000_000 },
  cache: { generatedAt: 1_790_000_000_000, freshUntil: 1_790_000_300_000, stale: false },
  eventId: "event",
  articles: [
    {
      officialUrl: "https://hk4e-ann-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent",
      versionNo: 2,
      fetchedAt: 1_789_999_000_000,
      publishedAt: null,
      completeness: "complete",
      blocks: [
        { kind: "title", text: "版本更新说明" },
        { kind: "html", html: "<p>正文</p>" },
        { kind: "text", text: "残片" },
      ],
    },
  ],
};

describe("A-P3-ARTICLE-VIEW 官方时间标签", () => {
  it("解码后的 <t> 标签只留时间，多处都替换", () => {
    expect(
      unwrapOfficialTimeTags(
        '补偿对象：<t class="t_gl" contenteditable="false">2026/09/23 06:00</t>前，至<t class="t_lc">2026/10/14 23:59</t>',
      ),
    ).toBe("补偿对象：2026/09/23 06:00前，至2026/10/14 23:59");
  });

  it("没有标签、标签里夹了别的标签或只有半个标签时原样保留", () => {
    for (const text of [
      "活动时间：10月1日 10:00",
      '<t class="t_gl"><b>2026/09/23</b></t>',
      '<t class="t_gl">2026/09/23 06:00',
      "table 与 <td> 不是时间标签",
    ])
      expect(unwrapOfficialTimeTags(text)).toBe(text);
  });

  // 线上原神公告的写法：&lt;t …&gt;<span>时间</span>&lt;/t&gt;，解析后标签分在三个文字节点里。
  it("跨段：时间另包一层元素时，分在不同段的开、合标签成对去掉，段数不变", () => {
    expect(
      unwrapOfficialTimeTagsAcross([
        '7.1版本更新后 ~ <t class="t_lc" contenteditable="false">',
        "2026/11/02 03:59",
        "</t>",
      ]),
    ).toEqual(["7.1版本更新后 ~ ", "2026/11/02 03:59", ""]);
    expect(
      unwrapOfficialTimeTagsAcross([
        '※<t class="t_lc" contenteditable="false">',
        "2026/11/02 02:59",
        '</t>将关闭购买；至<t class="t_gl">2026/11/03 14:59</t>',
      ]),
    ).toEqual(["※", "2026/11/02 02:59", "将关闭购买；至2026/11/03 14:59"]);
  });

  it("跨段：只有一段时与逐段处理一致；不成对、夹了别的标签、含分隔符或开标签本身被拆开时不误删", () => {
    for (const text of [
      '补偿对象：<t class="t_gl" contenteditable="false">2026/09/23 06:00</t>前',
      '<t class="t_gl"><b>2026/09/23</b></t>',
      '<t class="t_gl">2026/09/23 06:00',
    ])
      expect(unwrapOfficialTimeTagsAcross([text])).toEqual([unwrapOfficialTimeTags(text)]);
    for (const segments of [
      [],
      ['<t class="t_gl">', "2026/09/23 06:00"],
      ["2026/09/23 06:00", "</t>"],
      ['<t class="t_gl">', "<b>2026/09/23</b>", "</t>"],
      ["含\u0000分隔符", '<t class="t_gl">', "2026/09/23", "</t>"],
      ['<t class="t_lc"', ' contenteditable="false">', "2026/09/23", "</t>"],
    ])
      expect(unwrapOfficialTimeTagsAcross(segments)).toEqual(segments);
  });
});

describe("A-P3-ARTICLE-VIEW 不完整版本的说明", () => {
  it("除 complete 外每个状态都有说明，且不出现无活动、已取消之类的结论", () => {
    expect(Object.keys(ARTICLE_COMPLETENESS_NOTES).sort()).toEqual(
      ARTICLE_COMPLETENESS_STATES.filter((state) => state !== "complete").sort(),
    );
    for (const note of Object.values(ARTICLE_COMPLETENESS_NOTES))
      expect(note).not.toMatch(/无活动|没有活动|已取消/);
  });
});

describe("A-P3-ARTICLE-VIEW 公开原文响应", () => {
  it("接受三种正文块与完整性全集", () => {
    expect(PublicEventArticlesResponseSchema.parse(valid)).toEqual(valid);
    for (const completeness of ARTICLE_COMPLETENESS_STATES)
      expect(() =>
        PublicEventArticlesResponseSchema.parse({
          ...valid,
          articles: [{ ...valid.articles[0], completeness }],
        }),
      ).not.toThrow();
    expect(PublicEventArticlesResponseSchema.parse({ ...valid, articles: [] }).articles).toEqual(
      [],
    );
  });

  it("拒绝内部字段、未知完整性、未知块类型与非 URL 的官方地址", () => {
    const article = valid.articles[0];
    for (const bad of [
      { ...valid, articles: [{ ...article, id: "version-id" }] },
      { ...valid, articles: [{ ...article, body_blocks_json: "[]" }] },
      { ...valid, articles: [{ ...article, completeness: "no-activity" }] },
      { ...valid, articles: [{ ...article, officialUrl: "not a url" }] },
      { ...valid, articles: [{ ...article, blocks: [{ kind: "image", url: "https://x" }] }] },
      { ...valid, articles: [{ ...article, blocks: [{ kind: "html", html: "<p>", raw: 1 }] }] },
      { ...valid, candidate_id: "c" },
    ])
      expect(() => PublicEventArticlesResponseSchema.parse(bad)).toThrow();
  });
});
