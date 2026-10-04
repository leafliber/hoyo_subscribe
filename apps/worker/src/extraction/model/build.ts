// P3-17（ADR-0009）· 把模型的中间输出确定性地变成候选形状，最后过统一候选校验。
// 模型输出一律按不可信数据处理：时间只认所引块里逐字存在的文本，键与 TimeValue 由服务端生成，
// 不带跨公告关系（change_relation）也不产出本站撤回（retracted）。本模块不调用模型、不写库。
import {
  browseTimestamp,
  CANDIDATE_TEXT_FIELD_BYTES,
  DateOnlySchema,
  EVENT_TYPES,
  type EventType,
  NODE_NAMES,
  NODE_TYPES,
  type NodeType,
  type TimeValue,
} from "@hoyo/contracts";
import { type ArticleBodyBlock, decodeHtmlEntities } from "../../sources/articles/blocks";
import { type StoredArticleVersion, validateCandidateAgainstArticle } from "../article";
import type { CandidateProposal, EventProposal, EvidenceQuote, MilestoneProposal } from "../schema";
import { ANNOUNCEMENT_TIMEZONE, parseAnnouncementExactTime } from "../time";
import { versionMentions } from "../versions";

export interface DraftBuildResult {
  readonly status: "ready" | "invalid";
  readonly proposal: CandidateProposal;
  /** 给审核员看的说明：版本时间摘录、丢弃项、按原文更正的块号、需要留意的时间关系。 */
  readonly notes: readonly string[];
  /** ADR-0010：版本公告里逐字核对通过的版本时间；不是候选内容，不进入发布。 */
  readonly versionWindow: DraftVersionWindow | null;
}

export interface DraftVersionMoment {
  readonly blockRef: string;
  readonly quote: string;
  readonly utcMs: number;
}

export interface DraftVersionWindow {
  readonly version: string;
  readonly updateStart: DraftVersionMoment | null;
  readonly updateDuration: { readonly blockRef: string; readonly quote: string } | null;
  readonly versionEnd: DraftVersionMoment | null;
}

const MODEL_STATUSES = ["scheduled", "postponed", "cancelled"] as const;
type ModelStatus = (typeof MODEL_STATUSES)[number];
const DATE_TIME = /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(?::\d{2})?/g;
const DATE_ONLY = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const TIME_TAG = /<t\b[^>]*\bclass=["'](t_gl|t_lc)["'][^>]*>([^<]*)<\/t>/g;

/** 从模型文本取唯一 JSON 对象：去掉思考块与代码围栏；无法解析返回 null。 */
export function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(cleaned);
  const body = fenced === null ? cleaned : fenced[1];
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function blockIndex(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
}

const fits = (value: string) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= CANDIDATE_TEXT_FIELD_BYTES;

/** 按候选文本字段预算截断（公共节点 1/32），末尾加省略号。 */
export function clampText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (fits(compact)) return compact;
  const chars = [...compact];
  while (chars.length > 1 && !fits(`${chars.join("")}…`)) chars.pop();
  return `${chars.join("")}…`;
}

/** 0→a、25→z、26→aa：确定性的纯字母后缀，满足候选键的无日期语义键格式。 */
function letters(index: number): string {
  let out = "";
  let rest = index;
  do {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return out;
}
const eventKey = (index: number) => (index === 0 ? "primary" : `event_${letters(index)}`);
const milestoneKey = (nodeType: NodeType, nth: number) =>
  nth === 0 ? nodeType : `${nodeType}_${letters(nth)}`;

function rawOf(block: ArticleBodyBlock): string {
  return block.kind === "html" ? block.html : block.text;
}
/** 原始块里文本可能以实体转义出现；只尝试这两种逐字形态，不做模糊匹配。 */
function forms(value: string): string[] {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/ /g, "&nbsp;");
  return escaped === value ? [value] : [value, escaped];
}

interface Located {
  readonly index: number;
  readonly quote: string;
  readonly corrected: boolean;
}
/** 先在模型给的块里逐字找；找不到而全文恰好只有一个块含这段文本时，按原文更正块号。 */
function locate(article: StoredArticleVersion, index: number, value: string): Located | null {
  if (value.length === 0) return null;
  const inBlock = (i: number): string | null => {
    const raw = rawOf(article.blocks[i]);
    return forms(value).find((form) => raw.includes(form)) ?? null;
  };
  if (index >= 0 && index < article.blocks.length) {
    const quote = inBlock(index);
    if (quote !== null) return { index, quote, corrected: false };
  }
  const hits: Located[] = [];
  for (let i = 0; i < article.blocks.length; i++) {
    const quote = inBlock(i);
    if (quote !== null) hits.push({ index: i, quote, corrected: true });
  }
  return hits.length === 1 ? hits[0] : null;
}

