// P3-03 · 规则白名单。只从保存的官方正文块取时间，列表展示时间不参与。
// 目前两种模板分别由真实 hsr-ann/1392 与 zzz-ann/1303 样本覆盖；其他材料进人工审核。
import { blockVisibleText, decodeHtmlEntities } from "../sources/articles/blocks";
import { type StoredArticleVersion, validateCandidateAgainstArticle } from "./article";
import type { CandidateProposal, EvidenceQuote } from "./schema";
import { parseAnnouncementExactTime } from "./time";

export type RuleOutcome =
  | {
      readonly kind: "ready_for_publication";
      readonly templateId: "hsr-activity-time-tags-v1" | "zzz-server-time-range-v1";
      readonly proposal: CandidateProposal;
    }
  | { readonly kind: "review"; readonly reason: string };

const DATE_EXPRESSION = /\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?/g;
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
