// P3-03 · 规则白名单。只从保存的官方正文块取时间，列表展示时间不参与。
// 目前两种公告模板分别由真实 hsr-ann/1392 与 zzz-ann/1303 样本覆盖；其他材料进人工审核。
// ADR-0030 增加直播兑换码来源的模板（官方结构化字段，不是正文抽取）。
import { CANDIDATE_TEXT_FIELD_BYTES, earliestExplicitDate } from "@hoyo/contracts";
import { readLiveArticle } from "../sources/adapters/miyolive-article";
import { blockVisibleText, decodeHtmlEntities } from "../sources/articles/blocks";
import { isLiveSource } from "../sources/registry";
import { type StoredArticleVersion, validateCandidateAgainstArticle } from "./article";
import { readableBlockText } from "./model/readable";
import { redeemExpiryTime } from "./redeem";
import type { CandidateProposal, EvidenceQuote } from "./schema";
import { parseAnnouncementExactTime } from "./time";

export type RuleOutcome =
  | {
      readonly kind: "ready_for_publication";
      readonly templateId:
        | "hsr-activity-time-tags-v1"
        | "zzz-server-time-range-v1"
        | "miyolive-redeem-codes-v1";
      readonly proposal: CandidateProposal;
    }
  | { readonly kind: "review"; readonly reason: string };

/** 兑换码事件的简介：已发放的兑换码（按发放顺序），不超过候选文本字段上限（CANDIDATE_TEXT_FIELD_BYTES），超出写"等"。 */
const encoder = new TextEncoder();

/**
 * ADR-0030 白名单 3：直播兑换码来源的正文是本站按官方结构化字段逐行写成的（miyolive-article），
 * 时间都是官方字段：开始 = 第一个兑换码的官方发放时刻（to_get_time），结束 = 兑换码说明里写明的有效期
 * （认不出就不建结束节点，不猜）。还没有任何兑换码条目的活动不产出事件。
 */
function miyoliveRedeemCodes(article: StoredArticleVersion): RuleOutcome {
  const live = readLiveArticle(article.blocks);
  if (live === null) return { kind: "review", reason: "直播兑换码正文格式不符" };
  const first = live.codes[0];
  if (first === undefined) return { kind: "review", reason: "直播活动还没有兑换码条目" };
  const start = parseAnnouncementExactTime(first.revealExpression);
  if (start === null) return { kind: "review", reason: "兑换码发放时刻无效" };
  const reference = earliestExplicitDate(article.blocks.map(readableBlockText));
  const expiry = live.tip === null ? null : redeemExpiryTime(live.tip.text, reference);
  const revealed = live.codes.flatMap((code) => (code.code === null ? [] : [code.code]));
  let summary: string | null = null;
  for (let count = revealed.length; count > 0; count--) {
    const candidate = `兑换码：${revealed.slice(0, count).join("、")}${count < revealed.length ? " 等" : ""}`;
    if (encoder.encode(candidate).length <= CANDIDATE_TEXT_FIELD_BYTES) {
      summary = candidate;
      break;
    }
  }
  const proposal: CandidateProposal = {
    classification: "events",
    ambiguities: [],
    events: [
      {
        event_key: "redeem_codes",
        event_type: "redeem_code",
        status: "scheduled",
        title: `${live.title}兑换码`,
        summary,
        type_evidence: { block_ref: `blocks/${first.blockIndex}`, quote: "兑换码", tag: null },
        status_evidence: null,
        change_relation: null,
        milestones: [
          {
            milestone_key: "codes_release",
            node_type: "start",
            title: "兑换码发放",
            time: start,
            time_evidence: {
              block_ref: `blocks/${first.blockIndex}`,
              quote: first.revealExpression,
              tag: null,
            },
          },
          ...(expiry === null || live.tip === null
            ? []
            : [
                {
                  milestone_key: "codes_expiry",
                  node_type: "end" as const,
                  title: "兑换码过期",
                  time: expiry,
                  time_evidence: {
                    block_ref: `blocks/${live.tip.blockIndex}`,
                    quote: expiry.raw_expression,
                    tag: null,
                  },
                },
              ]),
        ],
      },
    ],
  };
  const checked = validateCandidateAgainstArticle(proposal, article);
  if (!checked.success) return { kind: "review", reason: "规则结果未通过候选证据校验" };
  return {
    kind: "ready_for_publication",
    templateId: "miyolive-redeem-codes-v1",
    proposal: checked.data,
  };
}

// P3-24：横线写法也算正文里的日期，额外日期一律转人工；模板本身仍只认已核验的斜线写法。
const DATE_EXPRESSION = /\d{4}([/-])\d{2}\1\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?/g;
const AMBIGUOUS_OR_CHANGE = /取消|终止|停办|撤销|延期|推迟|提前|预计|版本更新后|更新后开放/;

interface MatchedRange {
  readonly templateId: "hsr-activity-time-tags-v1" | "zzz-server-time-range-v1";
  readonly blockIndex: number;
  readonly start: string;
  readonly end: string;
  readonly startQuote: string;
  readonly endQuote: string;
  readonly startTag: EvidenceQuote["tag"];
  readonly endTag: EvidenceQuote["tag"];
}

