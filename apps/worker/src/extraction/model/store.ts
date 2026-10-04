// P3-17（ADR-0009）· ai_drafts 读写。草稿不是候选：这里不碰 candidates / evidence / events。
import { AI_DRAFT_PROFILE } from "@hoyo/contracts";
import type { CandidateProposal } from "../schema";
import { DRAFT_PROMPT_VERSION } from "./prompt";

/** ready：可一键采用；invalid：有草稿但未过统一校验；failed：调用失败；skipped：未调用（正文过长等）。 */
export const AI_DRAFT_STATUSES = ["ready", "invalid", "failed", "skipped"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

/** 同一 article_version + 提示词/Schema/模型组合可追溯（§3.4 可重放条款的草稿版本）。 */
export const DRAFT_PROFILE_REF = `${AI_DRAFT_PROFILE.model}/${DRAFT_PROMPT_VERSION}/candidate-schema-v1`;

export interface AiDraftUsage {
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly neurons: number;
  readonly finish_reason: string | null;
  readonly duration_ms: number;
}

export interface AiDraftRecord {
  readonly candidateId: string;
  readonly articleVersionId: string;
  readonly profileRef: string;
  readonly status: AiDraftStatus;
  readonly attempts: number;
  readonly proposal: CandidateProposal | null;
  readonly notes: readonly string[];
  readonly reasonCode: string | null;
  readonly usage: AiDraftUsage | null;
  readonly updatedAt: number;
}

interface DraftRow {
  candidate_id: string;
  article_version_id: string;
  profile_ref: string;
  status: AiDraftStatus;
  attempts: number;
  proposal_json: string | null;
  notes_json: string;
  reason_code: string | null;
  usage_json: string | null;
  updated_at: number;
}

export function draftRecord(row: DraftRow): AiDraftRecord {
  return {
    candidateId: row.candidate_id,
    articleVersionId: row.article_version_id,
    profileRef: row.profile_ref,
    status: row.status,
    attempts: row.attempts,
    proposal:
      row.proposal_json === null ? null : (JSON.parse(row.proposal_json) as CandidateProposal),
    notes: JSON.parse(row.notes_json) as string[],
    reasonCode: row.reason_code,
    usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as AiDraftUsage),
    updatedAt: row.updated_at,
  };
}

export async function readDraft(
  db: D1Database,
  candidateId: string,
): Promise<AiDraftRecord | null> {
  const row = await db
    .prepare(
      `SELECT candidate_id, article_version_id, profile_ref, status, attempts, proposal_json,
              notes_json, reason_code, usage_json, updated_at
         FROM ai_drafts WHERE candidate_id = ?`,
    )
    .bind(candidateId)
    .first<DraftRow>();
  return row === null ? null : draftRecord(row);
}

export interface DraftWrite {
  readonly candidateId: string;
  readonly articleVersionId: string;
  readonly status: AiDraftStatus;
  readonly proposal: CandidateProposal | null;
  readonly notes: readonly string[];
  readonly reasonCode: string | null;
  readonly usage: AiDraftUsage | null;
  /** 本次是否真的调用了模型；attempts 只数调用次数。 */
  readonly called: boolean;
  readonly nowMs: number;
}

/** 每个候选一行；失败重试覆盖同一行并累计调用次数，换了 profile 的重新起草从头计数。 */
export async function writeDraft(db: D1Database, draft: DraftWrite): Promise<void> {
  const called = draft.called ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO ai_drafts (candidate_id, article_version_id, profile_ref, status, attempts,
                              proposal_json, notes_json, reason_code, usage_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         article_version_id = excluded.article_version_id, profile_ref = excluded.profile_ref,
         status = excluded.status,
         attempts = CASE WHEN ai_drafts.profile_ref = excluded.profile_ref
                         THEN ai_drafts.attempts + ? ELSE ? END,
         proposal_json = excluded.proposal_json, notes_json = excluded.notes_json,
         reason_code = excluded.reason_code, usage_json = excluded.usage_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      draft.candidateId,
      draft.articleVersionId,
      DRAFT_PROFILE_REF,
      draft.status,
      called,
      draft.proposal === null ? null : JSON.stringify(draft.proposal),
      JSON.stringify(draft.notes),
      draft.reasonCode,
      draft.usage === null ? null : JSON.stringify(draft.usage),
      draft.nowMs,
      draft.nowMs,
      called,
      called,
    )
    .run();
}
