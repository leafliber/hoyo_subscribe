import {
  EXECUTOR_BATCH_WALL_LIMIT,
  MAIL_METADATA_TTL,
  MATCH_PAGE,
  PUBLIC_SNAPSHOT_WRITE_PROFILE,
  RECLAIM_QUERY_BUDGET,
} from "@hoyo/contracts";
import { readReclaimGate } from "../accounts/activity/telemetry";
import { cleanupDeletedAccountPage } from "../accounts/lifecycle/cleanup";
import { maintainSystemAuditPage } from "../accounts/reclaim/audit";
import { cleanupRetentionPage } from "../accounts/reclaim/retention";
import { scanAccountPage } from "../accounts/reclaim/service";
import { boundedDatabase, ReclaimQueryLimit } from "../executors/cron/query-budget";
import { pruneExpiredDispatchBatch } from "../mail/dispatch/expiry";
import { pruneMailJobPage } from "../mail/outbox/cleanup";
import { logEvent } from "../shell/logger";

const KEY = "reclaim:maintenance_cursor";
export async function maintainReclaim(
  db: D1Database,
  clock: () => number = Date.now,
  availableQueries: number = RECLAIM_QUERY_BUDGET,
) {
  if (availableQueries < 9 * MATCH_PAGE + 6) return { queries: 0, completed: false };
  const now = clock(),
    deadline = now + EXECUTOR_BATCH_WALL_LIMIT * 1000;
  // 留一条游标提交、至多三条原 DB 遥测读取；保留 readReclaimGate 的 isolate 失败身份。
  // 返回 queries 为保守上界；代理内执行逐条实计。
  const initialGate = await readReclaimGate(db, now);
  const budget = boundedDatabase(db, Math.min(RECLAIM_QUERY_BUDGET, availableQueries) - 4),
    bounded = budget.db;
  const raw = await bounded
    .prepare("SELECT value_json FROM system_state WHERE key=?")
    .bind(KEY)
    .first<string>("value_json");
  const cursor = raw
    ? (JSON.parse(raw) as { phase: number; after: number; dispatch_after?: string })
    : { phase: 0, after: 0 };
  const completed = new Set<number>();
  const tasks = [
    async () => {
      const rows = await scanAccountPage(bounded, now, cursor.after, initialGate);
      cursor.after = rows.at(-1)?.order ?? 0;
      if (rows.length < MATCH_PAGE) {
        cursor.after = 0;
        return false;
      }
      return true;
    },
    async () => (await maintainSystemAuditPage(bounded, now)) > 0,
    async () => (await cleanupRetentionPage(bounded, now)) > 0,
    async () => (await pruneMailJobPage(bounded, now)) > 0,
    async () => {
      const rows = (
        await bounded
          .prepare(
            "SELECT id FROM jobs WHERE kind='mail_dispatch_batch' AND created_at<=? AND id>? ORDER BY id LIMIT ?",
          )
          .bind(now - MAIL_METADATA_TTL * 1000, cursor.dispatch_after ?? "", MATCH_PAGE)
          .all<{ id: string }>()
      ).results;
      for (const row of rows) await pruneExpiredDispatchBatch(bounded, row.id, now);
      cursor.dispatch_after = rows.at(-1)?.id ?? "";
      if (rows.length < MATCH_PAGE) {
        cursor.dispatch_after = "";
        return false;
      }
      return true;
    },
    async () => {
      const row = await bounded
        .prepare(
          `SELECT id FROM users WHERE status='deleting' AND deletion_completed_at IS NULL ORDER BY updated_at,id LIMIT 1`,
        )
        .first<{ id: string }>();
      if (!row) return false;
      await cleanupDeletedAccountPage(bounded, row.id, MATCH_PAGE, now);
      await bounded
        .prepare("UPDATE users SET updated_at=? WHERE id=? AND deletion_completed_at IS NULL")
        .bind(now, row.id)
        .run();
      return true;
    },
  ];
  while (clock() < deadline && completed.size < tasks.length) {
    const phase = cursor.phase % tasks.length;
    cursor.phase = (phase + 1) % tasks.length;
    if (completed.has(phase)) continue;
    try {
      if (!(await tasks[phase]())) completed.add(phase);
    } catch (error) {
      if (error instanceof ReclaimQueryLimit) {
        logEvent("warn", "reclaim_deferred", { reason_code: "query_budget" });
        break;
      }
      completed.add(phase);
      logEvent("error", "reclaim_cleanup_failed", { reason_code: String(phase) });
    }
  }
  await db
    .prepare(
      `INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    )
    .bind(KEY, JSON.stringify(cursor), now)
    .run();
  return { queries: budget.used() + 4, completed: completed.size === tasks.length };
}

/** feedback 与回收共享一次 scheduled 调用；queryLimit 是已登记的 D1 平台事实。 */
export async function runScheduledMaintenance(
  db: D1Database,
  feedback: (database: D1Database) => Promise<void>,
  clock: () => number = Date.now,
) {
  const meter = boundedDatabase(db, PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit);
  try {
    await feedback(meter.db);
  } catch {
    logEvent("error", "scheduled_feedback_failed", { reason_code: "maintenance" });
  }
  const reclaim = await maintainReclaim(
    db,
    clock,
    PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit - meter.used(),
  );
  return {
    feedbackQueries: meter.used(),
    reclaimQueries: reclaim.queries,
    totalQueries: meter.used() + reclaim.queries,
  };
}
