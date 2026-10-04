import { AI_SOFT_DAY, API_BODY_MAX_BYTES, MATCH_PAGE } from "@hoyo/contracts";
import { loadStoredArticleVersion, validateCandidateAgainstArticle } from "../extraction/article";
import { readUsageDay } from "../extraction/model/ledger";
import { readableBlockText } from "../extraction/model/readable";
import { DRAFT_PROFILE_REF, readDraft } from "../extraction/model/store";
import type { CandidateProposal } from "../extraction/schema";
import {
  CandidateConflictError,
  CandidateValidationError,
  createManualCandidate,
  decideCandidate,
  findCandidateById,
  reviseCandidate,
} from "../extraction/service";
import {
  applyVersionDerivations,
  loadVersionsFor,
  versionDerivationIssues,
} from "../extraction/versions";
import {
  associateApprovedCandidate,
  type PublishHooks,
  type PublishOutcome,
  publishApprovedCandidate,
  publishManualCorrection,
  retractWithApprovedCandidate,
} from "../publishing/publish";
import { ApiError, jsonResponse, type ShellRoute } from "../shell";
import type { GuardedEffect } from "../storage/cas";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "../storage/crypto/bytes";
import { type AdminAudit, auditEffect, auditStatement } from "./audit";
import { checkCandidateText, checkPublishedNodeBytes } from "./limits";
import { adminCsrfBinding, requireAdmin } from "./session-routes";

function invalid(path: string, reason = "invalid_value"): never {
  throw new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}
function noStore(value: unknown): Response {
  const response = jsonResponse(value);
  response.headers.set("cache-control", "no-store");
  return response;
}
function reasonOf(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid("reason");
  return value.trim();
}
function expectedOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid("expected_updated_at");
  return value;
}
async function detail(db: D1Database, id: string) {
  const exists = await db.prepare("SELECT id FROM candidates WHERE id = ?").bind(id).first();
  if (exists === null) invalid("candidate_id", "not_found");
  const candidate = await findCandidateById(db, id);
  const article = await loadStoredArticleVersion(db, candidate.article_version_id);
  return { candidate, article };
}

const text = { type: "string", minLength: 1, maxLength: API_BODY_MAX_BYTES } as const;
const writeFields = {
  candidate_id: text,
  expected_updated_at: { type: "number" } as const,
  reason: text,
};
const actionNames = ["approve", "correct", "associate", "retract"] as const;
type Action = (typeof actionNames)[number];

async function publish(
  db: D1Database,
  action: Action,
  id: string,
  reason: string,
  target: string | undefined,
  now: number,
  hooks: PublishHooks,
): Promise<PublishOutcome> {
  switch (action) {
    case "approve":
      return publishApprovedCandidate(db, id, now, false, hooks);
    case "correct":
      return publishManualCorrection(db, id, reason, now, hooks);
    case "associate":
      return associateApprovedCandidate(db, id, target ?? "", reason, now, hooks);
    case "retract":
      return retractWithApprovedCandidate(db, id, reason, now, hooks);
  }
}

