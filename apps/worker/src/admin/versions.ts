// P3-19（ADR-0011）· 版本时间表管理 API：列出 AI 建议与确认值；管理员逐项确认或清除。
// 确认只能取自已核对的建议（或"紧接着的下一版本的更新开始"），不接受手填时刻；每次写入带 CAS、理由与审计。
import {
  nextKnownVersion,
  nextVersionCandidates,
  PUBLIC_READ_LIMITS,
  parseVersionAnchor,
  SUPPORTED_SCOPE_GAMES,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";
import type { CandidateProposal } from "../extraction/schema";
import { ApiError, jsonResponse, type ShellRoute } from "../shell";
import { conditionalCommit } from "../storage/cas";
import { auditEffect } from "./audit";
import { adminCsrfBinding, requireAdmin } from "./session-routes";

const REGION = SUPPORTED_SCOPE_REGIONS[0];

function invalid(path: string, reason = "invalid_value"): never {
  throw new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}
function noStore(value: unknown): Response {
  const response = jsonResponse(value);
  response.headers.set("cache-control", "no-store");
  return response;
}
function gameOf(value: unknown): string {
  if (typeof value !== "string" || !(SUPPORTED_SCOPE_GAMES as readonly string[]).includes(value))
    invalid("game");
  return value;
}
function versionOf(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(value)) invalid("version");
  return value;
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

interface VersionRow {
  game: string;
  region: string;
  version: string;
  update_start_ms: number | null;
  update_start_source: string | null;
  version_end_ms: number | null;
  version_end_source: string | null;
  version_end_basis: "stated" | "next_update" | null;
  updated_at: number;
}
interface SuggestionRow {
  id: string;
  game: string;
  region: string;
  version: string;
  article_version_id: string;
  update_start_ms: number | null;
  update_start_json: string | null;
  update_duration_json: string | null;
  version_end_ms: number | null;
  version_end_json: string | null;
  created_at: number;
  title: string | null;
  official_url: string | null;
}
interface GuardClause {
  sql: string;
  params: (string | number)[];
}

/** 待审草稿里引用到的版本锚点计数，帮助管理员判断先确认哪个版本；从待审候选的索引出发，读数以 pendingCandidates 为上界。 */
async function pendingReferences(db: D1Database): Promise<Record<string, number>> {
  const rows = (
    await db
      .prepare(`SELECT s.game, d.proposal_json FROM candidates c
        JOIN ai_drafts d ON d.candidate_id = c.id
        JOIN article_versions av ON av.id = d.article_version_id
        JOIN articles a ON a.id = av.article_id
        JOIN sources s ON s.source_id = a.source_id
        WHERE c.review_status = 'pending' AND d.proposal_json IS NOT NULL
        ORDER BY c.created_at LIMIT ?`)
      .bind(PUBLIC_READ_LIMITS.pendingCandidates)
      .all<{ game: string; proposal_json: string }>()
  ).results;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const proposal = JSON.parse(row.proposal_json) as CandidateProposal;
    const seen = new Set<string>();
    for (const event of proposal.events)
      for (const milestone of event.milestones) {
        const anchor = parseVersionAnchor(milestone.time.raw_expression);
        if (anchor !== null) seen.add(`${row.game}:${anchor.version}`);
      }
    for (const key of seen) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function readVersion(db: D1Database, game: string, version: string) {
  return db
    .prepare("SELECT * FROM game_versions WHERE game = ? AND region = ? AND version = ?")
    .bind(game, REGION, version)
    .first<VersionRow>();
}

/**
 * 版本结束取自本版本更新开始（next_update）的其他版本。有引用时本版本的更新开始不能改或清除，
 * 否则那份复制值会悄悄过期；要改先清除那个版本结束。
 */
async function dependentEnds(
  db: D1Database,
  game: string,
  version: string,
  source: string | null,
): Promise<string[]> {
  if (source === null) return [];
  return (
    await db
      .prepare(
        `SELECT version FROM game_versions WHERE game = ? AND region = ? AND version <> ?
           AND version_end_basis = 'next_update' AND version_end_source = ?`,
      )
      .bind(game, REGION, version, source)
      .all<{ version: string }>()
  ).results.map((row) => row.version);
}
/** 同一条件也写进 CAS 守卫，关掉"检查之后、写入之前"有人借用这个更新开始的竞态。 */
function noDependentsGuard(game: string, version: string, source: string): GuardClause {
  return {
    sql: ` AND NOT EXISTS (SELECT 1 FROM game_versions d WHERE d.game = ? AND d.region = ?
             AND d.version <> ? AND d.version_end_basis = 'next_update' AND d.version_end_source = ?)`,
    params: [game, REGION, version, source],
  };
}

export function makeAdminVersionRoutes(clock: () => number = Date.now): ShellRoute[] {
  const text = { type: "string", minLength: 1, maxLength: 128 } as const;
  return [
    {
      method: "GET",
      pattern: "/api/v2/admin/versions",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        if (ctx.url.search) invalid("query");
        // 按最近改动排序：上界只会截掉多年前没人再动的旧版本，不会整款游戏消失。
        const versions = (
          await ctx.env.DB.prepare(
            `SELECT * FROM game_versions WHERE region = ? AND updated_at > 0
              ORDER BY updated_at DESC LIMIT ?`,
          )
            .bind(REGION, PUBLIC_READ_LIMITS.scanPage)
            .all<VersionRow>()
        ).results;
        const suggestions = (
          await ctx.env.DB.prepare(
            `SELECT g.*, json_extract(av.body_blocks_json, '$[0].text') AS title, a.official_url
               FROM game_version_suggestions g
               JOIN article_versions av ON av.id = g.article_version_id
               JOIN articles a ON a.id = av.article_id
              WHERE g.region = ? ORDER BY g.created_at DESC LIMIT ?`,
          )
            .bind(REGION, PUBLIC_READ_LIMITS.scanPage)
            .all<SuggestionRow>()
        ).results;
        return noStore({
          versions,
          suggestions: suggestions.map((row) => ({
            ...row,
            update_start_json: undefined,
            update_duration_json: undefined,
            version_end_json: undefined,
            update_start: row.update_start_json === null ? null : JSON.parse(row.update_start_json),
            update_duration:
              row.update_duration_json === null ? null : JSON.parse(row.update_duration_json),
            version_end: row.version_end_json === null ? null : JSON.parse(row.version_end_json),
          })),
          pending_references: await pendingReferences(ctx.env.DB),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/versions/confirm",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          game: text,
          version: text,
          field: text,
          suggestion_id: { type: "string", optional: true, minLength: 1, maxLength: 64 },
          from_next_version: { type: "boolean", optional: true },
          // 取下一版本的更新开始时，带上页面上看到的那个值；值变了就 409，不写入管理员没看过的时间。
          expected_next_update_start_ms: { type: "number", optional: true },
          expected_updated_at: { type: "number" },
          reason: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const game = gameOf(body.game);
        const version = versionOf(body.version);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const field = body.field;
        if (field !== "update_start" && field !== "version_end") invalid("field");
        const current = await readVersion(ctx.env.DB, game, version);
        if ((current?.updated_at ?? 0) !== expected || (expected > 0 && now <= expected))
          throw new ApiError("conflict");
        let set: string;
        let params: (string | number | null)[];
        let detail: string;
        const guards: GuardClause[] = [];
        if (body.from_next_version === true) {
          if (field !== "version_end") invalid("from_next_version");
          // 版本结束 = 紧接着的下一版本的更新开始（7.1→7.2，没有 7.2 时 →8.0）；不跳过未知或未确认的版本。
          const candidates = nextVersionCandidates(version);
          const known = (
            await ctx.env.DB.prepare(
              `SELECT version FROM game_versions
                WHERE game = ? AND region = ? AND version IN (?, ?) AND updated_at > 0
               UNION SELECT version FROM game_version_suggestions
                WHERE game = ? AND region = ? AND version IN (?, ?)`,
            )
              .bind(game, REGION, ...candidates, game, REGION, ...candidates)
              .all<{ version: string }>()
          ).results.map((row) => row.version);
          const nextVersion = nextKnownVersion(version, known);
          if (nextVersion === null) invalid("from_next_version", "next_version_unknown");
          const later = await readVersion(ctx.env.DB, game, nextVersion);
          if (
            later === null ||
            later.update_start_ms === null ||
            later.update_start_source === null
          )
            invalid("from_next_version", "next_version_unconfirmed");
          if (body.expected_next_update_start_ms !== later.update_start_ms)
            throw new ApiError("conflict");
          set = "version_end_ms = ?, version_end_source = ?, version_end_basis = 'next_update'";
          params = [later.update_start_ms, later.update_start_source];
          detail = `version_end:next_update:${later.version}:${later.update_start_ms}`;
          guards.push({
            sql: ` AND EXISTS (SELECT 1 FROM game_versions n WHERE n.game = ? AND n.region = ?
                     AND n.version = ? AND n.update_start_ms = ? AND n.update_start_source = ?)`,
            params: [game, REGION, later.version, later.update_start_ms, later.update_start_source],
          });
        } else {
          if (typeof body.suggestion_id !== "string") invalid("suggestion_id");
          const suggestion = await ctx.env.DB.prepare(
            "SELECT * FROM game_version_suggestions WHERE id = ?",
          )
            .bind(body.suggestion_id)
            .first<SuggestionRow>();
          if (
            suggestion === null ||
            suggestion.game !== game ||
            suggestion.region !== REGION ||
            suggestion.version !== version
          )
            invalid("suggestion_id", "not_found");
          const value =
            field === "update_start" ? suggestion.update_start_ms : suggestion.version_end_ms;
          if (value === null) invalid("suggestion_id", "field_missing");
          set =
            field === "update_start"
              ? "update_start_ms = ?, update_start_source = ?"
              : "version_end_ms = ?, version_end_source = ?, version_end_basis = 'stated'";
          params = [value, suggestion.id];
          detail = `${field}:suggestion:${suggestion.id}`;
          const source = current?.update_start_source ?? null;
          if (field === "update_start" && source !== null && source !== suggestion.id) {
            if ((await dependentEnds(ctx.env.DB, game, version, source)).length > 0)
              invalid("field", "referenced_by_previous_end");
            guards.push(noDependentsGuard(game, version, source));
          }
        }
        const startMs = field === "update_start" ? params[0] : current?.update_start_ms;
        const endMs = field === "version_end" ? params[0] : current?.version_end_ms;
        if (typeof startMs === "number" && typeof endMs === "number" && endMs <= startMs)
          invalid("field", "end_not_after_start");
        const result = await conditionalCommit(ctx.env.DB, {
          preamble: [
            {
              sql: `INSERT INTO game_versions (game, region, version, updated_by, created_at, updated_at)
                    VALUES (?, ?, ?, 'system', ?, 0) ON CONFLICT DO NOTHING`,
              params: [game, REGION, version, now],
            },
          ],
          guard: {
            sql: `UPDATE game_versions SET ${set}, updated_by = ?, updated_at = ?
                   WHERE game = ? AND region = ? AND version = ? AND updated_at = ?${guards
                     .map((clause) => clause.sql)
                     .join("")}`,
            params: [
              ...params,
              admin.adminId,
              now,
              game,
              REGION,
              version,
              expected,
              ...guards.flatMap((clause) => clause.params),
            ],
          },
          effects: [
            auditEffect({
              actorId: admin.adminId,
              action: "version_confirm",
              targetType: "game_version",
              targetId: `${game}:${REGION}:${version}`,
              reason,
              createdAt: now,
              detailRef: detail,
            }),
          ],
        });
        if (result.outcome === "condition_missed") throw new ApiError("conflict");
        return noStore({ version: await readVersion(ctx.env.DB, game, version) });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/versions/clear",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          game: text,
          version: text,
          field: text,
          expected_updated_at: { type: "number" },
          reason: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const admin = requireAdmin(ctx.auth);
        const now = clock();
        const game = gameOf(body.game);
        const version = versionOf(body.version);
        const reason = reasonOf(body.reason);
        const expected = expectedOf(body.expected_updated_at);
        const field = body.field;
        if (field !== "update_start" && field !== "version_end") invalid("field");
        if (expected === 0 || now <= expected) throw new ApiError("conflict");
        const current = await readVersion(ctx.env.DB, game, version);
        if (current === null || current.updated_at !== expected) throw new ApiError("conflict");
        const removedMs =
          field === "update_start" ? current.update_start_ms : current.version_end_ms;
        const removedSource =
          field === "update_start" ? current.update_start_source : current.version_end_source;
        if (removedMs === null) invalid("field", "not_confirmed");
        const guards: GuardClause[] = [];
        if (field === "update_start" && removedSource !== null) {
          if ((await dependentEnds(ctx.env.DB, game, version, removedSource)).length > 0)
            invalid("field", "referenced_by_previous_end");
          guards.push(noDependentsGuard(game, version, removedSource));
        }
        const set =
          field === "update_start"
            ? "update_start_ms = NULL, update_start_source = NULL"
            : "version_end_ms = NULL, version_end_source = NULL, version_end_basis = NULL";
        const result = await conditionalCommit(ctx.env.DB, {
          guard: {
            sql: `UPDATE game_versions SET ${set}, updated_by = ?, updated_at = ?
                   WHERE game = ? AND region = ? AND version = ? AND updated_at = ?${guards
                     .map((clause) => clause.sql)
                     .join("")}`,
            params: [
              admin.adminId,
              now,
              game,
              REGION,
              version,
              expected,
              ...guards.flatMap((clause) => clause.params),
            ],
          },
          effects: [
            auditEffect({
              actorId: admin.adminId,
              action: "version_clear",
              targetType: "game_version",
              targetId: `${game}:${REGION}:${version}`,
              reason,
              createdAt: now,
              // 记下清除前的值与出处，审计里能还原每次变化。
              detailRef: `${field}:cleared:${removedMs}:${removedSource ?? "none"}`,
            }),
          ],
        });
        if (result.outcome === "condition_missed") throw new ApiError("conflict");
        return noStore({ version: await readVersion(ctx.env.DB, game, version) });
      },
    },
  ];
}
