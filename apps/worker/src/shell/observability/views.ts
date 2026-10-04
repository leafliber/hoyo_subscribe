import {
  capacityWarning,
  FEED_MAX_STALE,
  MAIL_FEEDBACK_MAX,
  MAIL_POOLS,
  MAIL_UNMATCHED_MAX,
  OBS_DELIVERY_REASONS,
  OBS_METRICS,
  observedMailPools,
  observedRatio,
  PLATFORM_METRICS,
  PlatformFactSchema,
  ratioIntegrityAlert,
  utcDayPeriod,
} from "@hoyo/contracts";
import { readReclaimGate } from "../../accounts/activity/telemetry";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { readMailDayLedger } from "../../storage/ledger/mail-ledger";
import { readControls } from "./controls";
import { feedbackExpiredKeys } from "./feedback";
import { readMetric } from "./metrics";

/** 投递执行器会停在 failed 的固定行；运维手册与 rearm 入口只认这份清单。 */
export const DELIVERY_TERMINAL_JOBS = [
  "delivery:backoff",
  "delivery:occurrence-backoff",
  "delivery:budget-backoff",
  "delivery:dispatch-backoff",
  "delivery:dispatch",
] as const;
export interface SourceStateRow {
  source_id: string;
  verification_state: string | null;
  last_success_at: number | null;
  updated_at: number | null;
  job_status: string | null;
  job_last_error: string | null;
  job_attempts: number | null;
}

