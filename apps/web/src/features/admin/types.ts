// P3-10 的传输形状；proposal_json 保持 unknown，候选规则只由服务端校验。
// P3-17（ADR-0009）增补：队列带标题与草稿状态，详情带可读正文与 AI 草稿。
import type { EventType, NodeType, TimeValue } from "@hoyo/contracts";

export type DraftStatus = "ready" | "invalid" | "failed" | "skipped";

export interface DraftEvidence {
  block_ref: string;
  quote: string;
  tag: string | null;
}

export interface DraftMilestone {
  milestone_key: string;
  node_type: NodeType;
  title: string;
  time: TimeValue;
  time_evidence: DraftEvidence;
}

export interface DraftEvent {
  event_key: string;
  event_type: EventType;
  status: string;
  title: string;
  type_evidence: DraftEvidence;
  status_evidence: DraftEvidence | null;
  milestones: DraftMilestone[];
}

export interface DraftProposal {
  classification: "events" | "no_event" | "uncertain";
  events: DraftEvent[];
  ambiguities: string[];
}

export interface DraftView {
  status: DraftStatus;
  profile_ref: string;
  article_version_id: string;
  proposal: DraftProposal | null;
  notes: string[];
  reason_code: string | null;
  usage: { neurons: number; prompt_tokens: number | null; completion_tokens: number | null } | null;
  updated_at: number;
  /** ADR-0011：按确认的版本时间表推导出的节点数，以及采用时要带回的推导版本。 */
  derived_count?: number;
  derivation_key?: string;
}

export interface VersionEvidence {
  block_ref: string;
  quote: string;
}

export interface VersionSuggestion {
  id: string;
  game: string;
  version: string;
  article_version_id: string;
  title: string | null;
  official_url: string | null;
  update_start_ms: number | null;
  update_start: VersionEvidence | null;
  update_duration: VersionEvidence | null;
  version_end_ms: number | null;
  version_end: VersionEvidence | null;
  created_at: number;
}

export interface VersionRecord {
  game: string;
  version: string;
  update_start_ms: number | null;
  update_start_source: string | null;
  version_end_ms: number | null;
  version_end_source: string | null;
  version_end_basis: "stated" | "next_update" | null;
  updated_at: number;
}

export interface VersionListing {
  versions: VersionRecord[];
  suggestions: VersionSuggestion[];
  pending_references: Record<string, number>;
}

export interface CandidateDetail {
  candidate: {
    id: string;
    article_version_id: string;
    updated_at: number;
    review_status: string;
    proposal_json: unknown;
  };
  article: {
    articleVersionId: string;
    articleId: string;
    sourceId: string;
    externalId: string;
    officialUrl: string;
    completeness: string;
    blocks: ({ kind: "html"; html: string } | { kind: "title" | "text"; text: string })[];
  };
  evidence: Record<string, unknown>[];
  /** 与 article.blocks 一一对应的可读文本（服务端生成，只用于展示）。 */
  readable_blocks?: string[];
  media_count?: number;
  draft?: DraftView | null;
}

export interface QueueRow {
  id: string;
  created_at: number;
  updated_at: number;
  article_version_id?: string | null;
  source_id?: string | null;
  external_id?: string | null;
  game?: string | null;
  title?: string | null;
  draft_status?: DraftStatus | null;
}

export interface QueuePage {
  candidates: QueueRow[];
  next_cursor: string | null;
  ai_usage?: { day: string; settled: number; reserved: number; cap: number };
}

export type ReviewAction = "revise" | "reject" | "approve" | "correct" | "associate" | "retract";

export interface PublicationReply {
  candidate_id: string;
  review_status: string;
  updated_at: number;
  publication: { outcome: string };
}

export interface AdoptReply {
  candidate_id: string;
  review_status: string;
  updated_at: number;
}