/** 引文恰好落在一个转义时间标签里时记下标签；否则为原文片段（null）。 */
function timeTag(block: ArticleBodyBlock, quote: string): EvidenceQuote["tag"] {
  if (block.kind !== "html") return null;
  for (const match of decodeHtmlEntities(block.html).matchAll(TIME_TAG))
    if (match[2]?.includes(quote)) return match[1] as "t_gl" | "t_lc";
  return null;
}

/** 完整时刻走官方 UTC+8 解析；纯日期不补午夜；其余保留原文、精度未知。"预计"一律只作估计。 */
function timeValue(quote: string, estimated: boolean): TimeValue | "range" {
  const basis = estimated ? "official_estimate" : "official_explicit";
  const exact = [...quote.matchAll(DATE_TIME)].map((match) => match[0]);
  if (exact.length > 1) return "range";
  if (exact.length === 1) {
    const parsed = parseAnnouncementExactTime(exact[0]);
    if (parsed !== null) return { ...parsed, time_basis: basis };
  }
  const date = DATE_ONLY.exec(quote.trim());
  if (date !== null) {
    const iso = DateOnlySchema.safeParse(`${date[1]}-${date[2]}-${date[3]}`);
    if (iso.success)
      return {
        precision: "date",
        date: iso.data,
        source_timezone: ANNOUNCEMENT_TIMEZONE,
        raw_expression: quote.trim(),
        time_basis: basis,
      };
  }
  return {
    precision: "unknown",
    source_timezone: ANNOUNCEMENT_TIMEZONE,
    raw_expression: quote,
    time_basis: estimated ? "official_estimate" : "unresolved",
  };
}

function quoteOf(
  article: StoredArticleVersion,
  value: unknown,
): { evidence: EvidenceQuote; corrected: boolean } | null {
  const raw = record(value);
  if (raw === null) return null;
  const found = locate(article, blockIndex(raw.block), text(raw.quote));
  if (found === null || !fits(found.quote)) return null;
  return {
    evidence: { block_ref: `blocks/${found.index}`, quote: found.quote, tag: null },
    corrected: found.corrected,
  };
}

/** 标题块是服务端从官方标题去噪得到的，总能作为类型证据的兜底。 */
function titleEvidence(article: StoredArticleVersion): EvidenceQuote | null {
  const first = article.blocks[0];
  return first?.kind === "title" && first.text.length > 0 && fits(first.text)
    ? { block_ref: "blocks/0", quote: first.text, tag: null }
    : null;
}

function buildMilestones(
  article: StoredArticleVersion,
  eventTitle: string,
  raw: unknown[],
  notes: string[],
  label: string,
): MilestoneProposal[] {
  const used = new Map<NodeType, number>();
  const out: MilestoneProposal[] = [];
  for (const item of raw) {
    const node = record(item);
    if (node === null) continue;
    const nodeType = text(node.node_type) as NodeType;
    const timeText = text(node.time_text);
    if (!NODE_TYPES.includes(nodeType)) {
      notes.push(`${label}：丢弃节点类型无效的时间「${timeText}」。`);
      continue;
    }
    const found = locate(article, blockIndex(node.block), timeText);
    if (found === null) {
      notes.push(`${label}：原文中找不到「${timeText}」，已丢弃这个${NODE_NAMES[nodeType]}节点。`);
      continue;
    }
    if (found.corrected)
      notes.push(`${label}：「${timeText}」实际在 blocks/${found.index}，已按原文更正块号。`);
    const time = timeValue(found.quote, node.estimated === true);
    if (time === "range") {
      notes.push(`${label}：「${timeText}」含多个时刻，不是单一时间点，已丢弃。`);
      continue;
    }
    if (!fits(time.raw_expression) || !fits(found.quote)) {
      notes.push(`${label}：时间文本过长，已丢弃这个${NODE_NAMES[nodeType]}节点。`);
      continue;
    }
    const nth = used.get(nodeType) ?? 0;
    used.set(nodeType, nth + 1);
    const nodeLabel = text(node.label);
    out.push({
      milestone_key: milestoneKey(nodeType, nth),
      node_type: nodeType,
      title: clampText(
        nodeLabel.length > 0
          ? `${eventTitle}·${nodeLabel}`
          : `${eventTitle}${NODE_NAMES[nodeType]}`,
      ),
      time,
      time_evidence: {
        block_ref: `blocks/${found.index}`,
        quote: found.quote,
        tag: timeTag(article.blocks[found.index], found.quote),
      },
    });
  }
  return out;
}

