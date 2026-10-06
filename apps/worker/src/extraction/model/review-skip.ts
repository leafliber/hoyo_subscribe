// P3-25（ADR-0018）「跳过审核」：开关开启时，通过全部检查的 AI 草稿由系统批准为模型候选。
// 系统只做批准；发布仍由发布待办执行（只读、非关键发布暂停、版本推导过期等检查不变）。
// 检查没过的条目原样留在审核队列，由人工处理。所有者知情：模型质量评估（P0-03b）未做，
// 打开开关即接受 AI 草稿未经人工核对直接上线。
import { browseDate, SYSTEM_AUDIT_TTL } from "@hoyo/contracts";
import { checkCandidateText } from "../../admin/limits";
import type { GuardedEffect } from "../../storage/cas";
import {
  loadStoredArticleVersion,
  type StoredArticleVersion,
  validateCandidateAgainstArticle,
} from "../article";
import { eventIdentity } from "../identity";
import type { CandidateProposal } from "../schema";
import { approveModelCandidate, ensureModelRun } from "../service";
import {
  applyVersionDerivations,
  loadDerivationContext,
  versionDerivationIssues,
} from "../versions";
import { readDraft } from "./store";

/** 留给人工的原因；写进日志，便于核对为什么没有自动批准。 */
export type ReviewSkipHold =
  | "not_pending"
  | "draft_not_ready"
  | "draft_stale"
  | "uncertain"
  | "ambiguous"
  | "unresolved_time"
  | "validation_failed"
  | "derivation_mismatch"
  | "human_locked"
  | "possible_duplicate";

export type ReviewSkipOutcome =
  | { readonly kind: "approved"; readonly runId: string }
  | { readonly kind: "held"; readonly reason: ReviewSkipHold };

export const REVIEW_SKIP_REVIEWER = "system:review_skip";
export const REVIEW_SKIP_REASON =
  "跳过审核已开启：AI 草稿通过全部检查，由系统批准，未经人工核对（ADR-0018）";

// 单位换算，非预算、配额或 Feed 参数。
const DAY = 86_400_000;

interface PendingRow {
  id: string;
  run_id: string | null;
  review_status: string;
  updated_at: number;
  article_version_id: string | null;
}

const held = (reason: ReviewSkipHold): ReviewSkipOutcome => ({ kind: "held", reason });

/**
 * 标题比较用的键：全角半角统一，去掉空白、标点与符号，再去掉结尾的"活动""活动说明"。
 * 只用来**拦下**疑似重复交给人工，从不据此建立关联（跨公告关联只能由人工显式操作）。
 */
export function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/(?:活动说明|活动)$/u, "");
}

/** 事件里已知时间覆盖的北京时间日期范围；同一天的节点也算重叠。 */
function eventDays(
  event: CandidateProposal["events"][number],
): { from: string; to: string } | null {
  const days: string[] = [];
  for (const milestone of event.milestones) {
    if (milestone.time.precision === "datetime") days.push(browseDate(milestone.time.utc_ms));
    else if (milestone.time.precision === "date") days.push(milestone.time.date);
  }
  if (days.length === 0) return null;
  days.sort();
  return { from: days[0], to: days[days.length - 1] };
}

async function targetsLockedEvent(
  db: D1Database,
  article: StoredArticleVersion,
  proposal: CandidateProposal,
): Promise<boolean> {
  for (const event of proposal.events) {
    const id = await eventIdentity(article.sourceId, article.externalId, event.event_key);
    const locked = await db
      .prepare(
        `SELECT 1 AS locked FROM events WHERE id = ? AND human_locked = 1
         UNION ALL SELECT 1 FROM milestones WHERE event_id = ? AND human_locked = 1 LIMIT 1`,
      )
      .bind(id, id)
      .first<{ locked: number }>();
    if (locked !== null) return true;
  }
  return false;
}

/**
 * 同一游戏、同一区域里，已发布（未撤回）的别篇公告事件标题相同、日期范围有交叠时视为疑似重复。
 * 2026-10-06 首批图文资讯 18 条里有 8 条是版本公告已收录活动的说明，事件身份按文章区分，
 * 不拦就会各发一份。
 */
