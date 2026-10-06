// P3-10 所有者追加授权：HTTP 并发修正使用统一条件守卫；写操作可同批追加审计。
// P3-03 · 候选审核队列领域服务。只写 extraction_runs/candidates/evidence；
// events/milestones/发布修订由 P3-04 条件提交，本模块不越界。
import { API_BODY_MAX_BYTES, type ReviewStatus } from "@hoyo/contracts";
import { conditionalCommit, type GuardedEffect, type SqlParam } from "../storage/cas";
import {
  candidateEvidenceRefs,
  loadStoredArticleVersion,
  type StoredArticleVersion,
  validateCandidateAgainstArticle,
} from "./article";
import type { RuleOutcome } from "./rules";
import { type CandidateProposal, parseCandidateProposal } from "./schema";

const RULE_PROFILE_REF = "rule-whitelist-v1/candidate-schema-v1";

interface CandidateRow {
  id: string;
  run_id: string | null;
  proposal_json: string;
  review_status: ReviewStatus;
  updated_at: number;
  article_version_id: string;
  /** 只有按抽取运行查到的行才带；用于区分规则与模型（P3-25）。 */
  extractor?: string | null;
}

export interface CandidateRecord {
  readonly candidateId: string;
  readonly articleVersionId: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly game: StoredArticleVersion["game"];
  readonly region: StoredArticleVersion["region"];
  readonly officialUrl: string;
  readonly proposal: CandidateProposal;
  readonly reviewStatus: ReviewStatus;
  /** model：「跳过审核」开启时由系统批准的 AI 草稿（P3-25，ADR-0018）。 */
  readonly path: "rule" | "model" | "manual";
  readonly updatedAtMs: number;
}

/** HTTP 客户端绑定读取版本；调用者提供审计效果，领域层不持管理员秘密。 */
export interface CandidateWriteOptions {
  readonly expectedUpdatedAt?: number;
  readonly auditEffect?: GuardedEffect;
}

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export class CandidateConflictError extends Error {
  constructor() {
    super("候选已并发改变");
    this.name = "CandidateConflictError";
  }
}

function checkExpected(current: CandidateRow, options: CandidateWriteOptions): void {
  if (options.expectedUpdatedAt !== undefined && current.updated_at !== options.expectedUpdatedAt)
    throw new CandidateConflictError();
}

function requireProposal(input: unknown, article: StoredArticleVersion): CandidateProposal {
  const result = validateCandidateAgainstArticle(input, article);
  if (!result.success) {
    throw new CandidateValidationError(
      `候选校验失败：${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

function preserveKeysOnRevision(previous: CandidateProposal, next: CandidateProposal): void {
  if (previous.events.length !== next.events.length) return;
  for (const [index, priorEvent] of previous.events.entries()) {
    const event = next.events[index];
    if (event.event_key !== priorEvent.event_key) {
      throw new CandidateValidationError("修正候选不得改动已有 event_key；改期不换 Event 身份");
    }
    if (priorEvent.milestones.length !== event.milestones.length) continue;
    for (const [nodeIndex, priorNode] of priorEvent.milestones.entries()) {
      if (event.milestones[nodeIndex].milestone_key !== priorNode.milestone_key) {
        throw new CandidateValidationError("修正候选不得改动已有 milestone_key；改期不换节点身份");
      }
    }
  }
}

function record(row: CandidateRow, article: StoredArticleVersion): CandidateRecord {
  const parsed = parseCandidateProposal(JSON.parse(row.proposal_json));
  if (!parsed.success) throw new Error("保存的候选未通过统一 Schema");
  return {
    candidateId: row.id,
    articleVersionId: article.articleVersionId,
    sourceId: article.sourceId,
    externalId: article.externalId,
    game: article.game,
    region: article.region,
    officialUrl: article.officialUrl,
    proposal: parsed.data,
    reviewStatus: row.review_status,
    path: row.run_id === null ? "manual" : row.extractor === "model" ? "model" : "rule",
    updatedAtMs: row.updated_at,
  };
}

function evidenceStatements(
  db: D1Database,
  candidateId: string,
  articleVersionId: string,
  proposal: CandidateProposal,
  nowMs: number,
): D1PreparedStatement[] {
  const refs = [...candidateEvidenceRefs(proposal)];
  if (refs.length === 0) refs.push("blocks/0");
  return refs.map((ref) =>
    db
      .prepare(
        `INSERT INTO evidence (id, candidate_id, event_id, milestone_id, article_version_id, block_ref, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), candidateId, articleVersionId, ref, nowMs),
  );
}