/** 只提示、不改写：同一事件里重复的时刻与先后颠倒交给审核员判断。 */
function timingNotes(event: EventProposal, label: string, notes: string[]): void {
  const exact = event.milestones.filter((m) => m.time.precision === "datetime");
  const seen = new Map<number, string>();
  for (const milestone of exact) {
    if (milestone.time.precision !== "datetime") continue;
    const earlier = seen.get(milestone.time.utc_ms);
    if (earlier !== undefined)
      notes.push(
        `${label}：${NODE_NAMES[milestone.node_type]}与${earlier}是同一时刻，请核对是否把同一时间用作了不同节点。`,
      );
    else seen.set(milestone.time.utc_ms, NODE_NAMES[milestone.node_type]);
  }
  const start = exact.find((m) => m.node_type === "start");
  const end = exact.find((m) => m.node_type === "end");
  if (
    start?.time.precision === "datetime" &&
    end?.time.precision === "datetime" &&
    end.time.utc_ms <= start.time.utc_ms
  )
    notes.push(`${label}：结束时间不晚于开始时间，请核对。`);
}

/** 版本时间只认逐字存在、且恰好含一个完整时刻的原文。 */
function versionMoment(
  article: StoredArticleVersion,
  value: unknown,
  notes: string[],
): DraftVersionMoment | null {
  const raw = record(value);
  if (raw === null) return null;
  const timeText = text(raw.time_text);
  const found = locate(article, blockIndex(raw.block), timeText);
  const exact = found === null ? [] : [...found.quote.matchAll(DATE_TIME)].map((m) => m[0]);
  const parsed = exact.length === 1 ? parseAnnouncementExactTime(exact[0]) : null;
  if (found === null || parsed === null) {
    notes.push(`版本时间摘录：「${timeText}」在原文中核对不到完整时刻，已忽略。`);
    return null;
  }
  return { blockRef: `blocks/${found.index}`, quote: found.quote, utcMs: parsed.utc_ms };
}

/** 标题写了版本号时必须与之一致；标题没写时，正文里须出现"X.Y版本"。防止把别的版本号安到这篇公告上。 */
function versionMentioned(article: StoredArticleVersion, version: string): boolean {
  const { title, body } = versionMentions(article);
  return title.length > 0 ? title.includes(version) : body.includes(version);
}

function versionWindowOf(
  article: StoredArticleVersion,
  value: unknown,
  notes: string[],
): DraftVersionWindow | null {
  const raw = record(value);
  if (raw === null) return null;
  const version = text(raw.version);
  if (!/^\d+\.\d+$/.test(version)) {
    notes.push(`版本时间摘录：版本号「${version}」无效，已忽略。`);
    return null;
  }
  if (!versionMentioned(article, version)) {
    notes.push(`版本时间摘录：版本号「${version}」与公告标题或正文对不上，已忽略。`);
    return null;
  }
  const updateStart = versionMoment(article, raw.update_start, notes);
  const versionEnd =
    raw.version_end === null ? null : versionMoment(article, raw.version_end, notes);
  const durationText = text(raw.update_duration_text);
  const duration = durationText.length === 0 ? null : locate(article, -1, durationText);
  if (durationText.length > 0 && duration === null)
    notes.push(`版本时间摘录：「${durationText}」在原文中核对不到，已忽略。`);
  const when = (moment: DraftVersionMoment | null) =>
    moment === null ? "正文未写" : `${browseTimestamp(moment.utcMs)}（北京时间）`;
  notes.unshift(
    `版本时间（逐字核对）：${version} 版本更新开始 ${when(updateStart)}${duration === null ? "" : `，${duration.quote}`}；版本结束 ${when(versionEnd)}。`,
  );
  return {
    version,
    updateStart,
    updateDuration:
      duration === null ? null : { blockRef: `blocks/${duration.index}`, quote: duration.quote },
    versionEnd,
  };
}

