import {
  ACCOUNT_GRACE_DAYS,
  ACCOUNT_IDLE_DAYS,
  EMAIL_CONSENT_DISABLE_ACTION,
  MATCH_PAGE,
  RECLAIM_TELEMETRY_STALE_HOURS,
} from "@hoyo/contracts";
import { auditEffect } from "../../admin/audit";
import { renewEmailSeat } from "../../mail/channel/lease";
import { ApiError } from "../../shell";
import { controlPredicate } from "../../shell/observability/controls";
import { recordMetric } from "../../shell/observability/metrics";
import { conditionalCommit } from "../../storage/cas";
import { readReclaimGate } from "../activity/telemetry";
import { collectLifecycleEffects, type LifecycleEffectHook } from "../lifecycle/effects";

const DAY = 86400 * 1000;
// created_at 仅在账号尚无活动时提供起点；没有被动请求或投递时间参与。
export const ACTIVITY_SQL = `MAX(COALESCE(last_interactive_at,created_at),COALESCE(last_feed_poll_at,created_at),COALESCE(last_push_processed_at,created_at))`;
export const TRUST_SQL = `EXISTS(SELECT 1 FROM system_state WHERE key='reclaim_paused' AND value_json='false')
 AND (SELECT last_success_at FROM activity_write_failures WHERE metric='feed_poll_merge' AND last_success_at IS NOT NULL ORDER BY utc_day DESC LIMIT 1) BETWEEN ? AND ?`;
const staleCutoff = (now: number) => now - RECLAIM_TELEMETRY_STALE_HOURS * 3600 * 1000;
export interface ReclaimCandidate {
  id: string;
  order: number;
  activity_at: number;
  reclaim_grace_until: number;
  seat_enabled: number;
  channel_revision: number | null;
}
export async function listReclaimCandidates(db: D1Database, now: number, after = 0) {
  const rows = (
    await db
      .prepare(`SELECT id,"order",${ACTIVITY_SQL} AS activity_at,reclaim_grace_until,
    COALESCE((SELECT enabled FROM email_channels WHERE user_id=users.id),0) AS seat_enabled,
    COALESCE((SELECT channel_revision FROM email_channels WHERE user_id=users.id),0) AS channel_revision
    FROM users WHERE status='active' AND "order">? AND reclaim_grace_until IS NOT NULL
    AND ${ACTIVITY_SQL}<=? AND ${ACTIVITY_SQL}<=reclaim_grace_until-?
    ORDER BY "order" LIMIT ?`)
      .bind(after, now - ACCOUNT_IDLE_DAYS * DAY, ACCOUNT_GRACE_DAYS * DAY, MATCH_PAGE)
      .all<ReclaimCandidate>()
  ).results;
  return {
    telemetry: await db
      .prepare(
        "SELECT value_json AS paused,updated_at FROM system_state WHERE key='reclaim_paused'",
      )
      .first<{ paused: string; updated_at: number }>(),
    candidates: rows,
    next_after: rows.length === MATCH_PAGE ? rows.at(-1)?.order : null,
    gate: await readReclaimGate(db, now),
    server_time: now,
  };
}

/** 每页先续租，再标宽限；宽限期内仍保持 active，原证明、Feed 均可继续使用。 */
export async function scanAccountPage(
  db: D1Database,
  now: number,
  after: number,
  initialGate?: Awaited<ReturnType<typeof readReclaimGate>>,
) {
  const rows = (
    await db
      .prepare(
        `SELECT id,"order" FROM users WHERE status='active' AND "order">? ORDER BY "order" LIMIT ?`,
      )
      .bind(after, MATCH_PAGE)
      .all<{ id: string; order: number }>()
  ).results;
  for (const row of rows) {
    await renewEmailSeat(db, row.id, now);
    // 恢复活动立即取消旧宽限；此非破坏操作不受回收暂停阻断。
    await db
      .prepare(
        `UPDATE users SET reclaim_grace_until=NULL WHERE id=? AND reclaim_grace_until IS NOT NULL AND ${ACTIVITY_SQL}>reclaim_grace_until-?`,
      )
      .bind(row.id, ACCOUNT_GRACE_DAYS * DAY)
      .run();
    const gate = await readReclaimGate(db, now);
    if (
      (!gate.accounts_paused && !initialGate?.accounts_paused) ||
      (!gate.seats_paused && !initialGate?.seats_paused)
    ) {
      await db
        .prepare(`UPDATE users SET reclaim_grace_until=? WHERE id=? AND status='active' AND reclaim_grace_until IS NULL AND ${ACTIVITY_SQL}<=?
       AND ${TRUST_SQL} AND (${controlPredicate("account_reclaim_enabled")} OR ${controlPredicate("seat_reclaim_enabled")})`)
        .bind(
          now + ACCOUNT_GRACE_DAYS * DAY,
          row.id,
          now - ACCOUNT_IDLE_DAYS * DAY,
          staleCutoff(now),
          now,
        )
        .run();
    }
  }
  return rows;
}

