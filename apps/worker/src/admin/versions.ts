// P3-19（ADR-0011）· 版本时间表管理 API：列出 AI 建议与确认值；管理员逐项确认或清除。
// 确认只能取自已核对的建议（或"下一版本的更新开始"），不接受手填时刻；每次写入带 CAS、理由与审计。
import {
  compareVersions,
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
}

/** 待审草稿里引用到的版本锚点计数，帮助管理员判断先确认哪个版本；扫描上界沿用待审候选的公共读上界。 */
async function pendingReferences(db: D1Database): Promise<Record<string, number>> {
  const rows = (
    await db
      .prepare(`SELECT s.game, d.proposal_json FROM ai_drafts d
        JOIN candidates c ON c.id = d.candidate_id AND c.review_status = 'pending'
        JOIN article_versions av ON av.id = d.article_version_id
        JOIN articles a ON a.id = av.article_id
        JOIN sources s ON s.source_id = a.source_id
        WHERE d.proposal_json IS NOT NULL LIMIT ?`)
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
        const versions = (
          await ctx.env.DB.prepare(
            `SELECT * FROM game_versions WHERE region = ? AND updated_at > 0
              ORDER BY game, updated_at DESC LIMIT ?`,
          )
            .bind(REGION, PUBLIC_READ_LIMITS.scanPage)
            .all<VersionRow>()
        ).results;
        const suggestions = (
          await ctx.env.DB.prepare(
            `SELECT g.*, json_extract(av.body_blocks_json, '$[0].text') AS title
               FROM game_version_suggestions g JOIN article_versions av ON av.id = g.article_version_id
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
        if (body.from_next_version === true) {
          if (field !== "version_end") invalid("from_next_version");
          // 版本结束 = 下一个版本的更新开始：取已确认的、版本号更大的最小版本。
          const later = (
            await ctx.env.DB.prepare(
              `SELECT version, update_start_ms, update_start_source FROM game_versions
                WHERE game = ? AND region = ? AND update_start_ms IS NOT NULL`,
            )
              .bind(game, REGION)
              .all<{ version: string; update_start_ms: number; update_start_source: string }>()
          ).results
            .filter((row) => compareVersions(row.version, version) > 0)
            .sort((a, b) => compareVersions(a.version, b.version))[0];
          if (later === undefined) invalid("from_next_version", "next_version_unconfirmed");
          set = "version_end_ms = ?, version_end_source = ?, version_end_basis = 'next_update'";
          params = [later.update_start_ms, later.update_start_source];
          detail = `version_end:next_update:${later.version}`;
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
                   WHERE game = ? AND region = ? AND version = ? AND updated_at = ?`,
            params: [...params, admin.adminId, now, game, REGION, version, expected],
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
        if (body.field !== "update_start" && body.field !== "version_end") invalid("field");
        if (expected === 0 || now <= expected) throw new ApiError("conflict");
        const set =
          body.field === "update_start"
            ? "update_start_ms = NULL, update_start_source = NULL"
            : "version_end_ms = NULL, version_end_source = NULL, version_end_basis = NULL";
        const result = await conditionalCommit(ctx.env.DB, {
          guard: {
            sql: `UPDATE game_versions SET ${set}, updated_by = ?, updated_at = ?
                   WHERE game = ? AND region = ? AND version = ? AND updated_at = ?`,
            params: [admin.adminId, now, game, REGION, version, expected],
          },
          effects: [
            auditEffect({
              actorId: admin.adminId,
              action: "version_clear",
              targetType: "game_version",
              targetId: `${game}:${REGION}:${version}`,
              reason,
              createdAt: now,
              detailRef: String(body.field),
            }),
          ],
        });
        if (result.outcome === "condition_missed") throw new ApiError("conflict");
        return noStore({ version: await readVersion(ctx.env.DB, game, version) });
      },
    },
  ];
}