async function targetEventId(
  db: D1Database,
  proposal: CandidateProposal,
  article: StoredArticleVersion,
): Promise<string | null> {
  let onlyTarget: string | null = null;
  for (const event of proposal.events) {
    const target = event.change_relation?.target_event_id;
    if (target === undefined) continue;
    const row = await db
      .prepare("SELECT game, region FROM events WHERE id = ?")
      .bind(target)
      .first<{
        game: string;
        region: string;
      }>();
    if (row === null || row.game !== article.game || row.region !== article.region) {
      throw new CandidateValidationError("更正目标 Event 不存在或与文章来源区域不一致");
    }
    onlyTarget = onlyTarget === null ? target : "";
  }
  return proposal.events.length === 1 && onlyTarget !== "" ? onlyTarget : null;
}

export async function findCandidateById(
  db: D1Database,
  candidateId: string,
): Promise<CandidateRow> {
  const row = await db
    .prepare(
      `SELECT c.id, c.run_id, c.proposal_json, c.review_status, c.updated_at,
              (SELECT e.article_version_id FROM evidence e WHERE e.candidate_id = c.id LIMIT 1) AS article_version_id
         FROM candidates c WHERE c.id = ?`,
    )
    .bind(candidateId)
    .first<CandidateRow>();
  if (row === null || row.article_version_id === null)
    throw new CandidateValidationError("候选不存在或缺少 ArticleVersion 证据");
  return row;
}

/** 直接依据保存的 ArticleVersion 人工创建候选；无需任何模型 run。 */
export async function createManualCandidate(
  db: D1Database,
  articleVersionId: string,
  input: unknown,
  nowMs: number,
  audit?: (candidateId: string) => D1PreparedStatement,
): Promise<CandidateRecord> {
  const article = await loadStoredArticleVersion(db, articleVersionId);
  const proposal = requireProposal(input, article);
  const eventId = await targetEventId(db, proposal, article);
  const candidateId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO candidates (id, run_id, event_id, proposal_json, review_status,
                                 reviewer, decided_at, decision_reason, created_at, updated_at)
         VALUES (?, NULL, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
      )
      .bind(candidateId, eventId, JSON.stringify(proposal), nowMs, nowMs),
    ...evidenceStatements(db, candidateId, articleVersionId, proposal, nowMs),
    ...(audit === undefined ? [] : [audit(candidateId)]),
  ]);
  return {
    candidateId,
    articleVersionId,
    sourceId: article.sourceId,
    externalId: article.externalId,
    game: article.game,
    region: article.region,
    officialUrl: article.officialUrl,
    proposal,
    reviewStatus: "pending",
    path: "manual",
    updatedAtMs: nowMs,
  };
}

/** 人工修正 pending 候选；包括将规则入队候选接管为人工候选。 */
export async function reviseCandidate(
  db: D1Database,
  candidateId: string,
  input: unknown,
  nowMs: number,
  options: CandidateWriteOptions = {},
): Promise<CandidateRecord> {
  const current = await findCandidateById(db, candidateId);
  checkExpected(current, options);
  if (current.review_status !== "pending") throw new CandidateConflictError();
  if (nowMs <= current.updated_at) throw new CandidateValidationError("修正时间必须晚于上次修改");
  const article = await loadStoredArticleVersion(db, current.article_version_id);
  const proposal = requireProposal(input, article);
  await rewritePendingCandidate(db, current, article, proposal, nowMs, options, {
    sql: "run_id = NULL",
    params: [],
  });
  return {
    candidateId,
    articleVersionId: article.articleVersionId,
    sourceId: article.sourceId,
    externalId: article.externalId,
    game: article.game,
    region: article.region,
    officialUrl: article.officialUrl,
    proposal,
    reviewStatus: "pending",
    path: "manual",
    updatedAtMs: nowMs,
  };
}