async function resemblesPublishedEvent(
  db: D1Database,
  article: StoredArticleVersion,
  proposal: CandidateProposal,
): Promise<boolean> {
  for (const event of proposal.events) {
    const key = titleKey(event.title);
    const days = eventDays(event);
    if (key === "" || days === null) continue;
    const own = await eventIdentity(article.sourceId, article.externalId, event.event_key);
    const fromMs = Date.parse(`${days.from}T00:00:00+08:00`);
    const toMs = Date.parse(`${days.to}T00:00:00+08:00`) + DAY - 1;
    const rows = (
      await db
        .prepare(
          `SELECT DISTINCT e.id, e.title FROM events e JOIN milestones m ON m.event_id = e.id
            WHERE e.game = ? AND e.region = ? AND e.status <> 'retracted'
              AND e.first_published_at IS NOT NULL AND e.id <> ?
              AND ((m.time_exact_ms BETWEEN ? AND ?) OR (m.time_date BETWEEN ? AND ?))`,
        )
        .bind(article.game, article.region, own, fromMs, toMs, days.from, days.to)
        .all<{ id: string; title: string }>()
    ).results;
    if (rows.some((row) => titleKey(row.title) === key)) return true;
  }
  return false;
}

function systemAudit(candidateId: string, detailRef: string, nowMs: number): GuardedEffect {
  return {
    kind: "insert",
    table: "audit_log",
    columns: [
      "id",
      "actor_type",
      "actor_id",
      "action",
      "target_type",
      "target_id",
      "reason",
      "detail_ref",
      "created_at",
      "expires_at",
    ],
    rows: [
      [
        crypto.randomUUID(),
        "system",
        "system",
        "candidate_review_skip",
        "candidate",
        candidateId,
        REVIEW_SKIP_REASON,
        detailRef,
        nowMs,
        nowMs + SYSTEM_AUDIT_TTL * 1000,
      ],
    ],
  };
}

/**
 * 草稿刚写好时调用（调用方已确认开关开启）。按草稿与当前版本时间表推导出的内容批准，
 * 与人工点「采用草稿并批准」看到的是同一份；任何一项检查没过都留给人工。
 */
export async function approveDraftWithoutReview(
  db: D1Database,
  candidateId: string,
  nowMs: number,
): Promise<ReviewSkipOutcome> {
  const candidate = await db
    .prepare(
      `SELECT c.id, c.run_id, c.review_status, c.updated_at,
              (SELECT e.article_version_id FROM evidence e WHERE e.candidate_id = c.id LIMIT 1) AS article_version_id
         FROM candidates c WHERE c.id = ?`,
    )
    .bind(candidateId)
    .first<PendingRow>();
  // 人工已接手（run_id 为空）或已裁定的候选不动。
  if (
    candidate === null ||
    candidate.review_status !== "pending" ||
    candidate.run_id === null ||
    candidate.article_version_id === null
  )
    return held("not_pending");
  const draft = await readDraft(db, candidateId);
  if (draft === null || draft.status !== "ready" || draft.proposal === null)
    return held("draft_not_ready");
  if (draft.articleVersionId !== candidate.article_version_id) return held("draft_stale");
  const article = await loadStoredArticleVersion(db, candidate.article_version_id);
  const context = await loadDerivationContext(db, article, draft.proposal);
  const derived = applyVersionDerivations(draft.proposal, context).proposal;
  let proposal: CandidateProposal;
  if (derived.classification === "no_event") {
    proposal = { classification: "no_event", events: [], ambiguities: [] };
  } else if (derived.classification !== "events") {
    return held("uncertain");
  } else {
    if (derived.ambiguities.length > 0) return held("ambiguous");
    if (
      derived.events.some((event) => event.milestones.some((m) => m.time.precision === "unknown"))
    )
      return held("unresolved_time");
    proposal = { classification: "events", events: derived.events, ambiguities: [] };
  }
  const parsed = validateCandidateAgainstArticle(proposal, article);
  if (!parsed.success) return held("validation_failed");
  if (versionDerivationIssues(parsed.data, context).length > 0) return held("derivation_mismatch");
  try {
    checkCandidateText(parsed.data);
  } catch {
    return held("validation_failed");
  }
  if (await targetsLockedEvent(db, article, parsed.data)) return held("human_locked");
  if (await resemblesPublishedEvent(db, article, parsed.data)) return held("possible_duplicate");
  const runId = await ensureModelRun(db, article.articleVersionId, draft.profileRef, nowMs);
  await approveModelCandidate(
    db,
    candidateId,
    runId,
    parsed.data,
    REVIEW_SKIP_REVIEWER,
    REVIEW_SKIP_REASON,
    nowMs,
    {
      expectedUpdatedAt: candidate.updated_at,
      auditEffect: systemAudit(candidateId, `ai_draft:${draft.profileRef};run=${runId}`, nowMs),
    },
  );
  return { kind: "approved", runId };
}
