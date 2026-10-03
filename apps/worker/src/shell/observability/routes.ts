import {
  API_BODY_MAX_BYTES,
  ControlWriteSchema,
  OPERATIONAL_CONTROLS,
  PlatformFactSchema,
} from "@hoyo/contracts";
import { auditStatement } from "../../admin/audit";
import { adminCsrfBinding, requireAdmin } from "../../admin/session-routes";
import { ApiError, jsonResponse, type ShellRoute } from "../../shell";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { controlKey, readControl } from "./controls";
import { readObservability } from "./views";

const text = { type: "string", minLength: 1, maxLength: API_BODY_MAX_BYTES } as const;
function noStore(value: unknown) {
  const response = jsonResponse(value);
  response.headers.set("cache-control", "no-store");
  return response;
}
export function makeObservabilityRoutes(clock: () => number = Date.now): ShellRoute[] {
  return [
    {
      method: "GET",
      pattern: "/api/v2/admin/observability",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        requireAdmin(ctx.auth);
        if (ctx.url.search) throw new ApiError("validation");
        return noStore(await readObservability(ctx.env.DB, clock()));
      },
    },
    {
      method: "GET",
      pattern: "/api/v2/admin/controls",
      domain: "admin",
      write: false,
      handler: async (ctx) => {
        requireAdmin(ctx.auth);
        if (ctx.url.search) throw new ApiError("validation");
        const controls = await Promise.all(
          OPERATIONAL_CONTROLS.filter((c) => c !== "source_enabled").map(async (control) => ({
            control,
            ...(await readControl(ctx.env.DB, control)),
          })),
        );
        const sources = await Promise.all(
          SOURCE_REGISTRY.map(async (entry) => ({
            control: "source_enabled",
            source: entry.sourceId,
            ...(await readControl(ctx.env.DB, "source_enabled", entry.sourceId)),
          })),
        );
        return noStore({ server_time: clock(), controls: [...controls, ...sources] });
      },
    },
    {
      method: "PUT",
      pattern: "/api/v2/admin/controls",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          control: text,
          enabled: { type: "boolean" },
          source: { ...text, optional: true },
          expected_updated_at: { type: "number" },
          reason: text,
        },
      },
      handler: async (ctx) => {
        const parsed = ControlWriteSchema.safeParse(ctx.body);
        if (!parsed.success || ctx.url.search) throw new ApiError("validation");
        const input = parsed.data;
        const admin = requireAdmin(ctx.auth);
        const key = controlKey(input.control, input.source);
        const at = clock();
        if (input.expected_updated_at >= at) throw new ApiError("conflict");
        const results = await ctx.env.DB.batch([
          ctx.env.DB.prepare(`INSERT INTO system_state(key,value_json,updated_at) SELECT ?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM system_state WHERE key=? AND updated_at=?)
 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at WHERE system_state.updated_at=?`).bind(
            key,
            JSON.stringify(input.enabled),
            at,
            input.expected_updated_at,
            key,
            input.expected_updated_at,
            input.expected_updated_at,
          ),
          ctx.env.DB.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
 SELECT ?, 'admin', ?, ?, 'operational_control', ?, ?, ?, ? WHERE changes()=1`).bind(
            crypto.randomUUID(),
            admin.adminId,
            input.enabled ? "control_enable" : "control_disable",
            key,
            input.reason,
            at,
            at + ADMIN_AUDIT_TTL * 1000,
          ),
        ]);
        if (results[0].meta.changes !== 1) throw new ApiError("conflict");
        return noStore({
          control: input.control,
          ...(input.source ? { source: input.source } : {}),
          value: input.enabled,
          updated_at: at,
        });
      },
    },
    {
      method: "PUT",
      pattern: "/api/v2/admin/observability/platform",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: {
          metric: text,
          value: { type: "number" },
          included: { type: "number", optional: true },
          observed_at: { type: "number" },
          period_start: { type: "number" },
          period_end: { type: "number" },
          reason: text,
        },
      },
      handler: async (ctx) => {
        const parsed = PlatformFactSchema.safeParse(ctx.body);
        const now = clock();
        if (
          !parsed.success ||
          ctx.url.search ||
          parsed.data.observed_at > now ||
          parsed.data.period_end <= now
        )
          throw new ApiError("validation");
        const admin = requireAdmin(ctx.auth);
        const fact = parsed.data;
        await ctx.env.DB.batch([
          ctx.env.DB.prepare(
            `INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
          ).bind(`obs:platform:${fact.metric}`, JSON.stringify(fact), now),
          auditStatement(ctx.env.DB, {
            actorId: admin.adminId,
            action: "platform_evidence_record",
            targetType: "platform_metric",
            targetId: fact.metric,
            reason: fact.reason,
            createdAt: now,
          }),
        ]);
        return noStore({ recorded: true, server_time: now });
      },
    },
  ];
}

import { ADMIN_AUDIT_TTL } from "@hoyo/contracts";