/** 维护者逐项确认即执行；无持久的宽泛“全选授权”，并发活动或关门使旧清单失效。 */
export async function confirmReclaim(
  db: D1Database,
  input: {
    user_id: string;
    activity_at: number;
    grace_until: number;
    channel_revision: number;
    kind: "account" | "seat";
    reason: string;
  },
  adminId: string,
  now: number,
  hooks: readonly LifecycleEffectHook[],
) {
  const gate = await readReclaimGate(db, now);
  if (input.kind === "account" ? gate.accounts_paused : gate.seats_paused)
    throw new ApiError("temporarily_unavailable");
  const common = `status='active' AND reclaim_grace_until=? AND ${ACTIVITY_SQL}=? AND ${ACTIVITY_SQL}<=? AND ${ACTIVITY_SQL}<=reclaim_grace_until-? AND ${TRUST_SQL}`;
  const params = [
    input.grace_until,
    input.activity_at,
    now - ACCOUNT_IDLE_DAYS * DAY,
    ACCOUNT_GRACE_DAYS * DAY,
    staleCutoff(now),
    now,
  ];
  const audit = auditEffect({
    actorId: adminId,
    action: input.kind === "account" ? "account_reclaim_confirm" : "seat_reclaim_confirm",
    targetType: "account",
    targetId: input.user_id,
    reason: input.reason,
    createdAt: now,
  });
  const channel = await db
    .prepare(
      "SELECT enabled,channel_revision,consent_version,(SELECT email_binding_id FROM users WHERE id=user_id) AS email_binding_id FROM email_channels WHERE user_id=?",
    )
    .bind(input.user_id)
    .first<{
      enabled: number;
      channel_revision: number;
      consent_version: number;
      email_binding_id: string;
    }>();
  let released = false;
  if (input.kind === "seat") {
    const result = await conditionalCommit(db, {
      guard: {
        sql: `UPDATE email_channels SET enabled=0,routine_enabled=0,lease_expires_at=NULL,channel_revision=channel_revision+1,updated_at=?
      WHERE user_id=? AND enabled=1 AND channel_revision=? AND ${controlPredicate("seat_reclaim_enabled")}
      AND EXISTS(SELECT 1 FROM users WHERE id=email_channels.user_id AND ${common})`,
        params: [now, input.user_id, input.channel_revision, ...params],
      },
      effects: [
        ...["seat", "routine"].map((layer) => ({
          kind: "insert" as const,
          table: "consent_events",
          columns: [
            "id",
            "user_id",
            "email_binding_id",
            "layer",
            "action",
            "consent_version",
            "context_json",
            "created_at",
          ],
          rows: [
            [
              crypto.randomUUID(),
              input.user_id,
              channel?.email_binding_id ?? "",
              layer,
              EMAIL_CONSENT_DISABLE_ACTION,
              channel?.consent_version ?? 0,
              JSON.stringify({ reason: "idle_reclaim" }),
              now,
            ],
          ],
        })),
        audit,
      ],
    });
    if (result.outcome !== "committed") throw new ApiError("conflict");
    released = true;
  } else {
    // 两道独立门：删除会同时释放开启的席位，席位门关闭时不允许间接绕过。
    if (channel?.enabled === 1 && gate.seats_paused) throw new ApiError("temporarily_unavailable");
    const effects = await collectLifecycleEffects(
      { db, userId: input.user_id, now, event: "account_delete" },
      hooks,
    );
    const result = await conditionalCommit(db, {
      guard: {
        sql: `UPDATE users SET status='deleting',auth_epoch=auth_epoch+1,updated_at=? WHERE id=? AND ${common} AND reclaim_grace_until<=?
      AND ${controlPredicate("account_reclaim_enabled")}
      AND (NOT EXISTS(SELECT 1 FROM email_channels WHERE user_id=users.id AND enabled=1) OR ${controlPredicate("seat_reclaim_enabled")})
      AND COALESCE((SELECT channel_revision FROM email_channels WHERE user_id=users.id),0)=?`,
        params: [now, input.user_id, ...params, now, input.channel_revision],
      },
      effects: [...effects, audit],
    });
    if (result.outcome !== "committed") throw new ApiError("conflict");
    released = channel?.enabled === 1;
  }
  if (released) await recordMetric(db, "seat_released", now);
  return { confirmed: true };
}
