import { ADMIN_AUDIT_TTL, API_BODY_MAX_BYTES, activityTelemetryStale } from "@hoyo/contracts";
import { adminCsrfBinding, requireAdmin } from "../../admin/session-routes";
import { ApiError, jsonResponse, type ShellRoute } from "../../shell";
import type { LifecycleEffectHook } from "../lifecycle/effects";
import { confirmReclaim, listReclaimCandidates } from "./service";

const text = { type: "string", minLength: 1, maxLength: API_BODY_MAX_BYTES } as const;
const number = { type: "number" } as const;
function response(value: unknown) {
  const r = jsonResponse(value);
  r.headers.set("cache-control", "no-store");
  return r;
}
export function makeReclaimRoutes(
  hooks: readonly LifecycleEffectHook[],
  clock: () => number = Date.now,
): ShellRoute[] {
  return [
    {
      method: "GET",
      pattern: "/api/v2/admin/reclaim",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        requireAdmin(ctx.auth);
        const after = Number(ctx.url.searchParams.get("after") ?? 0);
        if (
          !Number.isSafeInteger(after) ||
          after < 0 ||
          [...ctx.url.searchParams.keys()].some((k) => k !== "after")
        )
          throw new ApiError("validation");
        return response(await listReclaimCandidates(ctx.env.DB, clock(), after));
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/reclaim/confirm/*",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          activity_at: number,
          grace_until: number,
          channel_revision: number,
          kind: text,
          reason: text,
        },
      },
      handler: async (ctx) => {
        const admin = requireAdmin(ctx.auth);
        const b = ctx.body as {
          activity_at: number;
          grace_until: number;
          channel_revision: number;
          kind: "account" | "seat";
          reason: string;
        };
        if (
          ctx.url.search ||
          !b.reason.trim() ||
          !["account", "seat"].includes(b.kind) ||
          ![b.activity_at, b.grace_until, b.channel_revision].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          throw new ApiError("validation");
        const user_id = ctx.params.rest.slice(1);
        if (!user_id || user_id.includes("/")) throw new ApiError("validation");
        return response(
          await confirmReclaim(ctx.env.DB, { ...b, user_id }, admin.adminId, clock(), hooks),
        );
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/reclaim/resume",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: { expected_updated_at: number, last_success_at: number, reason: text },
      },
      handler: async (ctx) => {
        const admin = requireAdmin(ctx.auth);
        const b = ctx.body as {
          expected_updated_at: number;
          last_success_at: number;
          reason: string;
        };
        const now = clock();
        if (
          ctx.url.search ||
          !b.reason.trim() ||
          ![b.expected_updated_at, b.last_success_at].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          ) ||
          b.expected_updated_at >= now ||
          b.last_success_at > now
        )
          throw new ApiError("validation");
        if (activityTelemetryStale(b.last_success_at, now)) throw new ApiError("conflict");
        const r = await ctx.env.DB.batch([
          ctx.env.DB.prepare(`INSERT INTO system_state(key,value_json,updated_at) SELECT 'reclaim_paused','false',? WHERE
       (SELECT last_success_at FROM activity_write_failures WHERE metric='feed_poll_merge' AND last_success_at IS NOT NULL ORDER BY utc_day DESC LIMIT 1)=?
       AND COALESCE((SELECT updated_at FROM system_state WHERE key='reclaim_paused'),0)=?
       ON CONFLICT(key) DO UPDATE SET value_json='false',updated_at=excluded.updated_at`).bind(
            now,
            b.last_success_at,
            b.expected_updated_at,
          ),
          ctx.env.DB.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
       SELECT ?,'admin',?,'reclaim_resume','telemetry','reclaim_paused',?,?,? WHERE changes()=1`).bind(
            crypto.randomUUID(),
            admin.adminId,
            b.reason,
            now,
            now + ADMIN_AUDIT_TTL * 1000,
          ),
        ]);
        if (r[0].meta.changes !== 1) throw new ApiError("conflict");
        return response({ resumed: true, updated_at: now });
      },
    },
  ];
}