/** P3-25（ADR-0018）：模型抽取运行按（文章版本, model, profile）唯一；同一组合重复批准时复用。 */
export async function ensureModelRun(
  db: D1Database,
  articleVersionId: string,
  profileRef: string,
  nowMs: number,
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO extraction_runs (id, article_version_id, extractor, profile_ref, status,
                                    usage_json, error, created_at, completed_at)
       VALUES (?, ?, 'model', ?, 'succeeded', NULL, NULL, ?, ?)
       ON CONFLICT (article_version_id, extractor, profile_ref) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), articleVersionId, profileRef, nowMs, nowMs)
    .run();
  const row = await db
    .prepare(
      `SELECT id FROM extraction_runs
        WHERE article_version_id = ? AND extractor = 'model' AND profile_ref = ? AND status = 'succeeded'`,
    )
    .bind(articleVersionId, profileRef)
    .first<{ id: string }>();
  if (row === null) throw new Error("模型抽取运行写入失败");
  return row.id;
}

/**
 * P3-25（ADR-0018）：「跳过审核」开启时，系统把规则入队的 pending 候选改为挂在模型抽取运行上的
 * 已批准候选（不加人工锁；发布仍由发布待办执行）。人工已接手（run_id 为空）的候选不动。
 */
export async function approveModelCandidate(
  db: D1Database,
  candidateId: string,
  runId: string,
  input: unknown,
  reviewer: string,
  reason: string,
  nowMs: number,
  options: CandidateWriteOptions = {},
): Promise<CandidateRecord> {
  if (
    reviewer.length === 0 ||
    reviewer.length > API_BODY_MAX_BYTES ||
    reason.length === 0 ||
    reason.length > API_BODY_MAX_BYTES
  )
    throw new CandidateValidationError("审核者与理由必须是非空且长度受限的字符串");
  const current = await findCandidateById(db, candidateId);
  checkExpected(current, options);
  if (current.review_status !== "pending" || current.run_id === null)
    throw new CandidateConflictError();
  if (nowMs <= current.updated_at) throw new CandidateValidationError("裁定时间必须晚于上次修改");
  const article = await loadStoredArticleVersion(db, current.article_version_id);
  const proposal = requireProposal(input, article);
  if (proposal.classification === "uncertain")
    throw new CandidateValidationError("有未解缺口或歧义的候选不能批准");
  const run = await db
    .prepare("SELECT article_version_id, extractor, status FROM extraction_runs WHERE id = ?")
    .bind(runId)
    .first<{ article_version_id: string; extractor: string; status: string }>();
  if (
    run === null ||
    run.extractor !== "model" ||
    run.status !== "succeeded" ||
    run.article_version_id !== article.articleVersionId
  )
    throw new CandidateValidationError("模型抽取运行与候选的文章版本不一致");
  await rewritePendingCandidate(db, current, article, proposal, nowMs, options, {
    sql: "run_id = ?, review_status = 'approved', reviewer = ?, decision_reason = ?, decided_at = ?",
    params: [runId, reviewer, reason, nowMs],
    where: "AND run_id IS NOT NULL",
  });
  return {
    candidateId,
    articleVersionId: article.articleVersionId,
    sourceId: article.sourceId,
    externalId: article.externalId,
    game: article.game,
    region: article.region,
    officialUrl: article.officialUrl,
    proposal,
    reviewStatus: "approved",
    path: "model",
    updatedAtMs: nowMs,
  };
}