async function safe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
/** 来源维护锁与来源待办的当前状态，只读固定注册表行；观测页与运行开关页共用。 */
export function readSourceStates(db: D1Database): Promise<SourceStateRow[] | null> {
  return safe(
    async () =>
      (
        await db
          .prepare(
            `SELECT r.value AS source_id, s.verification_state, s.last_success_at, s.updated_at,
       j.status AS job_status, j.last_error AS job_last_error, j.attempts AS job_attempts
     FROM json_each(?) r LEFT JOIN sources s ON s.source_id = r.value
     LEFT JOIN jobs j ON j.id = 'pipeline:source:' || r.value ORDER BY r.key`,
          )
          .bind(JSON.stringify(SOURCE_REGISTRY.map((entry) => entry.sourceId)))
          .all<SourceStateRow>()
      ).results,
  );
}
export async function readObservability(db: D1Database, now: number) {
  const day = utcDayPeriod(now);
  const one = (sql: string, ...args: (string | number)[]) =>
    safe(() =>
      db
        .prepare(sql)
        .bind(...args)
        .first<Record<string, number | null>>(),
    );
  const many = (sql: string, ...args: (string | number)[]) =>
    safe(
      async () =>
        (
          await db
            .prepare(sql)
            .bind(...args)
            .all()
        ).results,
    );
  const ledger = await safe(() => readMailDayLedger(db, day.key));
  const pools = ledger ? observedMailPools(ledger) : null;
  const depleted = Object.fromEntries(
    await Promise.all(
      (["auth", "signup", "base", "urgent"] as const).map(async (pool) => [
        pool,
        await safe(async () => {
          const r = await db
            .prepare("SELECT value_json FROM system_state WHERE key=?")
            .bind(`obs:depleted:${pool}`)
            .first<{ value_json: string }>();
          if (!r) return null;
          const v = JSON.parse(r.value_json);
          return v.day === day.key &&
            Number.isSafeInteger(v.at) &&
            v.at >= day.startMs &&
            v.at < day.endMsExclusive
            ? v.at
            : null;
        }),
      ]),
    ),
  );
  const controls = await readControls(db);
  const metrics = Object.fromEntries(
    await Promise.all(OBS_METRICS.map(async (id) => [id, await readMetric(db, id, now)] as const)),
  );
  const sources = await Promise.all(
    [...new Set(SOURCE_REGISTRY.flatMap((e) => e.approvedHosts))].map(async (host) => ({
      host,
      truncated: await readMetric(db, "source_response_truncated", now, host),
    })),
  );
  const activity = await one(
    "SELECT SUM(failures) AS failures,MAX(last_success_at) AS last_success_at FROM activity_write_failures WHERE utc_day=?",
    day.key,
  );
  const reclaim = await readReclaimGate(db, now);
  const feedback = await one(
    "SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN mail_outbox_id IS NULL THEN 1 ELSE 0 END),0) AS unmatched FROM mail_feedback",
  );
  const feedbackExpired = await many(
    "SELECT key,CAST(value_json AS INTEGER) AS count FROM system_state WHERE key IN (SELECT value FROM json_each(?))",
    JSON.stringify(feedbackExpiredKeys),
  );
  const feedbackGrowth = await safe(async () => {
    const row = await db
      .prepare("SELECT value_json,updated_at FROM system_state WHERE key='obs:feedback_growth'")
      .first<{ value_json: string; updated_at: number }>();
    if (!row) return null;
    const v = JSON.parse(row.value_json);
    return {
      count: typeof v.count === "number" ? v.count : null,
      delta: typeof v.delta === "number" ? v.delta : null,
      observed_at: row.updated_at,
    };
  });
  // 含执行器核心与发生项退避：核心停下会关闭全部外发（含验证码），不能只看业务批次。
  const failedJobs = await many(
    "SELECT id,status,last_error,attempts,updated_at FROM jobs WHERE id IN (SELECT value FROM json_each(?)) AND status='failed'",
    JSON.stringify(DELIVERY_TERMINAL_JOBS),
  );
  // 来源维护锁与来源待办终态按当前状态持续告警（不依赖当日指标槽）。
  const sourceStates = await readSourceStates(db);
  const retry = await safe(async () => {
    const r = await db
      .prepare("SELECT value_json FROM system_state WHERE key='mail_retry_budget_not_scheduled'")
      .first<{ value_json: string }>();
    if (!r) return null;
    const v = JSON.parse(r.value_json);
    return typeof v.count === "number"
      ? {
          count: v.count,
          purposes: Object.fromEntries(
            MAIL_POOLS.map((p) => [p, typeof v[p] === "number" ? v[p] : null]),
          ),
        }
      : null;
  });
  const pipeline = await one(
    "SELECT COUNT(*) AS pending,MIN(created_at) AS oldest_at FROM outbox WHERE topic='snapshot_rebuild' AND dispatch_state='pending'",
  );
  const population = await one(
    "SELECT (SELECT value FROM capacity_state WHERE key='accounts_total') AS accounts,(SELECT COUNT(*) FROM email_channels WHERE enabled=1) AS seats,(SELECT COUNT(*) FROM email_channels WHERE enabled=1 AND routine_enabled=1) AS routine_seats",
  );
  const authQueue = await one(
    "SELECT COUNT(*) AS waiting,MIN(created_at) AS oldest_at FROM mail_outbox WHERE purpose IN ('existing_auth','new_registration') AND status IN ('pending','leased','retry_wait')",
  );
  const waiting = await many(
    "SELECT priority,COUNT(*) AS count,MIN(created_at) AS oldest_at FROM deliveries WHERE status='pending' GROUP BY priority ORDER BY priority",
  );
  // 原因只公开闭合状态聚合，不读取可能被历史实现写入的任意原因文本。
  const skipped = await many(
    "SELECT status,CASE WHEN skip_reason IN (SELECT value FROM json_each(?)) THEN skip_reason ELSE 'unknown' END AS reason,COUNT(*) AS count FROM deliveries WHERE status IN ('skipped','superseded','expired') AND updated_at>=? GROUP BY status,reason",
    JSON.stringify(OBS_DELIVERY_REASONS),
    day.startMs,
  );
  const mail = await one(
    "SELECT (SELECT COUNT(*) FROM mail_outbox WHERE status='unknown') AS unknown_count,(SELECT COUNT(*) FROM suppressions WHERE expires_at IS NULL OR expires_at>?) AS suppressed",
    now,
  );
  const platform = await Promise.all(
    PLATFORM_METRICS.map(async (metric) => ({
      metric,
      fact: await safe(async () => {
        const row = await db
          .prepare("SELECT value_json FROM system_state WHERE key=?")
          .bind(`obs:platform:${metric}`)
          .first<{ value_json: string }>();
        if (!row) return null;
        const parsed = PlatformFactSchema.safeParse(JSON.parse(row.value_json));
        return parsed.success &&
          parsed.data.metric === metric &&
          parsed.data.observed_at <= now &&
          parsed.data.period_end > now
          ? parsed.data
          : null;
      }),
    })),
  );
  const alerts: { code: string; state: "alert" | "clear" | "unknown" }[] = [];
  const alert = (code: string, value: boolean | null) =>
    alerts.push({ code, state: value === null ? "unknown" : value ? "alert" : "clear" });
  alert("auth_floor", pools ? pools.auth.floor_engaged : null);
  alert("urgent_floor", pools ? pools.urgent.floor_engaged : null);
  for (const pool of ["auth", "signup", "base", "urgent"] as const)
    alert(`pool_exhausted:${pool}`, pools ? pools[pool].remaining === 0 : null);
  for (const metric of [
    "feed_shrink_guard",
    "snapshot_build_failed",
    "mail_provider_unknown",
    "delivery_budget_failed",
    "delivery_dispatch_failed",
    "feedback_maintenance_failed",
  ] as const)
    alert(metric, metrics[metric] ? metrics[metric].count > 0 : null);
  for (const source of sources)
    alert(
      `source_response_truncated:${source.host}`,
      source.truncated ? source.truncated.count > 0 : null,
    );
  alert(
    "activity_write_failures",
    activity?.failures === null || activity?.failures === undefined ? null : activity.failures > 0,
  );
  alert(
    "reclaim_paused",
    reclaim.accounts_paused ||
      reclaim.seats_paused ||
      controls.account_reclaim_enabled !== true ||
      controls.seat_reclaim_enabled !== true,
  );
  alert(
    "snapshot_lag",
    pipeline === null
      ? null
      : typeof pipeline.oldest_at === "number" && now - pipeline.oldest_at >= FEED_MAX_STALE * 1000,
  );
  alert("mail_retry_budget_not_scheduled", retry === null ? null : retry.count > 0);
  alert("delivery_failed_jobs", failedJobs === null ? null : failedJobs.length > 0);
  for (const entry of SOURCE_REGISTRY) {
    const row = sourceStates?.find((state) => state.source_id === entry.sourceId) ?? null;
    alert(
      `source_maintenance:${entry.sourceId}`,
      sourceStates === null ? null : row?.verification_state === "maintenance-required",
    );
    alert(
      `source_job_failed:${entry.sourceId}`,
      sourceStates === null ? null : row?.job_status === "failed",
    );
  }
  alert("unmatched_expired", feedbackGrowth?.delta == null ? null : feedbackGrowth.delta > 0);
  alert(
    "feedback_capacity",
    feedback === null ? null : Number(feedback.total) >= MAIL_FEEDBACK_MAX,
  );
  alert(
    "unmatched_capacity",
    feedback === null ? null : Number(feedback.unmatched) >= MAIL_UNMATCHED_MAX,
  );
  alert(
    "feedback_approaching_capacity",
    capacityWarning(feedback?.total ?? null, MAIL_FEEDBACK_MAX),
  );
  alert(
    "unmatched_approaching_capacity",
    capacityWarning(feedback?.unmatched ?? null, MAIL_UNMATCHED_MAX),
  );
  for (const entry of platform)
    alert(
      `platform:${entry.metric}`,
      entry.fact === null
        ? null
        : entry.metric === "queue_dlq_backlog" || entry.metric === "bill_extra_charge"
          ? entry.fact.value > 0
          : entry.fact.included === undefined
            ? null
            : capacityWarning(entry.fact.value, entry.fact.included),
    );
  alert(
    "mail_merge_integrity",
    ratioIntegrityAlert(
      metrics.mail_delivery_items?.total ?? null,
      metrics.mail_call?.count ?? null,
    ),
  );
  alert(
    "seat_release_without_renewal_observation",
    metrics.seat_released === null ? null : metrics.seat_renewed === null,
  );
  return {
    server_time: now,
    utc_day: day.key,
    pools,
    pool_depleted_at: depleted,
    controls,
    metrics,
    sources,
    activity,
    reclaim: {
      ...reclaim,
      accounts_paused: reclaim.accounts_paused || controls.account_reclaim_enabled !== true,
      seats_paused: reclaim.seats_paused || controls.seat_reclaim_enabled !== true,
    },
    feedback,
    feedback_expired: feedbackExpired,
    feedback_growth: feedbackGrowth,
    feed_integrity: {
      shrink_guard_hits: metrics.feed_shrink_guard?.count ?? null,
      blocked_responses: metrics.feed_shrink_guard?.count ?? null,
      status: 503,
    },
    retry,
    failed_jobs: failedJobs,
    source_states: sourceStates,
    pipeline,
    population,
    auth_queue: authQueue,
    priority_waiting:
      waiting?.map((row) => ({
        ...row,
        wait_ms: typeof row.oldest_at === "number" ? Math.max(0, now - row.oldest_at) : null,
      })) ?? null,
    skipped,
    mail,
    platform,
    mail_merge_ratio: observedRatio(
      metrics.mail_delivery_items?.total ?? null,
      metrics.mail_call?.count ?? null,
    ),
    seat_renew_release_ratio: observedRatio(
      metrics.seat_renewed?.count ?? null,
      metrics.seat_released?.count ?? null,
    ),
    alerts,
  };
}