/** 确定性构建：模型给什么都不会让未核对的时间或跨公告关系进入草稿。 */
export function buildDraftProposal(
  article: StoredArticleVersion,
  output: unknown,
): DraftBuildResult {
  const notes: string[] = [];
  const root = record(output) ?? {};
  const classification = text(root.classification);
  const versionNotes: string[] = [];
  const versionWindow = versionWindowOf(article, root.version_window, versionNotes);
  const ambiguities = list(root.ambiguities)
    .map((item) => clampText(text(item)))
    .filter((item) => item.length > 0);
  const events: EventProposal[] = [];
  for (const [index, item] of list(root.events).entries()) {
    const raw = record(item);
    if (raw === null) continue;
    const label = `事件 ${index + 1}`;
    const eventType = text(raw.event_type) as EventType;
    if (!EVENT_TYPES.includes(eventType)) {
      notes.push(`${label}：事件类型「${text(raw.event_type)}」不在四类日程内，已丢弃整个事件。`);
      continue;
    }
    const titleBlock = titleEvidence(article);
    const title = clampText(text(raw.title) || titleBlock?.quote || "未命名事件");
    const milestones = buildMilestones(article, title, list(raw.milestones), notes, label);
    if (milestones.length === 0) {
      notes.push(`${label}「${title}」没有能在原文中核对到的时间，已丢弃。`);
      continue;
    }
    const typeQuote = quoteOf(article, raw.type_quote);
    const typeEvidence = typeQuote?.evidence ??
      titleBlock ?? { ...milestones[0].time_evidence, tag: null };
    let status: ModelStatus = MODEL_STATUSES.includes(text(raw.status) as ModelStatus)
      ? (text(raw.status) as ModelStatus)
      : "scheduled";
    let statusEvidence: EvidenceQuote | null = null;
    if (status !== "scheduled") {
      statusEvidence = quoteOf(article, raw.status_quote)?.evidence ?? null;
      if (statusEvidence === null) {
        ambiguities.push(
          clampText(
            `模型认为「${title}」${status === "cancelled" ? "已取消" : "已延期"}，但原文核对不到对应原句，请人工核对。`,
          ),
        );
        status = "scheduled";
      }
    }
    const event: EventProposal = {
      event_key: eventKey(events.length),
      event_type: eventType,
      status,
      title,
      summary: null,
      type_evidence: typeEvidence,
      status_evidence: statusEvidence,
      change_relation: null,
      milestones,
    };
    timingNotes(event, label, notes);
    events.push(event);
  }
  let finalClassification: CandidateProposal["classification"];
  let finalAmbiguities = ambiguities;
  if (classification === "no_event" && events.length === 0) {
    finalClassification = "no_event";
    if (ambiguities.length > 0) notes.push(`模型同时给出的说明：${ambiguities.join("；")}`);
    finalAmbiguities = [];
  } else if (classification === "no_event") {
    finalClassification = "uncertain";
    finalAmbiguities = [...ambiguities, "模型判断为无日程，但同时给出了事件，请人工核对。"];
  } else if (classification === "events" && events.length === 0) {
    finalClassification = "uncertain";
    finalAmbiguities = [...ambiguities, "模型给出的时间都无法在原文中核对到。"];
  } else if (classification === "events" && ambiguities.length === 0) {
    finalClassification = "events";
  } else {
    finalClassification = "uncertain";
    if (classification !== "events" && classification !== "uncertain")
      finalAmbiguities = [...finalAmbiguities, "模型输出的分类无效。"];
    if (finalAmbiguities.length === 0) finalAmbiguities = ["模型未说明不确定的原因。"];
  }
  const proposal: CandidateProposal = {
    classification: finalClassification,
    events,
    ambiguities: finalAmbiguities,
  };
  const checked = validateCandidateAgainstArticle(proposal, article);
  if (checked.success)
    return {
      status: "ready",
      proposal: checked.data,
      notes: [...versionNotes, ...notes],
      versionWindow,
    };
  return {
    status: "invalid",
    proposal,
    versionWindow,
    notes: [
      ...versionNotes,
      ...notes,
      ...checked.issues.map((issue) => `校验未通过：${issue.path} ${issue.message}`),
    ],
  };
}