function timeBlockAfterHeading(
  article: StoredArticleVersion,
  heading: string,
): { index: number; html: string } | null {
  const headingIndex = article.blocks.findIndex(
    (block) => block.kind === "html" && blockVisibleText(block).trim() === heading,
  );
  if (headingIndex < 0) return null;
  const block = article.blocks[headingIndex + 1];
  return block?.kind === "html" ? { index: headingIndex + 1, html: block.html } : null;
}

/** 白名单 1：星铁活动公告的「活动时间」标题 + 单一 t_lc/t_gl 完整时刻区间。 */
function hsrTaggedActivity(article: StoredArticleVersion): MatchedRange | null {
  if (
    article.sourceId !== "hsr-ann" ||
    !/^「[^」]+」活动[:：]/.test(blockVisibleText(article.blocks[0]))
  ) {
    return null;
  }
  const block = timeBlockAfterHeading(article, "活动时间");
  if (block === null) return null;
  const decoded = decodeHtmlEntities(block.html);
  const match =
    /^<p\b[^>]*>\s*<t\s+class="t_lc"[^>]*>([^<]+)<\/t>\s*-\s*<t\s+class="t_gl"[^>]*>([^<]+)<\/t>\s*<\/p>$/.exec(
      decoded,
    );
  if (match === null) return null;
  return {
    templateId: "hsr-activity-time-tags-v1",
    blockIndex: block.index,
    start: match[1],
    end: match[2],
    startQuote: match[1],
    endQuote: match[2],
    startTag: "t_lc",
    endTag: "t_gl",
  };
}

/** 白名单 2：绝区零「活动说明」的独立【活动时间】与双服务器时刻。 */
function zzzServerTimeActivity(article: StoredArticleVersion): MatchedRange | null {
  if (
    article.sourceId !== "zzz-ann" ||
    !/^「[^」]+」活动说明$/.test(blockVisibleText(article.blocks[0]))
  ) {
    return null;
  }
  const block = timeBlockAfterHeading(article, "【活动时间】");
  if (block === null) return null;
  const decoded = decodeHtmlEntities(block.html);
  const match =
    /^<p\b[^>]*>\s*(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2})?)（服务器时间）\s*~\s*(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2})?)（服务器时间）\s*<\/p>$/.exec(
      decoded,
    );
  if (match === null) return null;
  return {
    templateId: "zzz-server-time-range-v1",
    blockIndex: block.index,
    start: match[1],
    end: match[2],
    startQuote: `${match[1]}（服务器时间）`,
    endQuote: `${match[2]}（服务器时间）`,
    startTag: null,
    endTag: null,
  };
}

/** 返回仅供 P3-04 发布的已批准候选；本卡不写 events/milestones。 */
export function extractByRules(article: StoredArticleVersion): RuleOutcome {
  if (article.completeness !== "complete") {
    return { kind: "review", reason: `文章完整性缺口：${article.completeness}` };
  }
  if (article.verificationState !== "verified-working" || article.region !== "CN") {
    return { kind: "review", reason: "来源或区域尚未核验" };
  }
  // ADR-0030：直播兑换码来源只走自己的模板（正文是本站按官方结构化字段写成的，不含图片）。
  if (isLiveSource(article.sourceId)) return miyoliveRedeemCodes(article);
  if (article.mediaRefs.length > 0) {
    return { kind: "review", reason: "媒体可能承载其他日期或阶段" };
  }
  const body = article.blocks
    .slice(1)
    .map((block) => (block.kind === "html" ? decodeHtmlEntities(block.html) : block.text))
    .join("\n");
  if (AMBIGUOUS_OR_CHANGE.test(body)) {
    return { kind: "review", reason: "正文含更正或非确定性时间表达" };
  }
  const matched = hsrTaggedActivity(article) ?? zzzServerTimeActivity(article);
  if (matched === null) return { kind: "review", reason: "未命中已核验规则模板" };
  if ([...body.matchAll(DATE_EXPRESSION)].length !== 2) {
    return { kind: "review", reason: "正文含额外日期，需核对多阶段" };
  }
  const start = parseAnnouncementExactTime(matched.start);
  const end = parseAnnouncementExactTime(matched.end);
  if (start === null || end === null || end.utc_ms <= start.utc_ms) {
    return { kind: "review", reason: "时间无效、缺年或跨年/先后关系无法唯一确定" };
  }
  const title = blockVisibleText(article.blocks[0]);
  const evidence = (quote: string, tag: EvidenceQuote["tag"]): EvidenceQuote => ({
    block_ref: `blocks/${matched.blockIndex}`,
    quote,
    tag,
  });
  const proposal: CandidateProposal = {
    classification: "events",
    ambiguities: [],
    events: [
      {
        event_key: "primary",
        event_type: "limited_event",
        status: "scheduled",
        title,
        summary: null,
        type_evidence: { block_ref: "blocks/0", quote: title, tag: null },
        status_evidence: null,
        change_relation: null,
        milestones: [
          {
            milestone_key: "start",
            node_type: "start",
            title: `${title}开始`,
            time: start,
            time_evidence: evidence(matched.startQuote, matched.startTag),
          },
          {
            milestone_key: "end",
            node_type: "end",
            title: `${title}结束`,
            time: end,
            time_evidence: evidence(matched.endQuote, matched.endTag),
          },
        ],
      },
    ],
  };
  const checked = validateCandidateAgainstArticle(proposal, article);
  if (!checked.success) return { kind: "review", reason: "规则结果未通过候选证据校验" };
  return { kind: "ready_for_publication", templateId: matched.templateId, proposal: checked.data };
}
