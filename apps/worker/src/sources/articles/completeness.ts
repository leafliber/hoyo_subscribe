// 文章完整性状态（任务卡 P3-02，验收 ID A-P3-ARTICLE）。
//
// 合同依据：主方案 §3.2——正文截断、图片承载关键日期或来源暂空进入**缺口/审核状态**；
// **缺口不得转成"无活动"**；没有官方取消证据时，抓取失败、文章删除或列表为空都不能
// 自动取消事件。本枚举刻意不存在任何"无活动/已取消"取值——完整性状态描述的是
// "我们知道什么/不知道什么"，不是"发生了什么活动"；取消语义只能来自官方取消证据（P3-04）。
//
// 米游社红线：正文通道被 403 访问控制停用（maintenance-required-list-only）——
// 这是"拿不到"，不是"已确认为空"。gap-channel-unavailable 与 gap-source-empty 必须分开，
// 下游 P3-03 据此决定送人工审核还是跳过；把通道不可用记成正文为空是不诚实归类。
//
// 图片红线：引用图片只有 URL 没有内容验证，不声称可以发现同 URL 换图；"图片承载关键日期"
// 的可判定形态是**正文不承载任何可读文本而图片引用非空**（P0-02 实测样本：genshin
// ann 21922「六周年福利速览」、21862「至冬」现已开放——纯图片正文，见 fixtures index.json
// 的 image_date_analysis）。正文有文本但日期不全的情况属抽取层（P3-03）的证据校验，
// 本层不做日期猜测、不越权判定。

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

/** 全部缺口/审核态（complete 之外的全部）。下游把它们当作"需要动作"，绝不能当作"无活动"。 */
export const COMPLETENESS_GAP_STATES: readonly ArticleCompleteness[] = [
  "gap-body-truncated",
  "gap-content-missing",
  "gap-source-empty",
  "gap-channel-unavailable",
  "review-image-borne",
];

/** 正文可得性（fetchArticle 结果在完整性维度的投影；failed 不产版本，不进入判定）。 */
export type BodyAvailability = "fetched" | "content-missing" | "channel-unavailable";

/** 完整性判定原料：P3-01 的信号 + 本卡的内容构造结果。 */
export interface CompletenessInput {
  readonly bodyAvailability: BodyAvailability;
  /** 响应体读取被上限截断（P3-01 signals.bodyTruncated；当前管线把截断整个请求作废，此值留作直达信号）。 */
  readonly bodyTruncated: boolean;
  /** 正文 HTML 为空串（P3-01 signals.contentEmpty）。 */
  readonly contentEmpty: boolean;
  /** 正文（不含标题）是否承载可读文本（blocks.ts bodyHasVisibleText）。 */
  readonly bodyHasText: boolean;
  /** 媒体引用数（blocks.ts 构造的 mediaRefs 长度——以实际保存的引用为准）。 */
  readonly mediaRefCount: number;
  /** 列表是否声称有正文（stub.hasContent）。null = 来源不携带该概念（米游社维护态）。 */
  readonly listClaimsContent: boolean | null;
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
  if (input.bodyAvailability === "content-missing") {
    return "gap-content-missing";
  }
  if (input.bodyAvailability === "channel-unavailable") {
    // 通道不可用：拿不到 ≠ 空。图片级信息存在时进审核（人工核验图片），否则记通道缺口。
    return input.mediaRefCount > 0 ? "review-image-borne" : "gap-channel-unavailable";
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
