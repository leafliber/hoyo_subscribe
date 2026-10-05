// 官方公告正文的共用定义（P3-02 起源；P3-22 / ADR-0014 移入本包，供公开原文接口与网页共用）。
//
// - 完整性状态描述"我们知道什么/不知道什么"，不是"发生了什么活动"：刻意不存在"无活动/已取消"取值；
//   缺口（gap-*）是"不知道"，绝不是"没有"。判定逻辑仍在 Worker（sources/articles/completeness.ts）。
// - 官方正文把时间包成转义的 `&lt;t class="t_gl"&gt;…&lt;/t&gt;`；解码成文本后只保留其中的时间。
//   审核页可读文本与公开原文弹窗共用这一条，不各写一份（弹窗按文字节点处理，用跨段版本）。
import { z } from "zod";

/**
 * 完整性状态全集。前缀约定：
 *   - complete：官方所给材料完整取得；
 *   - gap-*：缺口——"不知道"，等待下一批或人工，**绝不是"没有"**；
 *   - review-image-borne：信息可能仅由图片承载——送人工核验（首版不做视觉转录）。
 */
export const ARTICLE_COMPLETENESS_STATES = [
  "complete",
  "gap-body-truncated",
  "gap-content-missing",
  "gap-source-empty",
  "gap-channel-unavailable",
  "review-image-borne",
] as const;

export type ArticleCompleteness = (typeof ARTICLE_COMPLETENESS_STATES)[number];

export const ArticleCompletenessSchema = z.enum(ARTICLE_COMPLETENESS_STATES);

/** 公开原文弹窗对不完整版本的说明（ADR-0014）：如实说缺了什么，不暗示"没有活动"。 */
export const ARTICLE_COMPLETENESS_NOTES: Record<
  Exclude<ArticleCompleteness, "complete">,
  string
> = {
  "gap-body-truncated": "官方正文超出了本站的读取上限，这一版只保存了标题。",
  "gap-content-missing": "官方列表里有这篇公告，但正文里缺了这一条，这一版只保存了标题。",
  "gap-source-empty": "本站采集时，官方这篇公告的正文是空的。",
  "gap-channel-unavailable": "这个来源只提供公告列表，拿不到正文，这里只有标题。",
  "review-image-borne": "这篇公告的内容主要在图片里，文字可能不全，请点开图片查看。",
};

/** 解码后的文本里，官方 `<t …>时间</t>` 标签只留时间（标签内不含其他标签）。 */
const OFFICIAL_TIME_TAG = /<t\b[^>]*>([^<]*)<\/t>/g;

export function unwrapOfficialTimeTags(text: string): string {
  return text.replace(OFFICIAL_TIME_TAG, "$1");
}

/** 拼接各段的分隔符：HTML 解析出的文字不含 U+0000（解析器会丢弃或替换它）。 */
const SEGMENT_SEPARATOR = "\u0000";

/**
 * 同一条规则用于按文档顺序排列的多段文字（网页原文弹窗里一个正文块的各文字节点）。
 * 官方有时把时间本身再包一层元素：`&lt;t …&gt;<span>2026/11/02 03:59</span>&lt;/t&gt;`，
 * 解析后开、合标签落在不同的文字节点里，逐段处理匹配不上。这里跨段成对去掉标签，段数不变；
 * 判定与 unwrapOfficialTimeTags 相同（标签之间只有文字才去掉），不成对的标签原样保留。
 */
export function unwrapOfficialTimeTagsAcross(segments: readonly string[]): string[] {
  if (!segments.some((segment) => segment.includes(SEGMENT_SEPARATOR))) {
    const joined = unwrapOfficialTimeTags(segments.join(SEGMENT_SEPARATOR)).split(
      SEGMENT_SEPARATOR,
    );
    // 开标签本身被拆到两段时，替换会吞掉分隔符；段数对不上就退回逐段处理，绝不错位。
    if (joined.length === segments.length) return joined;
  }
  return segments.map(unwrapOfficialTimeTags);
}
