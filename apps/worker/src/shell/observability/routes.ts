import {
  API_BODY_MAX_BYTES,
  ControlWriteSchema,
  liveActIdFromInput,
  OPERATIONAL_CONTROLS,
  OperationalReasonSchema,
  PlatformFactSchema,
  RedeemLiveRegisterSchema,
} from "@hoyo/contracts";
import { auditStatement } from "../../admin/audit";
import { adminCsrfBinding, requireAdmin } from "../../admin/session-routes";
import type { SourcePollState, TrackedLive } from "../../executors/pipeline/source-poll";
import { ApiError, jsonResponse, type ShellRoute } from "../../shell";
import { mergeRedeemHints, readRedeemHints, redeemHintKey } from "../../sources/redeem-store";
import { isLiveEntry, SOURCE_REGISTRY } from "../../sources/registry";
import { controlKey, readControl } from "./controls";
import { DELIVERY_TERMINAL_JOBS, readObservability, readSourceStates } from "./views";

const text = { type: "string", minLength: 1, maxLength: API_BODY_MAX_BYTES } as const;
/** 终态解除只接受闭合原因与早于当前时刻的乐观并发版本；原因不接受自由文本。 */
function recoveryInput(
  body: Record<string, unknown> | undefined,
  url: URL,
  now: number,
): { expected: number; reason: string } {
  const reason = OperationalReasonSchema.safeParse(body?.reason);
  const expected = body?.expected_updated_at;
  if (
    url.search ||
    !reason.success ||
    typeof expected !== "number" ||
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected >= now
  )
    throw new ApiError("validation");
  return { expected, reason: reason.data };
}
/** ADR-0030：来源采集水位里正在跟踪的直播活动，以及管理员登记、仍在跟踪期内的活动 ID。 */
async function readLiveTracking(db: D1Database, sourceId: string, now: number) {
  const row = await db
    .prepare("SELECT cursor_json FROM sources WHERE source_id = ?")
    .bind(sourceId)
    .first<{ cursor_json: string }>();
  let tracked: TrackedLive[] = [];
  try {
    const lives = row === null ? undefined : (JSON.parse(row.cursor_json) as SourcePollState).lives;
    tracked = Array.isArray(lives) ? [...lives] : [];
  } catch {
    tracked = [];
  }
  return {
    hints: await readRedeemHints(db, sourceId, now),
    tracked: tracked.map((live) => ({
      act_id: live.actId,
      first_seen_at: live.firstSeenAtMs,
      closed_at: live.closedAtMs,
    })),
  };
}
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
        const states = await readSourceStates(ctx.env.DB);
        const now = clock();
        const sources = await Promise.all(
          SOURCE_REGISTRY.map(async (entry) => {
            const state = states?.find((row) => row.source_id === entry.sourceId);
            return {
              control: "source_enabled",
              source: entry.sourceId,
              ...(await readControl(ctx.env.DB, "source_enabled", entry.sourceId)),
              // 开关旁说明这个来源能抓什么、最近抓取得怎样：能力取自注册表，状态取自 sources/jobs 行。
              info: {
                game: entry.game,
                adapter: entry.adapterKind,
                // ADR-0030：直播兑换码来源另列管理员登记的活动与正在跟踪的活动。
                ...(isLiveEntry(entry)
                  ? { lives: await readLiveTracking(ctx.env.DB, entry.sourceId, now) }
                  : {}),
                state:
                  state === undefined || state.verification_state === null
                    ? null
                    : {
                        verification_state: state.verification_state,
                        last_success_at: state.last_success_at,
                        updated_at: state.updated_at,
                        job_status: state.job_status,
                        job_last_error: state.job_last_error,
                      },
              },
            };
          }),
        );
        return noStore({ server_time: now, controls: [...controls, ...sources] });
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
      // 来源被源站访问控制拒绝后停在维护：只能由所有者有意解除，放回一次正常受控轮询；
      // 仍受限时同一抓取会重新标维护并告警。不做周期探测，不绕过官方访问控制。
      method: "POST",
      pattern: "/api/v2/admin/sources/resume",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: { source: text, expected_updated_at: { type: "number" }, reason: text },
      },
      handler: async (ctx) => {
        const admin = requireAdmin(ctx.auth);
        const at = clock();
        const input = recoveryInput(ctx.body, ctx.url, at);
        const entry = SOURCE_REGISTRY.find((source) => source.sourceId === ctx.body?.source);
        if (!entry) throw new ApiError("validation");
        const jobId = `pipeline:source:${entry.sourceId}`;
        const results = await ctx.env.DB.batch([
          // 恢复为注册表登记的状态，不能借解除升级来源能力。
          ctx.env.DB.prepare(`UPDATE sources SET verification_state=?,updated_at=? WHERE source_id=?
 AND verification_state='maintenance-required' AND updated_at=?
 AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='leased')`).bind(
            entry.verificationState,
            at,
            entry.sourceId,
            input.expected,
            jobId,
          ),
          ctx.env.DB.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
 SELECT ?, 'admin', ?, 'source_maintenance_release', 'source', ?, ?, ?, ? WHERE changes()=1`).bind(
            crypto.randomUUID(),
            admin.adminId,
            entry.sourceId,
            input.reason,
            at,
            at + ADMIN_AUDIT_TTL * 1000,
          ),
          // 丢弃停维护时残留的旧抓取页，只放回一次轮询；待办缺失时由 watchdog 补建。
          ctx.env.DB.prepare(`UPDATE jobs SET status='pending',payload_json=?,due_at=?,last_error=NULL,lease_owner=NULL,
 lease_expires_at=NULL,lease_version=lease_version+1,completed_at=NULL,updated_at=? WHERE id=? AND status='failed' AND changes()=1`).bind(
            JSON.stringify({ sourceId: entry.sourceId }),
            at,
            at,
            jobId,
          ),
        ]);
        if (results[0].meta.changes !== 1) throw new ApiError("conflict");
        return noStore({ resumed: true, source: entry.sourceId, updated_at: at });
      },
    },
    {
      // 与运维手册同语义：退避行置 done 解除，协调器回到 pending 续跑同一批。
      // 不改 mail_sending_available：确认故障已处理后，开启外发仍是单独一步。
      method: "POST",
      pattern: "/api/v2/admin/delivery/rearm",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: {
        fields: { job: text, expected_updated_at: { type: "number" }, reason: text },
      },
      handler: async (ctx) => {
        const admin = requireAdmin(ctx.auth);
        const at = clock();
        const input = recoveryInput(ctx.body, ctx.url, at);
        const job = DELIVERY_TERMINAL_JOBS.find((id) => id === ctx.body?.job);
        if (!job) throw new ApiError("validation");
        const results = await ctx.env.DB.batch([
          ctx.env.DB.prepare(`UPDATE jobs SET status=CASE WHEN id='delivery:dispatch' THEN 'pending' ELSE 'done' END,
 due_at=?,completed_at=CASE WHEN id='delivery:dispatch' THEN NULL ELSE ? END,lease_owner=NULL,lease_expires_at=NULL,
 lease_version=lease_version+1,updated_at=? WHERE id=? AND status='failed' AND updated_at=?`).bind(
            at,
            at,
            at,
            job,
            input.expected,
          ),
          ctx.env.DB.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
 SELECT ?, 'admin', ?, 'delivery_rearm', 'job', ?, ?, ?, ? WHERE changes()=1`).bind(
            crypto.randomUUID(),
            admin.adminId,
            job,
            input.reason,
            at,
            at + ADMIN_AUDIT_TTL * 1000,
          ),
        ]);
        if (results[0].meta.changes !== 1) throw new ApiError("conflict");
        return noStore({ rearmed: true, job, updated_at: at });
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
    {
      // ADR-0030：米游社首页没出现直播入口时，管理员登记官方直播页链接或活动 ID（兜底）。
      // 只把活动 ID 交给该来源的下一次采集，采集照常走受限请求与官方接口校验，不放宽来源规则；
      // 同一来源至多保留 REDEEM_LIVE_TRACK_MAX 个、跟踪期过后自动失效。
      method: "POST",
      pattern: "/api/v2/admin/redeem-lives",
      domain: "admin",
      write: true,
      csrfBinding: adminCsrfBinding,
      bodySchema: { fields: { source: text, live: text, reason: text } },
      handler: async (ctx) => {
        const parsed = RedeemLiveRegisterSchema.safeParse(ctx.body);
        if (!parsed.success || ctx.url.search) throw new ApiError("validation");
        const admin = requireAdmin(ctx.auth);
        const entry = SOURCE_REGISTRY.find((source) => source.sourceId === parsed.data.source);
        const actId = liveActIdFromInput(parsed.data.live);
        if (entry === undefined || !isLiveEntry(entry) || actId === null)
          throw new ApiError("validation");
        const now = clock();
        const key = redeemHintKey(entry.sourceId);
        const previous = await ctx.env.DB.prepare(
          "SELECT value_json, updated_at FROM system_state WHERE key = ?",
        )
          .bind(key)
          .first<{ value_json: string; updated_at: number }>();
        const hints = mergeRedeemHints(previous?.value_json ?? null, actId, now);
        const results = await ctx.env.DB.batch([
          // 按读到的版本条件写入：并发登记时后到的一次返回冲突，不丢前一次。
          ctx.env.DB.prepare(
            `INSERT INTO system_state(key,value_json,updated_at) SELECT ?,?,?
              WHERE ? = 0 OR EXISTS(SELECT 1 FROM system_state WHERE key = ? AND updated_at = ?)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
              WHERE system_state.updated_at = ?`,
          ).bind(
            key,
            JSON.stringify(hints),
            now,
            previous === null ? 0 : 1,
            key,
            previous?.updated_at ?? 0,
            previous?.updated_at ?? 0,
          ),
          ctx.env.DB.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
 SELECT ?, 'admin', ?, 'redeem_live_register', 'source', ?, ?, ?, ? WHERE changes()=1`).bind(
            crypto.randomUUID(),
            admin.adminId,
            entry.sourceId,
            parsed.data.reason,
            now,
            now + ADMIN_AUDIT_TTL * 1000,
          ),
          // 登记后尽快采集一次：待办在等常规间隔时提前到现在（租约中的不动）。
          ctx.env.DB.prepare(
            `UPDATE jobs SET due_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND due_at > ?`,
          ).bind(now, now, `pipeline:source:${entry.sourceId}`, now),
        ]);
        if (results[0].meta.changes !== 1) throw new ApiError("conflict");
        return noStore({
          registered: true,
          source: entry.sourceId,
          act_id: actId,
          tracked: hints.length,
          server_time: now,
        });
      },
    },
  ];
}

import { ADMIN_AUDIT_TTL } from "@hoyo/contracts";
