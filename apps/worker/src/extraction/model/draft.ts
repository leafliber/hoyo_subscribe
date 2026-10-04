// P3-17（ADR-0009）· 单个候选的 AI 草稿：资格复核 → 账本预占 → 调用模型 → 结算 → 确定性构建 → 落草稿。
// 草稿只写 ai_drafts；候选、事件与公共快照只有管理员显式采用并批准后才会变化。
import {
  AI_DRAFT_PROFILE,
  AI_SOFT_DAY,
  aiDraftReservation,
  MODEL_NETWORK_RETRIES,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { logEvent } from "../../shell/logger";
import { loadStoredArticleVersion } from "../article";
import { buildDraftProposal, parseModelJson } from "./build";
import { reserveNeurons, settleNeurons } from "./ledger";
import { draftInputBytes, draftMessages } from "./prompt";
import { type AiDraftUsage, DRAFT_PROFILE_REF, readDraft, writeDraft } from "./store";

/** Workers AI 绑定的最小形状；测试注入固定响应替身，不发真实推理请求。 */
export interface DraftModel {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export type DraftJobOutcome =
  | { readonly kind: "done"; readonly reason: string | null }
  | { readonly kind: "later"; readonly reason: string; readonly dueAt: number };

export interface DraftJobInput {
  readonly db: D1Database;
  readonly ai: DraftModel | undefined;
  readonly candidateId: string;
  readonly modelEnabled: boolean;
  readonly deadline: number;
  readonly now: () => number;
}

interface CandidateRow {
  id: string;
  run_id: string | null;
  review_status: string;
  proposal_json: string;
  article_version_id: string | null;
}

/** 规则入队、仍待审、内容为 uncertain 的候选才需要草稿；人工接管或已裁定的不再起草。 */
export const DRAFT_ELIGIBLE_SQL = `c.review_status = 'pending' AND c.run_id IS NOT NULL
  AND json_extract(c.proposal_json, '$.classification') = 'uncertain'`;

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 优先平台回报的 neurons；缺失时按 token 与注册表单价计；都没有就按整笔预占。 */
function usageOf(result: unknown, durationMs: number, reserved: number): AiDraftUsage {
  const root =
    result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const usage =
    root.usage !== null && typeof root.usage === "object"
      ? (root.usage as Record<string, unknown>)
      : {};
  const prompt = finiteCount(usage.prompt_tokens);
  const completion = finiteCount(usage.completion_tokens);
  const reported = finiteCount(usage.neurons);
  const computed =
    prompt !== null && completion !== null
      ? (prompt * AI_DRAFT_PROFILE.inputNeuronsPerMillion +
          completion * AI_DRAFT_PROFILE.outputNeuronsPerMillion) /
        1_000_000
      : null;
  const choice = Array.isArray(root.choices) ? (root.choices[0] as Record<string, unknown>) : null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    neurons: Math.ceil(reported ?? computed ?? reserved),
    finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    duration_ms: durationMs,
  };
}

/** OpenAI 形状的 choices[0].message.content；兼容只给 response 的旧形状。 */
function outputOf(result: unknown): unknown {
  const root =
    result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const choice = Array.isArray(root.choices) ? (root.choices[0] as Record<string, unknown>) : null;
  const message =
    choice?.message !== null && typeof choice?.message === "object"
      ? (choice.message as Record<string, unknown>)
      : null;
  if (typeof message?.content === "string") return parseModelJson(message.content);
  if (typeof root.response === "string") return parseModelJson(root.response);
  if (root.response !== null && typeof root.response === "object") return root.response;
  return null;
}

export async function runDraftJob(input: DraftJobInput): Promise<DraftJobOutcome> {
  const { db, candidateId } = input;
  if (!input.modelEnabled) return { kind: "done", reason: "model_disabled" };
  if (input.ai === undefined) return { kind: "done", reason: "ai_binding_missing" };
  const candidate = await db
    .prepare(
      `SELECT c.id, c.run_id, c.review_status, c.proposal_json,
              (SELECT e.article_version_id FROM evidence e WHERE e.candidate_id = c.id LIMIT 1) AS article_version_id
         FROM candidates c WHERE c.id = ? AND ${DRAFT_ELIGIBLE_SQL}`,
    )
    .bind(candidateId)
    .first<CandidateRow>();
  if (candidate === null || candidate.article_version_id === null)
    return { kind: "done", reason: "not_eligible" };
  // 只有当前 profile（模型 + 提示词 + Schema）的结果算数；换了 profile 的旧草稿按新组合重新起草。
  const stored = await readDraft(db, candidateId);
  const existing = stored?.profileRef === DRAFT_PROFILE_REF ? stored : null;
  if (existing !== null && existing.status !== "failed")
    return { kind: "done", reason: "already_drafted" };
  if (existing !== null && existing.attempts > MODEL_NETWORK_RETRIES)
    return { kind: "done", reason: "retries_exhausted" };
  const article = await loadStoredArticleVersion(db, candidate.article_version_id);
  const skip = async (reasonCode: string, note: string): Promise<DraftJobOutcome> => {
    await writeDraft(db, {
      candidateId,
      articleVersionId: article.articleVersionId,
      status: "skipped",
      proposal: null,
      notes: [note],
      reasonCode,
      usage: null,
      called: false,
      nowMs: input.now(),
    });
    return { kind: "done", reason: reasonCode };
  };
  // 不完整版本不能批准（审核 API 与发布器都拒绝），起草只会浪费预算。
  if (article.completeness !== "complete")
    return skip("article_incomplete", "公告正文不完整，不能批准，未生成草稿。");
  const messages = draftMessages(article);
  const inputBytes = draftInputBytes(messages);
  if (inputBytes > AI_DRAFT_PROFILE.maxInputBytes)
    return skip("input_too_large", "公告正文超过草稿输入上限，未生成草稿，请人工处理。");
  const remaining = input.deadline - input.now();
  if (remaining <= 0) return { kind: "later", reason: "wall_limit", dueAt: input.now() };
  // 按本次实际输入字节预占：短公告不必按长公告的上限占住当日额度。
  const reservation = await reserveNeurons(
    db,
    input.now(),
    aiDraftReservation(AI_DRAFT_PROFILE, inputBytes),
    AI_SOFT_DAY,
  );
  if (reservation === null) {
    logEvent("warn", "ai_draft_budget_exhausted", { reason_code: "soft_day" });
    return {
      kind: "later",
      reason: "ai_budget_exhausted",
      dueAt: utcDayPeriod(input.now()).endMsExclusive,
    };
  }
  const started = input.now();
  let result: unknown;
  try {
    result = await input.ai.run(
      AI_DRAFT_PROFILE.model,
      {
        messages,
        max_completion_tokens: AI_DRAFT_PROFILE.maxOutputTokens,
        temperature: AI_DRAFT_PROFILE.temperature,
        reasoning_effort: AI_DRAFT_PROFILE.reasoningEffort,
      },
      { signal: AbortSignal.timeout(remaining) },
    );
  } catch (error) {
    // 是否已计费无法确认：按整笔预占结算，宁可多记不少记。
    await settleNeurons(db, reservation, reservation.amount, input.now());
    const attempts = (existing?.attempts ?? 0) + 1;
    await writeDraft(db, {
      candidateId,
      articleVersionId: article.articleVersionId,
      status: "failed",
      proposal: null,
      notes: ["调用模型失败，将在后续周期有限次重试；也可以直接人工处理。"],
      reasonCode:
        error instanceof Error && error.name === "TimeoutError"
          ? "model_timeout"
          : "model_call_failed",
      usage: null,
      called: true,
      nowMs: input.now(),
    });
    logEvent("warn", "ai_draft_call_failed", { reason_code: "model_call", attempt: attempts });
    return attempts > MODEL_NETWORK_RETRIES
      ? { kind: "done", reason: "retries_exhausted" }
      : {
          kind: "later",
          reason: "model_call_failed",
          dueAt: input.now() + WATCHDOG_INTERVAL * 1000,
        };
  }
  const usage = usageOf(result, input.now() - started, reservation.amount);
  const settled = await settleNeurons(db, reservation, usage.neurons, input.now());
  if (settled > reservation.amount)
    logEvent("error", "ai_usage_over_reservation", {
      reason_code: "over_reservation",
      count: settled,
    });
  const output = outputOf(result);
  if (output === null) {
    await writeDraft(db, {
      candidateId,
      articleVersionId: article.articleVersionId,
      status: "invalid",
      proposal: null,
      notes: [
        usage.finish_reason === "length"
          ? "模型输出被 max_completion_tokens 截断，无法解析为 JSON，请人工处理。"
          : "模型输出无法解析为 JSON，请人工处理。",
      ],
      reasonCode: "unparseable",
      usage,
      called: true,
      nowMs: input.now(),
    });
    return { kind: "done", reason: "unparseable" };
  }
  const built = buildDraftProposal(article, output);
  await writeDraft(db, {
    candidateId,
    articleVersionId: article.articleVersionId,
    status: built.status,
    proposal: built.proposal,
    notes: built.notes,
    reasonCode: null,
    usage,
    called: true,
    nowMs: input.now(),
  });
  logEvent("info", "ai_draft_written", { reason_code: built.status, count: usage.neurons });
  return { kind: "done", reason: null };
}
