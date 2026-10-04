// P3-03 · 候选输入的唯一形状校验器（人工录入与未来模型输出共用）。
// 业务枚举与 TimeValue 直接消费 @hoyo/contracts；来源身份不属于输入形状。
import {
  API_BODY_MAX_BYTES,
  CANDIDATE_MAX_BYTES,
  type EventStatus,
  EventStatusSchema,
  type EventType,
  EventTypeSchema,
  type NodeType,
  NodeTypeSchema,
  type TimeValue,
  TimeValueSchema,
} from "@hoyo/contracts";

export interface EvidenceQuote {
  readonly block_ref: string;
  readonly quote: string;
  /** null = 原文片段；t_gl/t_lc = 原始 HTML 中的转义时间标签。 */
  readonly tag: "t_gl" | "t_lc" | null;
}

export interface MilestoneProposal {
  /** 稳定语义键，不含日期；改期时保持原键。 */
  readonly milestone_key: string;
  readonly node_type: NodeType;
  readonly title: string;
  readonly time: TimeValue;
  readonly time_evidence: EvidenceQuote;
}

export interface EventProposal {
  /** 同一文章内的稳定语义键，不含日期。 */
  readonly event_key: string;
  readonly event_type: EventType;
  readonly status: EventStatus;
  readonly title: string;
  readonly summary: string | null;
  readonly type_evidence: EvidenceQuote;
  readonly status_evidence: EvidenceQuote | null;
  /** 指向已有 Event 的更正关系；新事件为 null。 */
  readonly change_relation: {
    readonly target_event_id: string;
    readonly reason: string;
  } | null;
  readonly milestones: readonly MilestoneProposal[];
}

/** no_event 只允许完整版本得出；uncertain 表示缺口/歧义，不能被当成无事件。 */
export interface CandidateProposal {
  readonly classification: "events" | "no_event" | "uncertain";
  readonly events: readonly EventProposal[];
  readonly ambiguities: readonly string[];
}

export interface CandidateIssue {
  readonly path: string;
  readonly message: string;
}

export type CandidateParseResult =
  | { readonly success: true; readonly data: CandidateProposal }
  | { readonly success: false; readonly issues: readonly CandidateIssue[] };

const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/;
const DATE_IN_KEY = /\d{4}|\d{1,2}[_-]\d{1,2}/;
const BLOCK_REF_PATTERN = /^blocks\/(?:0|[1-9]\d*)$/;

function objectAt(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: CandidateIssue[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "必须是对象" });
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) issues.push({ path: `${path}.${key}`, message: "未知字段" });
  }
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) issues.push({ path: `${path}.${key}`, message: "缺少字段" });
  }
  return obj;
}

function stringAt(value: unknown, path: string, issues: CandidateIssue[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > API_BODY_MAX_BYTES) {
    issues.push({ path, message: "必须是非空且不超过 API_BODY_MAX_BYTES 的字符串" });
    return null;
  }
  return value;
}

function keyAt(value: unknown, path: string, issues: CandidateIssue[]): string | null {
  const key = stringAt(value, path, issues);
  if (key !== null && (!KEY_PATTERN.test(key) || DATE_IN_KEY.test(key))) {
    issues.push({ path, message: "必须是无日期的稳定语义键" });
    return null;
  }
  return key;
}

function arrayAt(value: unknown, path: string, issues: CandidateIssue[]): unknown[] | null {
  if (!Array.isArray(value) || value.length > API_BODY_MAX_BYTES) {
    issues.push({ path, message: "必须是长度受限的数组" });
    return null;
  }
  return value;
}