/** 改写 pending 候选的内容，并整组替换它的证据引用；set 决定改写后的抽取运行与审核状态。 */
async function rewritePendingCandidate(
  db: D1Database,
  current: CandidateRow,
  article: StoredArticleVersion,
  proposal: CandidateProposal,
  nowMs: number,
  options: CandidateWriteOptions,
  set: { readonly sql: string; readonly params: readonly SqlParam[]; readonly where?: string },
): Promise<void> {
  const candidateId = current.id;
  const previous = parseCandidateProposal(JSON.parse(current.proposal_json));
  if (!previous.success) throw new Error("保存的旧候选未通过统一 Schema");
  preserveKeysOnRevision(previous.data, proposal);
  const eventId = await targetEventId(db, proposal, article);
  // 每条删除只命中一个已读证据，避免 changes() 链被多行 DELETE 截断。
  const evidence = (
    await db
      .prepare("SELECT id FROM evidence WHERE candidate_id = ?")
      .bind(candidateId)
      .all<{ id: string }>()
  ).results;
  const refs = [...candidateEvidenceRefs(proposal)];
  if (refs.length === 0) refs.push("blocks/0");
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE candidates SET ${set.sql}, event_id = ?, proposal_json = ?, updated_at = ?
        WHERE id = ? AND review_status = 'pending' AND updated_at = ? ${set.where ?? ""}
        AND (SELECT count(*) FROM evidence WHERE candidate_id = candidates.id) = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) old WHERE NOT EXISTS
          (SELECT 1 FROM evidence WHERE id = old.value AND candidate_id = candidates.id))`,
      params: [
        ...set.params,
        eventId,
        JSON.stringify(proposal),
        nowMs,
        candidateId,
        current.updated_at,
        evidence.length,
        JSON.stringify(evidence.map((row) => row.id)),
      ],
    },
    effects: [
      ...evidence.map(
        (row): GuardedEffect => ({
          kind: "delete",
          table: "evidence",
          where: { sql: "id = ?", params: [row.id] },
        }),
      ),
      ...refs.map(
        (ref): GuardedEffect => ({
          kind: "insert",
          table: "evidence",
          columns: [
            "id",
            "candidate_id",
            "event_id",
            "milestone_id",
            "article_version_id",
            "block_ref",
            "created_at",
          ],
          rows: [
            [crypto.randomUUID(), candidateId, null, null, article.articleVersionId, ref, nowMs],
          ],
        }),
      ),
      ...(options.auditEffect === undefined ? [] : [options.auditEffect]),
    ],
  });
  if (result.outcome === "condition_missed") throw new CandidateConflictError();
}

/** 人工裁定只变候选审核状态；真正发布留给 P3-04。 */
export async function decideCandidate(
  db: D1Database,
  candidateId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  reason: string,
  nowMs: number,
  options: CandidateWriteOptions = {},
): Promise<CandidateRecord> {
  if (
    reviewer.length === 0 ||
    reviewer.length > API_BODY_MAX_BYTES ||
    reason.length === 0 ||
    reason.length > API_BODY_MAX_BYTES
  )
    throw new CandidateValidationError("审核者与理由必须是非空且长度受限的字符串");
  const current = await findCandidateById(db, candidateId);
  checkExpected(current, options);
  if (current.review_status !== "pending") throw new CandidateConflictError();
  const article = await loadStoredArticleVersion(db, current.article_version_id);
  const proposal = requireProposal(JSON.parse(current.proposal_json), article);
  if (decision === "approved" && proposal.classification === "uncertain") {
    throw new CandidateValidationError("有未解缺口或歧义的候选不能批准");
  }
  if (nowMs <= current.updated_at) throw new CandidateValidationError("裁定时间必须晚于上次修改");
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE candidates SET run_id = NULL, review_status = ?, reviewer = ?, decision_reason = ?,
        decided_at = ?, updated_at = ? WHERE id = ? AND review_status = 'pending' AND updated_at = ?`,
      params: [decision, reviewer, reason, nowMs, nowMs, candidateId, current.updated_at],
    },
    effects: options.auditEffect === undefined ? [] : [options.auditEffect],
  });
  if (result.outcome === "condition_missed") throw new CandidateConflictError();
  return record({ ...current, run_id: null, review_status: decision, updated_at: nowMs }, article);
}

