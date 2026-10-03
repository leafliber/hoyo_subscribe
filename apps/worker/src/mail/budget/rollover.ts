// P4-04 · 旧日未调用预留先撤回；未取得新日预算的发送意图仍保留。

import {
  AUTH_MAIL_POOLS,
  MATCH_PAGE,
  type MailIntentKind,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  planMailReservation,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { classifyPipelineFailure } from "../../executors/pipeline/failure";
import { logEvent } from "../../shell/logger";
import { recordMetric } from "../../shell/observability/metrics";
import { conditionalCommit } from "../../storage/cas";
import {
  insertUsageRowStatement,
  mailBudgetCapacityPredicate,
  mailReservationTransitionEffects,
  mailReservationTransitionPredicate,
  reserveMailBudgetEffects,
} from "../../storage/ledger/mail-ledger";
import { occurrencePriority } from "../occurrences/eligibility";
import { transitionMail } from "../outbox/state";
import { MailDataError, type MailRow, mailJobId } from "../outbox/types";
import { MAIL_INTENT_EXPIRES_SQL } from "./rejected";

// 按状态索引排除全部已调用终态历史；拒绝项由自己的 job.due_at 退避，不霸占分页首位。
export const ROLLOVER_CANDIDATES_SQL = `SELECT o.* FROM mail_outbox o
  LEFT JOIN jobs j ON j.id='delivery:mail:' || o.id
  WHERE o.status IN ('pending','leased','retry_wait') AND o.sent_at IS NULL AND o.period_key<>?
    AND (j.status IS NULL OR j.status<>'failed')
    AND (j.last_error IS NULL OR j.last_error NOT LIKE 'budget_%' OR j.due_at<=?)
  ORDER BY o.priority,o.created_at,o.id LIMIT ?`;
const isAuth = (row: MailRow) => (AUTH_MAIL_POOLS as readonly string[]).includes(row.purpose);
function ref(row: MailRow, now: number) {
  if (!isAuth(row) && row.recipient_user_id === null)
    throw new MailDataError("budget_owner_missing");
  return {
    pool: row.purpose,
    periodKey: row.period_key,
    now,
    ...(isAuth(row) ? {} : { userId: row.recipient_user_id as string }),
  };
}
function identity(row: MailRow) {
  return {
    sql: "id=? AND status=? AND lease_version=? AND lease_owner IS ? AND period_key=? AND sent_at IS NULL",
    params: [row.id, row.status, row.lease_version, row.lease_owner, row.period_key],
  };
}
function job(row: MailRow, now: number) {
  return {
    sql: `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at)
    VALUES (?,'mail_send','{}',?,'pending',?,?) ON CONFLICT(id) DO NOTHING`,
    params: [mailJobId(row.id), now, now, now],
  };
}
export async function releaseOldReservation(
  db: D1Database,
  row: MailRow,
  now: number,
): Promise<boolean> {
  if (
    !["pending", "leased", "retry_wait"].includes(row.status) ||
    row.sent_at !== null ||
    row.period_key === OUTBOX_UNRESERVED_PERIOD_KEY ||
    row.period_key === utcDayPeriod(now).key
  )
    return false;
  const same = identity(row),
    old = ref(row, now);
  const budget = mailReservationTransitionPredicate(old, "release");
  const result = await conditionalCommit(db, {
    preamble: [job(row, now)],
    guard: {
      sql: `UPDATE mail_outbox SET period_key=?,status='pending',lease_version=lease_version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${same.sql} AND (${budget.sql})`,
      params: [OUTBOX_UNRESERVED_PERIOD_KEY, now, ...same.params, ...budget.params],
    },
    effects: [
      ...mailReservationTransitionEffects(old, "release"),
      {
        kind: "update",
        table: "jobs",
        set: {
          status: "pending",
          due_at: now,
          completed_at: null,
          updated_at: now,
          last_error: "budget_day_rollover",
        },
        where: { sql: "id=?", params: [mailJobId(row.id)] },
      },
    ],
  });
  return result.outcome === "committed";
}
async function intentFor(db: D1Database, row: MailRow): Promise<MailIntentKind> {
  switch (row.purpose) {
    case "new_registration":
      return "signup_auth";
    case "existing_auth": {
      const challenge = await db
        .prepare("SELECT purpose,generation FROM auth_challenges WHERE id=?")
        .bind(row.payload_ref)
        .first<{ purpose: string; generation: number }>();
      if (!challenge) return "account_change_auth";
      return challenge.purpose === "login" && challenge.generation === 0
        ? "existing_auth_first_login"
        : "auth_resend";
    }
    case "base_business":
      return "base_routine_or_announce";
    case "urgent_business":
      if (row.priority === occurrencePriority("cancelled_or_retracted"))
        return "urgent_cancelled_or_retracted";
      if (row.priority === occurrencePriority("important_change")) return "urgent_important_change";
      if (row.priority === occurrencePriority("late_discovery")) return "urgent_late_discovery";
      throw new MailDataError("budget_priority");
  }
}
export async function reserveUnsentIntent(
  db: D1Database,
  row: MailRow,
  now: number,
): Promise<boolean> {
  if (
    row.period_key !== OUTBOX_UNRESERVED_PERIOD_KEY ||
    row.sent_at !== null ||
    row.status !== "pending"
  )
    return false;
  const expiry = await db
    .prepare(`SELECT (${MAIL_INTENT_EXPIRES_SQL}) AS expires_at FROM mail_outbox o WHERE o.id=?`)
    .bind(now, now, row.id)
    .first<{ expires_at: number }>();
  if (!expiry || expiry.expires_at <= now) {
    await transitionMail(db, row, now, { status: "expired", reason: "budget_wait_expired" });
    return false;
  }
  const period = utcDayPeriod(now),
    reservation = planMailReservation(await intentFor(db, row));
  const target = { ...ref(row, now), periodKey: period.key };
  const capacity = mailBudgetCapacityPredicate(reservation, period.key, target.userId),
    same = identity(row);
  const result = await conditionalCommit(db, {
    preamble: [
      job(row, now),
      insertUsageRowStatement(target.pool, period, now),
      ...(target.userId ? [insertUsageRowStatement(target.pool, period, now, target.userId)] : []),
    ],
    guard: {
      sql: `UPDATE mail_outbox SET period_key=?,lease_version=lease_version+1,updated_at=? WHERE ${same.sql} AND (${capacity.sql})`,
      params: [period.key, now, ...same.params, ...capacity.params],
    },
    effects: reserveMailBudgetEffects(target),
  });
  if (result.outcome === "condition_missed") {
    await db
      .prepare(`UPDATE jobs SET due_at=?,updated_at=?,last_error='budget_wait' WHERE id=? AND EXISTS
      (SELECT 1 FROM mail_outbox WHERE id=? AND period_key=? AND status='pending' AND lease_version=?)`)
      .bind(
        Math.min(expiry.expires_at, period.endMsExclusive, now + WATCHDOG_INTERVAL * 1000),
        now,
        mailJobId(row.id),
        row.id,
        OUTBOX_UNRESERVED_PERIOD_KEY,
        row.lease_version,
      )
      .run();
  }
  return result.outcome === "committed";
}
export async function rolloverBudgetPage(db: D1Database, now: number): Promise<number> {
  const rows = (
    await db
      .prepare(ROLLOVER_CANDIDATES_SQL)
      .bind(utcDayPeriod(now).key, now, MATCH_PAGE)
      .all<MailRow>()
  ).results;
  for (const row of rows) {
    try {
      if (row.period_key !== OUTBOX_UNRESERVED_PERIOD_KEY) {
        if (!(await releaseOldReservation(db, row, now))) continue;
      }
      const fresh = await db
        .prepare("SELECT * FROM mail_outbox WHERE id=?")
        .bind(row.id)
        .first<MailRow>();
      if (fresh) await reserveUnsentIntent(db, fresh, now);
    } catch (error) {
      const failure =
        error instanceof MailDataError
          ? { terminal: true, reason: "invalid_data" }
          : classifyPipelineFailure(error);
      const initial = job(row, now);
      await db.batch([
        db.prepare(initial.sql).bind(...initial.params),
        db
          .prepare(
            `UPDATE jobs SET status=?,due_at=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?`,
          )
          .bind(
            failure.terminal ? "failed" : "pending",
            now + WATCHDOG_INTERVAL * 1000,
            `budget_${failure.reason}`,
            now,
            mailJobId(row.id),
          ),
      ]);
      await recordMetric(db, "delivery_budget_failed", now);
      logEvent("error", "delivery_budget_failed", { reason_code: failure.reason });
    }
  }
  return rows.length;
}
export async function nextRolloverAlarm(db: D1Database, now: number): Promise<number | null> {
  const row = await db
    .prepare(`SELECT MIN(CASE WHEN j.last_error LIKE 'budget_%' THEN COALESCE(j.due_at,?) ELSE ? END) AS due
    FROM mail_outbox o LEFT JOIN jobs j ON j.id='delivery:mail:' || o.id
    WHERE o.status IN ('pending','leased','retry_wait') AND o.sent_at IS NULL AND o.period_key<>?
      AND (j.status IS NULL OR j.status<>'failed')`)
    .bind(now, now, utcDayPeriod(now).key)
    .first<{ due: number | null }>();
  // 同日尚未调用的意图也需要在日界醒来，不能靠 nextAlarm 的领取查询跨日后才发现。
  const unsent = await db
    .prepare(
      `SELECT id FROM mail_outbox WHERE status IN ('pending','leased','retry_wait') AND sent_at IS NULL AND period_key=? LIMIT 1`,
    )
    .bind(utcDayPeriod(now).key)
    .first();
  return row?.due ?? (unsent ? utcDayPeriod(now).endMsExclusive : null);
}