function evidenceAt(value: unknown, path: string, issues: CandidateIssue[]): EvidenceQuote | null {
  const obj = objectAt(value, path, ["block_ref", "quote", "tag"], issues);
  if (obj === null) return null;
  const blockRef = stringAt(obj.block_ref, `${path}.block_ref`, issues);
  if (blockRef !== null && !BLOCK_REF_PATTERN.test(blockRef)) {
    issues.push({ path: `${path}.block_ref`, message: "必须引用 blocks/<索引>" });
  }
  const quote = stringAt(obj.quote, `${path}.quote`, issues);
  const tag = obj.tag;
  if (tag !== null && tag !== "t_gl" && tag !== "t_lc") {
    issues.push({ path: `${path}.tag`, message: "时间标签只能是 t_gl、t_lc 或 null" });
  }
  if (blockRef === null || !BLOCK_REF_PATTERN.test(blockRef) || quote === null) return null;
  if (tag !== null && tag !== "t_gl" && tag !== "t_lc") return null;
  return { block_ref: blockRef, quote, tag };
}

function milestoneAt(
  value: unknown,
  path: string,
  issues: CandidateIssue[],
): MilestoneProposal | null {
  const obj = objectAt(
    value,
    path,
    ["milestone_key", "node_type", "title", "time", "time_evidence"],
    issues,
  );
  if (obj === null) return null;
  const key = keyAt(obj.milestone_key, `${path}.milestone_key`, issues);
  const nodeType = NodeTypeSchema.safeParse(obj.node_type);
  if (!nodeType.success) issues.push({ path: `${path}.node_type`, message: "无效节点类型" });
  const title = stringAt(obj.title, `${path}.title`, issues);
  const time = TimeValueSchema.safeParse(obj.time);
  if (!time.success) issues.push({ path: `${path}.time`, message: "无效 TimeValue 或未知字段" });
  const evidence = evidenceAt(obj.time_evidence, `${path}.time_evidence`, issues);
  if (key === null || !nodeType.success || title === null || !time.success || evidence === null) {
    return null;
  }
  if (!evidence.quote.includes(time.data.raw_expression)) {
    issues.push({ path: `${path}.time_evidence.quote`, message: "必须包含原始时间表达" });
    return null;
  }
  return {
    milestone_key: key,
    node_type: nodeType.data,
    title,
    time: time.data,
    time_evidence: evidence,
  };
}

function eventAt(value: unknown, path: string, issues: CandidateIssue[]): EventProposal | null {
  const obj = objectAt(
    value,
    path,
    [
      "event_key",
      "event_type",
      "status",
      "title",
      "summary",
      "type_evidence",
      "status_evidence",
      "change_relation",
      "milestones",
    ],
    issues,
  );
  if (obj === null) return null;
  const key = keyAt(obj.event_key, `${path}.event_key`, issues);
  const eventType = EventTypeSchema.safeParse(obj.event_type);
  if (!eventType.success) issues.push({ path: `${path}.event_type`, message: "无效事件类型" });
  const status = EventStatusSchema.safeParse(obj.status);
  if (!status.success) issues.push({ path: `${path}.status`, message: "无效事件状态" });
  const title = stringAt(obj.title, `${path}.title`, issues);
  const summary = obj.summary === null ? null : stringAt(obj.summary, `${path}.summary`, issues);
  const typeEvidence = evidenceAt(obj.type_evidence, `${path}.type_evidence`, issues);
  const statusEvidence =
    obj.status_evidence === null
      ? null
      : evidenceAt(obj.status_evidence, `${path}.status_evidence`, issues);
  let relation: EventProposal["change_relation"] = null;
  if (obj.change_relation !== null) {
    const relationObj = objectAt(
      obj.change_relation,
      `${path}.change_relation`,
      ["target_event_id", "reason"],
      issues,
    );
    if (relationObj !== null) {
      const target = stringAt(
        relationObj.target_event_id,
        `${path}.change_relation.target_event_id`,
        issues,
      );
      const reason = stringAt(relationObj.reason, `${path}.change_relation.reason`, issues);
      if (target !== null && reason !== null) relation = { target_event_id: target, reason };
    }
  }
  const rawMilestones = arrayAt(obj.milestones, `${path}.milestones`, issues);
  if (rawMilestones?.length === 0) {
    issues.push({ path: `${path}.milestones`, message: "事件至少需要一个节点" });
  }
  const milestones = rawMilestones?.map((item, index) =>
    milestoneAt(item, `${path}.milestones[${index}]`, issues),
  );
  const seen = new Set<string>();
  for (const milestone of milestones ?? []) {
    if (milestone === null) continue;
    if (seen.has(milestone.milestone_key)) {
      issues.push({ path: `${path}.milestones`, message: "milestone_key 重复" });
    }
    seen.add(milestone.milestone_key);
  }
  if (status.success && status.data === "cancelled" && statusEvidence === null) {
    issues.push({ path: `${path}.status_evidence`, message: "取消必须有官方证据" });
  }
  if (
    key === null ||
    !eventType.success ||
    !status.success ||
    title === null ||
    (obj.summary !== null && summary === null) ||
    typeEvidence === null ||
    (obj.status_evidence !== null && statusEvidence === null) ||
    (obj.change_relation !== null && relation === null) ||
    milestones == null ||
    milestones.some((item) => item === null)
  )
    return null;
  return {
    event_key: key,
    event_type: eventType.data,
    status: status.data,
    title,
    summary,
    type_evidence: typeEvidence,
    status_evidence: statusEvidence,
    change_relation: relation,
    milestones: milestones as MilestoneProposal[],
  };
}

