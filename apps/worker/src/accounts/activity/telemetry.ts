// P3-07：失败采用持久全局闭锁；成功水位不能证明漏写的其他账号已补齐。
// P5-02 必须在账号与席位回收前调用 readReclaimGate；修复/补齐后由维护者解除 reclaim_paused。
import { activityTelemetryStale, utcDayPeriod } from "@hoyo/contracts";
import { logEvent } from "../../shell/logger";
import { readControl } from "../../shell/observability/controls";

const failedLocally = new WeakSet<D1Database>();
export async function recordActivityFailure(db: D1Database, now: number): Promise<void> {
  failedLocally.add(db);
  logEvent("error", "activity_write_failures", { count: 1 });
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO activity_write_failures(metric,utc_day,failures,updated_at)
        VALUES ('feed_poll_merge',?,1,?) ON CONFLICT(metric,utc_day) DO UPDATE
        SET failures=failures+1, updated_at=MAX(updated_at,excluded.updated_at)`)
        .bind(utcDayPeriod(now).key, now),
      db
        .prepare(`INSERT INTO system_state(key,value_json,updated_at) VALUES ('reclaim_paused','true',?)
        ON CONFLICT(key) DO UPDATE SET value_json='true', updated_at=excluded.updated_at`)
        .bind(now),
    ]);
    failedLocally.delete(db); // 持久闸门已接管；不自动解除它。
  } catch {
    logEvent("error", "activity_telemetry_unavailable", { count: 1 });
  }
}
export async function readReclaimGate(db: D1Database, now: number) {
  try {
    const row = await db
      .prepare(`SELECT
      (SELECT value_json FROM system_state WHERE key='reclaim_paused') AS paused,
      (SELECT last_success_at FROM activity_write_failures WHERE metric='feed_poll_merge' AND last_success_at IS NOT NULL ORDER BY utc_day DESC LIMIT 1) AS last_success_at`)
      .first<{ paused: string | null; last_success_at: number | null }>();
    const paused =
      failedLocally.has(db) ||
      row === null ||
      row.paused !== "false" ||
      activityTelemetryStale(row.last_success_at, now);
    return {
      accounts_paused: paused || (await readControl(db, "account_reclaim_enabled")).value !== true,
      seats_paused: paused || (await readControl(db, "seat_reclaim_enabled")).value !== true,
      last_success_at: row?.last_success_at ?? null,
    };
  } catch {
    return { accounts_paused: true, seats_paused: true, last_success_at: null };
  }
}
