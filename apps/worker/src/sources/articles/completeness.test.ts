// A-P3-ARTICLE · 完整性状态判定（任务卡 P3-02）。
// 三条红线在判定层的落点：缺口≠「无活动」；通道不可用≠正文为空；图片承载关键日期送人工。
// 真实样本：genshin 21928（有文本）、21922/21862（纯图片正文，P0-02 image_date_analysis
// 判 date_likely_in_image）；构造变体显式标注非官方样本。

import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21819.json";
import { bodyHasVisibleText, splitBodyBlocks } from "./blocks";
import {
  ARTICLE_COMPLETENESS_STATES,
  COMPLETENESS_GAP_STATES,
  type CompletenessInput,
  determineCompleteness,
} from "./completeness";

interface ContentEntry {
  ann_id: number;
  title: string;
  content: string;
}

const entries = (genshinContent as { body: { data: { list: ContentEntry[] } } }).body.data.list;

function findEntry(annId: number): ContentEntry {
  const entry = entries.find((candidate) => candidate.ann_id === annId);
  if (entry === undefined) throw new Error(`fixtures 中找不到 ann_id=${annId}`);
  return entry;
}

/** fetched 判定原料：与 ingest 同一谓词派生（bodyHasVisibleText），构造变体显式传入覆盖。 */
function fetchedInput(
  contentHtml: string,
  overrides: Partial<CompletenessInput> = {},
): CompletenessInput {
  return {
    bodyAvailability: "fetched",
    bodyTruncated: false,
    contentEmpty: contentHtml.length === 0,
    bodyHasText: bodyHasVisibleText(splitBodyBlocks(contentHtml)),
    mediaRefCount: (contentHtml.match(/<img\b/gi) ?? []).length,
    listClaimsContent: true,
    ...overrides,
  };
}

describe("A-P3-ARTICLE 完整性判定：真实样本", () => {
  it("有文本正文 → complete（genshin 21928 维护预告）", () => {
    expect(determineCompleteness(fetchedInput(findEntry(21928).content))).toBe("complete");
  });

  it("纯图片正文 → review-image-borne（genshin 21922 六周年福利速览、21862「至冬」：P0-02 判 date_likely_in_image）", () => {
    expect(determineCompleteness(fetchedInput(findEntry(21922).content))).toBe(
      "review-image-borne",
    );
    expect(determineCompleteness(fetchedInput(findEntry(21862).content))).toBe(
      "review-image-borne",
    );
  });
});

describe("A-P3-ARTICLE 完整性判定：三种缺口各自成态（构造变体，非官方样本）", () => {
  it("正文截断 → gap-body-truncated", () => {
    expect(
      determineCompleteness(fetchedInput(findEntry(21928).content, { bodyTruncated: true })),
    ).toBe("gap-body-truncated");
  });

  it("来源暂空：列表声称有正文而正文为空 → gap-source-empty", () => {
    expect(determineCompleteness(fetchedInput("", { listClaimsContent: true }))).toBe(
      "gap-source-empty",
    );
    // hasContent 无从判断（null，米游社之外的未来来源形态）同样保守记暂空。
    expect(determineCompleteness(fetchedInput("", { listClaimsContent: null }))).toBe(
      "gap-source-empty",
    );
  });

  it("列表明确声明无正文（has_content=false）：空是官方确认态 → complete（不是暂空缺口）", () => {
    expect(determineCompleteness(fetchedInput("", { listClaimsContent: false }))).toBe("complete");
  });

  it("有正文的形状但无可读文本且无图（空壳正文）→ gap-source-empty", () => {
    const shell = '<p style="white-space: pre-wrap; min-height: 1.5em;"></p>';
    expect(determineCompleteness(fetchedInput(shell))).toBe("gap-source-empty");
  });

  it("列表声称有正文但全量正文集合缺该条 → gap-content-missing", () => {
    expect(
      determineCompleteness({
        bodyAvailability: "content-missing",
        bodyTruncated: false,
        contentEmpty: true,
        bodyHasText: false,
        mediaRefCount: 0,
        listClaimsContent: true,
      }),
    ).toBe("gap-content-missing");
  });
});

describe("A-P3-ARTICLE 米游社：通道不可用 ≠ 正文为空（红线）", () => {
  const unavailable = (mediaRefCount: number): CompletenessInput => ({
    bodyAvailability: "channel-unavailable",
    bodyTruncated: false,
    contentEmpty: false,
    bodyHasText: false,
    mediaRefCount,
    listClaimsContent: null,
  });

  it("通道不可用且有图片级信息 → review-image-borne（人工核验图片日期）", () => {
    expect(determineCompleteness(unavailable(3))).toBe("review-image-borne");
  });

  it("通道不可用且无图片 → gap-channel-unavailable（拿不到，不是空）", () => {
    expect(determineCompleteness(unavailable(0))).toBe("gap-channel-unavailable");
  });

  it("通道不可用的任何形态都不落 gap-source-empty（不可用不得记成正文为空）", () => {
    for (const mediaRefCount of [0, 1, 5]) {
      const state = determineCompleteness(unavailable(mediaRefCount));
      expect(state).not.toBe("gap-source-empty");
      expect(state).not.toBe("complete");
    }
  });
});

describe("A-P3-ARTICLE ★ 缺口不得转成「无活动」", () => {
  it("完整性枚举不存在任何「无活动/已取消」类取值；缺口域全部落在 gap-*/review-* 前缀", () => {
    expect(ARTICLE_COMPLETENESS_STATES).not.toContain("no-activity");
    expect(ARTICLE_COMPLETENESS_STATES).not.toContain("cancelled");
    expect(ARTICLE_COMPLETENESS_STATES).not.toContain("empty");
    for (const state of ARTICLE_COMPLETENESS_STATES) {
      if (state === "complete") continue;
      expect(/^(gap-|review-)/.test(state)).toBe(true);
    }
  });

  it("全部缺口态注册在 COMPLETENESS_GAP_STATES：判定输出不可能表达「没有活动」", () => {
    expect(COMPLETENESS_GAP_STATES).toHaveLength(ARTICLE_COMPLETENESS_STATES.length - 1);
    for (const state of COMPLETENESS_GAP_STATES) {
      expect(ARTICLE_COMPLETENESS_STATES).toContain(state);
    }
  });

  it("判定矩阵：输出永远在枚举内，且截断优先于一切（截断时其余信号不参与归类）", () => {
    const states = new Set(ARTICLE_COMPLETENESS_STATES as readonly string[]);
    const availabilities = ["fetched", "content-missing", "channel-unavailable"] as const;
    for (const bodyAvailability of availabilities) {
      for (const bodyTruncated of [false, true]) {
        for (const contentEmpty of [false, true]) {
          for (const bodyHasText of [false, true]) {
            for (const mediaRefCount of [0, 2]) {
              for (const listClaimsContent of [true, false, null] as const) {
                const state = determineCompleteness({
                  bodyAvailability,
                  bodyTruncated,
                  contentEmpty,
                  bodyHasText,
                  mediaRefCount,
                  listClaimsContent,
                });
                expect(states.has(state)).toBe(true);
                if (bodyAvailability === "fetched" && bodyTruncated) {
                  expect(state).toBe("gap-body-truncated");
                }
              }
            }
          }
        }
      }
    }
  });
});