/** 纯函数：严格检查类型、枚举、长度、数组、空值、未知字段和总字节数。 */
export function parseCandidateProposal(input: unknown): CandidateParseResult {
  const issues: CandidateIssue[] = [];
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { success: false, issues: [{ path: "$", message: "不是可序列化 JSON" }] };
  }
  // ADR-0012：候选整体上限独立于请求体上限；人工新建与修正另受请求体约束。
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > CANDIDATE_MAX_BYTES
  ) {
    issues.push({ path: "$", message: "候选超过 CANDIDATE_MAX_BYTES" });
  }
  const obj = objectAt(input, "$", ["classification", "events", "ambiguities"], issues);
  if (obj === null) return { success: false, issues };
  const classification = obj.classification;
  if (
    classification !== "events" &&
    classification !== "no_event" &&
    classification !== "uncertain"
  ) {
    issues.push({ path: "$.classification", message: "无效分类" });
  }
  const rawEvents = arrayAt(obj.events, "$.events", issues);
  const events = rawEvents?.map((item, index) => eventAt(item, `$.events[${index}]`, issues));
  const rawAmbiguities = arrayAt(obj.ambiguities, "$.ambiguities", issues);
  const ambiguities = rawAmbiguities?.map((item, index) =>
    stringAt(item, `$.ambiguities[${index}]`, issues),
  );
  if (classification === "no_event" && (rawEvents?.length !== 0 || rawAmbiguities?.length !== 0)) {
    issues.push({ path: "$", message: "no_event 不得同时含事件或歧义" });
  }
  if (classification === "events" && (rawEvents?.length === 0 || rawAmbiguities?.length !== 0)) {
    issues.push({ path: "$", message: "events 必须有事件且无未解歧义" });
  }
  if (classification === "uncertain" && rawAmbiguities?.length === 0) {
    issues.push({ path: "$.ambiguities", message: "uncertain 必须说明缺口或歧义" });
  }
  const seen = new Set<string>();
  for (const event of events ?? []) {
    if (event === null) continue;
    if (seen.has(event.event_key)) issues.push({ path: "$.events", message: "event_key 重复" });
    seen.add(event.event_key);
  }
  if (issues.length > 0 || rawEvents === null || rawAmbiguities === null) {
    return { success: false, issues };
  }
  return {
    success: true,
    data: {
      classification: classification as CandidateProposal["classification"],
      events: events as EventProposal[],
      ambiguities: ambiguities as string[],
    },
  };
}
