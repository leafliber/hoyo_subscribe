// 文章完整性状态（任务卡 P3-02，验收 ID A-P3-ARTICLE）。
//
// 合同依据：主方案 §3.2——正文截断、图片承载关键日期或来源暂空进入**缺口/审核状态**；
// **缺口不得转成"无活动"**；没有官方取消证据时，抓取失败、文章删除或列表为空都不能
// 自动取消事件。本枚举刻意不存在任何"无活动/已取消"取值——完整性状态描述的是
// "我们知道什么/不知道什么"，不是"发生了什么活动"；取消语义只能来自官方取消证据（P3-04）。
//
// 通道缺口：gap-channel-unavailable（正文接口受访问控制，"拿不到"≠"已确认为空"）只由已下线的
// 米游社来源产生过（ADR-0016）。现役来源不再产出它，但状态保留在全集里：历史版本仍带着它，
// 公开原文接口也按同一枚举说明缺口。
//
// 图片红线：引用图片只有 URL 没有内容验证，不声称可以发现同 URL 换图；"图片承载关键日期"
// 的可判定形态是**正文不承载任何可读文本而图片引用非空**（P0-02 实测样本：genshin
// ann 21922「六周年福利速览」、21862「至冬」现已开放——纯图片正文，见 fixtures index.json
// 的 image_date_analysis）。正文有文本但日期不全的情况属抽取层（P3-03）的证据校验，
// 本层不做日期猜测、不越权判定。

import { ARTICLE_COMPLETENESS_STATES, type ArticleCompleteness } from "@hoyo/contracts";
import { type ArticleBodyBlock, type ArticleMediaRef, bodyHasVisibleText } from "./blocks";

// 状态全集自 P3-22（ADR-0014）起定义在 @hoyo/contracts：公开原文接口按同一枚举告知正文是否完整。
export { ARTICLE_COMPLETENESS_STATES, type ArticleCompleteness };

/** 全部缺口/审核态（complete 之外的全部）。下游把它们当作"需要动作"，绝不能当作"无活动"。 */
export const COMPLETENESS_GAP_STATES: readonly ArticleCompleteness[] = [
  "gap-body-truncated",
  "gap-content-missing",
  "gap-source-empty",
  "gap-channel-unavailable",
  "review-image-borne",
];

/** 正文可得性（fetchArticle 结果在完整性维度的投影；一般 failed 不产版本）。 */
export type BodyAvailability = "fetched" | "truncated" | "content-missing";

/** 完整性判定原料：P3-01 的信号 + 本卡的内容构造结果。 */
export interface CompletenessInput {
  readonly bodyAvailability: BodyAvailability;
  /** 正文截断信号；完整 JSON 也可能携带此信号，受限读体超限则用 truncated 可得性。 */
  readonly bodyTruncated: boolean;
  /** 正文 HTML 为空串（P3-01 signals.contentEmpty）。 */
  readonly contentEmpty: boolean;
  /** 正文（不含标题）是否承载可读文本（blocks.ts bodyHasVisibleText）。 */
  readonly bodyHasText: boolean;
  /** 媒体引用数（blocks.ts 构造的 mediaRefs 长度——以实际保存的引用为准）。 */
  readonly mediaRefCount: number;
  /** 列表是否声称有正文（stub.hasContent）。null = 列表缺这个字段，无从判断。 */
  readonly listClaimsContent: boolean | null;
}

/**
 * 版本是否真的拿到正文：只认正文可读文本或从正文 HTML 提取的图片。
 * 标题与列表图片不能证明正文可得；历史版本里 review-image-borne 也可能来自正文通道不可用，
 * 因此不能以 completeness 标签判定。新计划与已存版本共用这个谓词。
 */
export function articleBodyWasFetched(
  blocks: readonly ArticleBodyBlock[],
  mediaRefs: readonly ArticleMediaRef[],
): boolean {
  return bodyHasVisibleText(blocks) || mediaRefs.some((ref) => ref.origin === "body");
}

/**
 * 完整性判定（纯函数）。优先级：截断 > 正文不可得 > （空/无文本正文）暂空或图片承载 > 完整。
 *
 * 两处刻意的保守：
 *   - 列表声称有正文（或无从判断）而正文为空 → gap-source-empty（"暂空"：不知道，等下一批）；
 *     只有列表**明确声明无正文**（has_content=false）才视为确认态 complete——官方没给，
 *     不是官方暂空。
 *   - 正文不承载可读文本且无图片 → 与空正文同归 gap-source-empty（声称有正文的空壳同样是暂空）。
 */
export function determineCompleteness(input: CompletenessInput): ArticleCompleteness {
  if (input.bodyAvailability === "truncated") {
    return "gap-body-truncated";
  }
  if (input.bodyAvailability === "content-missing") {
    return "gap-content-missing";
  }
  if (input.bodyTruncated) {
    return "gap-body-truncated";
  }
  // 正文可用：信息可能仅由图片承载 → 送人工核验（图片内容不做自动判读）。
  if (!input.bodyHasText && input.mediaRefCount > 0) {
    return "review-image-borne";
  }
  const bodyCarriesNothing =
    input.contentEmpty || (!input.bodyHasText && input.mediaRefCount === 0);
  if (bodyCarriesNothing) {
    if (input.listClaimsContent === false) {
      return "complete";
    }
    return "gap-source-empty";
  }
  return "complete";
}