export function makeAdminReviewRoutes(clock: () => number = Date.now): ShellRoute[] {
  const routes: ShellRoute[] = [
    {
      method: "GET",
      pattern: "/api/v2/admin/review/queue",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        for (const key of ctx.url.searchParams.keys()) if (key !== "cursor") invalid(key);
        let after: { createdAt: number; id: string } | null = null;
        const cursor = ctx.url.searchParams.get("cursor");
        if (cursor !== null) {
          try {
            if (cursor.length > API_BODY_MAX_BYTES) invalid("cursor");
            const decoded = fromBase64Url(cursor);
            if (decoded === null) invalid("cursor");
            const value = JSON.parse(utf8Decode(decoded));
            if (
              value === null ||
              typeof value !== "object" ||
              !Number.isSafeInteger(value.createdAt) ||
              typeof value.id !== "string" ||
              Object.keys(value).length !== 2
            )
              invalid("cursor");
            after = value;
          } catch {
            invalid("cursor");
          }
        }
        // P3-17：一次查询带回标题、来源与草稿状态，审核页不再逐条读详情（原 N+1）。
        const rows = (
          await ctx.env.DB.prepare(`SELECT c.id, c.created_at, c.updated_at, c.run_id,
          av.id AS article_version_id, a.source_id, a.external_id, s.game,
          json_extract(av.body_blocks_json, '$[0].text') AS title, d.status AS draft_status
          FROM candidates c
          LEFT JOIN article_versions av ON av.id =
            (SELECT e.article_version_id FROM evidence e WHERE e.candidate_id = c.id LIMIT 1)
          LEFT JOIN articles a ON a.id = av.article_id
          LEFT JOIN sources s ON s.source_id = a.source_id
          LEFT JOIN ai_drafts d ON d.candidate_id = c.id
          WHERE c.review_status='pending'
          AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?)) ORDER BY c.created_at,c.id LIMIT ?`)
            .bind(after?.createdAt ?? -1, after?.createdAt ?? -1, after?.id ?? "", MATCH_PAGE + 1)
            .all<{
              id: string;
              created_at: number;
              updated_at: number;
              run_id: string | null;
              article_version_id: string | null;
              source_id: string | null;
              external_id: string | null;
              game: string | null;
              title: string | null;
              draft_status: string | null;
            }>()
        ).results;
        const page = rows.slice(0, MATCH_PAGE);
        const last = page.at(-1);
        const usage = await readUsageDay(ctx.env.DB, clock());
        return noStore({
          candidates: page,
          ai_usage: {
            day: usage.day,
            settled: usage.settled,
            reserved: usage.reserved,
            cap: AI_SOFT_DAY,
          },
          next_cursor:
            rows.length > MATCH_PAGE && last
              ? toBase64Url(utf8Encode(JSON.stringify({ createdAt: last.created_at, id: last.id })))
              : null,
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/v2/admin/review/candidates/*",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        if (ctx.url.search) invalid("query");
        const id = ctx.params.rest.slice(1);
        if (!id || id.includes("/")) invalid("candidate_id");
        const record = await detail(ctx.env.DB, id);
        const evidence = (
          await ctx.env.DB.prepare(
            "SELECT id, article_version_id, block_ref, event_id, milestone_id FROM evidence WHERE candidate_id = ?",
          )
            .bind(id)
            .all()
        ).results;
        const draft = await readDraft(ctx.env.DB, id);
        // ADR-0011：按当前确认的版本时间表推导"X.Y版本更新后/版本结束"，草稿本身不改写。
        const derivation =
          draft?.proposal == null
            ? null
            : applyVersionDerivations(
                draft.proposal,
                await loadVersionsFor(
                  ctx.env.DB,
                  record.article.game,
                  record.article.region,
                  draft.proposal,
                ),
              );
        return noStore({
          ...record,
          candidate: {
            ...record.candidate,
            proposal_json: JSON.parse(record.candidate.proposal_json),
          },
          evidence,
          // P3-17：可读文本只用于展示，证据校验仍以 article.blocks 原文为准。
          readable_blocks: record.article.blocks.map(readableBlockText),
          media_count: record.article.mediaRefs.length,
          draft:
            draft === null
              ? null
              : {
                  status: draft.status,
                  profile_ref: draft.profileRef,
                  article_version_id: draft.articleVersionId,
                  proposal: derivation?.proposal ?? draft.proposal,
                  notes: [...draft.notes, ...(derivation?.notes ?? [])],
                  derived_count: derivation?.derived ?? 0,
                  derivation_key: derivation?.key ?? "[]",
                  reason_code: draft.reasonCode,
                  usage: draft.usage,
                  updated_at: draft.updatedAt,
                },
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/review/create",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      // proposal_json 是完整 JSON 字符串，内部形状只由 P3-03 校验器定义一次（含 null/联合类型）。
      bodySchema: { fields: { article_version_id: text, proposal_json: text, reason: text } },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const reason = reasonOf(body.reason);
        const articleId = String(body.article_version_id);
        const article = await loadStoredArticleVersion(ctx.env.DB, articleId);
        let raw: unknown;
        try {
          raw = JSON.parse(String(body.proposal_json));
        } catch {
          invalid("proposal_json");
        }
        const parsed = validateCandidateAgainstArticle(raw, article);
        if (!parsed.success) invalid("proposal_json", "candidate_validation_failed");
        if (
          versionDerivationIssues(
            parsed.data,
            await loadVersionsFor(ctx.env.DB, article.game, article.region, parsed.data),
          ).length > 0
        )
          invalid("proposal_json", "version_derivation_mismatch");
        checkCandidateText(parsed.data);
        const candidate = await createManualCandidate(
          ctx.env.DB,
          articleId,
          parsed.data,
          now,
          (id) =>
            auditStatement(ctx.env.DB, {
              actorId: admin.adminId,
              action: "candidate_create",
              targetType: "candidate",
              targetId: id,
              reason,
              createdAt: now,
            }),
        );
        return noStore({ candidate });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/review/revise",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: { fields: { ...writeFields, proposal_json: text } },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const id = String(body.candidate_id);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const current = await detail(ctx.env.DB, id);
        if (
          current.candidate.updated_at !== expected ||
          current.candidate.review_status !== "pending" ||
          now <= expected
        )
          throw new ApiError("conflict");
        let raw: unknown;
        try {
          raw = JSON.parse(String(body.proposal_json));
        } catch {
          invalid("proposal_json");
        }
        const parsed = validateCandidateAgainstArticle(raw, current.article);
        if (!parsed.success) invalid("proposal_json", "candidate_validation_failed");
        if (
          versionDerivationIssues(
            parsed.data,
            await loadVersionsFor(
              ctx.env.DB,
              current.article.game,
              current.article.region,
              parsed.data,
            ),
          ).length > 0
        )
          invalid("proposal_json", "version_derivation_mismatch");
        checkCandidateText(parsed.data);
        const candidate = await reviseCandidate(ctx.env.DB, id, parsed.data, now, {
          expectedUpdatedAt: expected,
          auditEffect: auditEffect({
            actorId: admin.adminId,
            action: "candidate_revise",
            targetType: "candidate",
            targetId: id,
            reason,
            createdAt: now,
          }),
        });
        return noStore({ candidate });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/review/reject",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: { fields: writeFields },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const id = String(body.candidate_id);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const current = await detail(ctx.env.DB, id);
        if (
          current.candidate.updated_at !== expected ||
          current.candidate.review_status !== "pending" ||
          now <= expected
        )
          throw new ApiError("conflict");
        const candidate = await decideCandidate(
          ctx.env.DB,
          id,
          "rejected",
          admin.adminId,
          reason,
          now,
          {
            expectedUpdatedAt: expected,
            auditEffect: auditEffect({
              actorId: admin.adminId,
              action: "candidate_reject",
              targetType: "candidate",
              targetId: id,
              reason,
              createdAt: now,
            }),
          },
        );
        return noStore({ candidate });
      },
    },
    {
      // P3-17（ADR-0009）：采用 AI 草稿 = 一次带理由、带审计的人工修正。只从库里取草稿，
      // 客户端只能排除事件或节点、确认歧义，不能提交任意候选内容；批准仍走 approve。
      method: "POST",
      pattern: "/api/v2/admin/review/adopt-draft",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          ...writeFields,
          // ADR-0010：草稿会在后台按新 profile 重新起草；绑定审核员看到的那一版，避免采用没看过的内容。
          expected_draft_updated_at: { type: "number" },
          // ADR-0011：推导用到的版本时间行；版本时间表在审核员打开后被改过时 409。
          expected_derivation_key: { type: "string", maxLength: API_BODY_MAX_BYTES },
          exclude: { type: "array", items: { type: "string", minLength: 1, maxLength: 32 } },
          confirm_ambiguities: { type: "boolean" },
        },
      },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const id = String(body.candidate_id);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const exclude = new Set(
          (body.exclude as string[]).map((path) => {
            if (!/^e\d+(?:\.m\d+)?$/.test(path)) invalid("exclude");
            return path;
          }),
        );
        const current = await detail(ctx.env.DB, id);
        if (
          current.candidate.updated_at !== expected ||
          current.candidate.review_status !== "pending" ||
          now <= expected
        )
          throw new ApiError("conflict");
        const draft = await readDraft(ctx.env.DB, id);
        if (draft === null || draft.proposal === null) invalid("candidate_id", "draft_missing");
        // 文章出了新版本时草稿已过期，不能拿旧正文的引文去修正；草稿被重新起草过也要重新核对。
        if (
          draft.articleVersionId !== current.article.articleVersionId ||
          draft.updatedAt !== body.expected_draft_updated_at
        )
          throw new ApiError("conflict");
        const versions = await loadVersionsFor(
          ctx.env.DB,
          current.article.game,
          current.article.region,
          draft.proposal,
        );
        const derivation = applyVersionDerivations(draft.proposal, versions);
        if (derivation.key !== body.expected_derivation_key) throw new ApiError("conflict");
        const events = derivation.proposal.events.flatMap((event, eventIndex) => {
          if (exclude.has(`e${eventIndex}`)) return [];
          const milestones = event.milestones.filter(
            (_, milestoneIndex) => !exclude.has(`e${eventIndex}.m${milestoneIndex}`),
          );
          return milestones.length === 0 ? [] : [{ ...event, milestones }];
        });
        let proposal: CandidateProposal;
        if (draft.proposal.classification === "no_event") {
          proposal = { classification: "no_event", events: [], ambiguities: [] };
        } else {
          if (events.length === 0) invalid("exclude", "nothing_left");
          if (draft.proposal.classification === "uncertain" && body.confirm_ambiguities !== true)
            invalid("confirm_ambiguities", "required");
          proposal = { classification: "events", events, ambiguities: [] };
        }
        const parsed = validateCandidateAgainstArticle(proposal, current.article);
        if (!parsed.success) invalid("exclude", "candidate_validation_failed");
        if (versionDerivationIssues(parsed.data, versions).length > 0)
          invalid("exclude", "version_derivation_mismatch");
        checkCandidateText(parsed.data);
        const candidate = await reviseCandidate(ctx.env.DB, id, parsed.data, now, {
          expectedUpdatedAt: expected,
          auditEffect: auditEffect({
            actorId: admin.adminId,
            action: "candidate_adopt_draft",
            targetType: "candidate",
            targetId: id,
            reason,
            createdAt: now,
            detailRef: `ai_draft:${DRAFT_PROFILE_REF};excluded=${exclude.size};confirmed=${body.confirm_ambiguities === true}`,
          }),
        });
        return noStore({
          candidate_id: id,
          review_status: candidate.reviewStatus,
          updated_at: candidate.updatedAtMs,
        });
      },
    },
  ];
  for (const action of actionNames)
    routes.push({
      method: "POST",
      pattern: `/api/v2/admin/review/${action}`,
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: action === "associate" ? { ...writeFields, target_event_id: text } : writeFields,
      },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const id = String(body.candidate_id);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const current = await detail(ctx.env.DB, id);
        if (
          current.candidate.updated_at !== expected ||
          !["pending", "approved"].includes(current.candidate.review_status) ||
          now <= expected
        )
          throw new ApiError("conflict");
        const parsed = validateCandidateAgainstArticle(
          JSON.parse(current.candidate.proposal_json),
          current.article,
        );
        if (
          !parsed.success ||
          parsed.data.classification === "uncertain" ||
          current.article.completeness !== "complete"
        )
          invalid("candidate_id", "candidate_validation_failed");
        checkCandidateText(parsed.data);
        // ADR-0011：采用后版本时间表被改过或清除时，不发布过期的推导时间；撤回不受此限，避免阻塞纠错。
        if (
          action !== "retract" &&
          versionDerivationIssues(
            parsed.data,
            await loadVersionsFor(
              ctx.env.DB,
              current.article.game,
              current.article.region,
              parsed.data,
            ),
          ).length > 0
        )
          invalid("candidate_id", "version_derivation_mismatch");
        if (action === "retract" && parsed.data.events.some((e) => e.status !== "retracted"))
          invalid("candidate_id");
        if (action !== "retract" && parsed.data.events.some((e) => e.status === "retracted"))
          invalid("candidate_id");
        if (action === "approve" && parsed.data.events.some((e) => e.change_relation !== null))
          invalid("candidate_id");
        const target = action === "associate" ? String(body.target_event_id) : undefined;
        if (target !== undefined) {
          const event = parsed.data.events[0];
          if (
            parsed.data.events.length !== 1 ||
            (event.change_relation !== null && event.change_relation.target_event_id !== target)
          )
            invalid("target_event_id");
          const targetRow = await ctx.env.DB.prepare("SELECT game,region FROM events WHERE id=?")
            .bind(target)
            .first<{ game: string; region: string }>();
          if (
            !targetRow ||
            targetRow.game !== current.article.game ||
            targetRow.region !== current.article.region
          )
            invalid("target_event_id");
        }
        const audit: AdminAudit = {
          actorId: admin.adminId,
          action: `candidate_${action}`,
          targetType: "candidate",
          targetId: id,
          reason,
          createdAt: now,
        };
        const auditId = crypto.randomUUID();
        const needsDecision = current.candidate.review_status === "pending";
        let revision = expected;
        if (needsDecision) {
          const decided = await decideCandidate(
            ctx.env.DB,
            id,
            "approved",
            admin.adminId,
            reason,
            now,
            { expectedUpdatedAt: expected, auditEffect: auditEffect(audit, auditId) },
          );
          revision = decided.updatedAtMs;
        }
        // 裁定先持久化；发布失败必须明确返回 approved + 未发布，允许绑定新版本重试。
        const effect: GuardedEffect = needsDecision
          ? {
              kind: "update",
              table: "audit_log",
              set: { detail_ref: "publication:published" },
              where: { sql: "id = ?", params: [auditId] },
            }
          : auditEffect(audit, auditId);
        let publication:
          | PublishOutcome
          | { outcome: "temporarily_unavailable" | "validation_failed" };
        try {
          publication = await publish(ctx.env.DB, action, id, reason, target, now, {
            expectedUpdatedAt: revision,
            prepareEffects: async (projections) => {
              await checkPublishedNodeBytes(ctx.env.DB, projections, now, current.article);
              return [effect];
            },
          });
        } catch (error) {
          // 已批准不能伪装成整个操作回滚；错误文本可能含正文，不返回也不记日志。
          if (!needsDecision) throw error;
          publication = {
            outcome:
              error instanceof ApiError && error.code === "validation"
                ? "validation_failed"
                : "temporarily_unavailable",
          };
        }
        if (!needsDecision && publication.outcome !== "published")
          await auditStatement(ctx.env.DB, audit).run();
        return noStore({
          candidate_id: id,
          review_status: "approved",
          updated_at: revision,
          publication,
        });
      },
    });
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      if (route.write && ctx.url.search) invalid("query");
      try {
        return await route.handler(ctx);
      } catch (error) {
        // P3-03 读取器的明确缺失错误：在审核边界转为字段级校验；其他存储错误仍上抛。
        if (error instanceof Error && error.message === "ArticleVersion 不存在")
          invalid("article_version_id", "not_found");
        if (error instanceof CandidateConflictError) throw new ApiError("conflict");
        if (error instanceof CandidateValidationError)
          invalid("candidate_id", "candidate_validation_failed");
        throw error;
      }
    },
  }));
}