/** pending 队列读取；返回绑定后的来源事实，避免调用方从正文反推身份。 */
export async function listReviewQueue(db: D1Database): Promise<readonly CandidateRecord[]> {
  const result = await db
    .prepare(
      `SELECT c.id, c.run_id, c.proposal_json, c.review_status, c.updated_at,
              (SELECT e.article_version_id FROM evidence e WHERE e.candidate_id = c.id LIMIT 1) AS article_version_id
         FROM candidates c WHERE c.review_status = 'pending'
        ORDER BY c.created_at, c.id`,
    )
    .all<CandidateRow>();
  const records: CandidateRecord[] = [];
  for (const row of result.results ?? []) {
    const article = await loadStoredArticleVersion(db, row.article_version_id);
    records.push(record(row, article));
  }
  return records;
}

export interface RuleCandidateResult {
  readonly candidate: CandidateRecord;
  readonly rule: RuleOutcome;
  readonly replayed: boolean;
}

/** 同 article_version + rule profile 的结果幂等重放；人工接管优先，旧规则不覆盖。 */
export async function storeRuleCandidate(
  db: D1Database,
  article: StoredArticleVersion,
  rule: RuleOutcome,
  nowMs: number,
): Promise<RuleCandidateResult> {
  const manual = await db
    .prepare(
      `SELECT c.id, c.run_id, c.proposal_json, c.review_status, c.updated_at,
              e.article_version_id
         FROM candidates c JOIN evidence e ON e.candidate_id = c.id
        WHERE e.article_version_id = ? AND c.run_id IS NULL
        ORDER BY c.updated_at DESC LIMIT 1`,
    )
    .bind(article.articleVersionId)
    .first<CandidateRow>();
  if (manual !== null) return { candidate: record(manual, article), rule, replayed: true };

  // P3-25：「跳过审核」批准的模型候选取代规则入队的那条；发布待办重抽时不另建待审候选。
  const model = await db
    .prepare(
      `SELECT c.id, c.run_id, c.proposal_json, c.review_status, c.updated_at,
              er.article_version_id, er.extractor
         FROM extraction_runs er JOIN candidates c ON c.run_id = er.id
        WHERE er.article_version_id = ? AND er.extractor = 'model'
        ORDER BY c.updated_at DESC LIMIT 1`,
    )
    .bind(article.articleVersionId)
    .first<CandidateRow>();
  if (model !== null) return { candidate: record(model, article), rule, replayed: true };

  const previous = await db
    .prepare(
      `SELECT c.id, c.run_id, c.proposal_json, c.review_status, c.updated_at,
              er.article_version_id
         FROM extraction_runs er JOIN candidates c ON c.run_id = er.id
        WHERE er.article_version_id = ? AND er.extractor = 'rule' AND er.profile_ref = ?
        LIMIT 1`,
    )
    .bind(article.articleVersionId, RULE_PROFILE_REF)
    .first<CandidateRow>();
  if (previous !== null) return { candidate: record(previous, article), rule, replayed: true };

  const proposal = requireProposal(
    rule.kind === "ready_for_publication"
      ? rule.proposal
      : { classification: "uncertain", events: [], ambiguities: [rule.reason] },
    article,
  );
  const runId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  const reviewStatus: ReviewStatus = rule.kind === "ready_for_publication" ? "approved" : "pending";
  await db.batch([
    db
      .prepare(
        `INSERT INTO extraction_runs (id, article_version_id, extractor, profile_ref, status,
                                      usage_json, error, created_at, completed_at)
         VALUES (?, ?, 'rule', ?, 'succeeded', NULL, NULL, ?, ?)`,
      )
      .bind(runId, article.articleVersionId, RULE_PROFILE_REF, nowMs, nowMs),
    db
      .prepare(
        `INSERT INTO candidates (id, run_id, event_id, proposal_json, review_status,
                                 reviewer, decided_at, decision_reason, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(candidateId, runId, JSON.stringify(proposal), reviewStatus, nowMs, nowMs),
    ...evidenceStatements(db, candidateId, article.articleVersionId, proposal, nowMs),
  ]);
  return {
    candidate: {
      candidateId,
      articleVersionId: article.articleVersionId,
      sourceId: article.sourceId,
      externalId: article.externalId,
      game: article.game,
      region: article.region,
      officialUrl: article.officialUrl,
      proposal,
      reviewStatus,
      path: "rule",
      updatedAtMs: nowMs,
    },
    rule,
    replayed: false,
  };
}
