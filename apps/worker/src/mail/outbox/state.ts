// P4-03 · 所有写回均携带 outbox 租约；jobs 仅保存原因、重试时间和供应商回执。
// 复用现有表，无迁移；accepted 与收件服务器接受分别在 outbox.status 和 jobs.payload_json。
import {
  AUTH_MAIL_POOLS,
  BUDGET_PERIOD_KIND,
  type DeliveryStatus,
  EXECUTOR_BATCH_WALL_LIMIT,
  MATCH_PAGE,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { conditionalCommit, type GuardedEffect, type SqlParam } from "../../storage/cas";
import { type MailRow, mailJobId } from "./types";

const auth = (row: MailRow) => (AUTH_MAIL_POOLS as readonly string[]).includes(row.purpose);
// 只组合账本的既有 reserved/settled/uncertain 转换；不重新判定额度，不批准新预算。
function budgetRows(row: MailRow) {
  // 缺失所有者的坏业务行不能把全局池行更新两次；保留未知用户行供对账。
  return auth(row) || row.recipient_user_id === null ? [null] : [null, row.recipient_user_id];
}
function budgetGuard(row: MailRow, column: "reserved" | "uncertain") {
  return budgetRows(row).map((user) => ({
    sql: `EXISTS (SELECT 1 FROM usage_periods WHERE pool = ? AND period_kind = ? AND period_key = ? AND user_id IS ? AND ${column} > 0)`,
    params: [row.purpose, BUDGET_PERIOD_KIND, row.period_key, user] as SqlParam[],
  }));
}
function budgetEffects(
  row: MailRow,
  from: "reserved" | "uncertain",
  to: "settled" | "uncertain" | null,
  now: number,
): GuardedEffect[] {
  return budgetRows(row).map((user) => ({
    kind: "update",
    table: "usage_periods",
    set: {
      [from]: { sql: `${from} - 1` },
      ...(to ? { [to]: { sql: `${to} + 1` } } : {}),
      updated_at: now,
    },
    where: {
      sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id IS ?",
      params: [row.purpose, BUDGET_PERIOD_KIND, row.period_key, user],
    },
  }));
}
// 导出给读放大基准与 alarm 共用，领取仍在单条 UPDATE 中判定。
export const MAIL_CLAIM_CANDIDATE_SQL = `SELECT o.id FROM mail_outbox o WHERE o.status = 'pending' AND o.period_key = ?
  AND (? IS NULL OR o.id = ?) AND EXISTS (SELECT 1 FROM usage_periods p WHERE p.pool = o.purpose
    AND p.period_kind = ? AND p.period_key = o.period_key AND p.user_id IS NULL AND p.reserved > 0)
  ORDER BY o.priority,o.created_at,o.id LIMIT 1`;
export async function claimMail(
  db: D1Database,
  owner: string,
  now: number,
  id?: string,
): Promise<MailRow | null> {
  // pending 是唯一领取入口；retry_wait 先由 watchdog 安全转回 pending。
  return db
    .prepare(`UPDATE mail_outbox SET status = 'leased',lease_version = lease_version + 1,
    lease_owner = ?,lease_expires_at = ?,updated_at = ?
    WHERE id = (${MAIL_CLAIM_CANDIDATE_SQL}) AND status = 'pending' RETURNING *`)
    .bind(
      owner,
      now + EXECUTOR_BATCH_WALL_LIMIT * 1000,
      now,
      utcDayPeriod(now).key,
      id ?? null,
      id ?? null,
      BUDGET_PERIOD_KIND,
    )
    .first<MailRow>();
}
export async function transitionMail(
  db: D1Database,
  row: MailRow,
  now: number,
  input: {
    status: DeliveryStatus;
    reason?: string;
    messageId?: string;
    budget?: { from: "reserved" | "uncertain"; to: "settled" | "uncertain" | null };
    extraGuard?: { sql: string; params: SqlParam[] };
    receipt?: string;
  },
): Promise<boolean> {
  const budget = input.budget;
  const guards = budget ? budgetGuard(row, budget.from) : [];
  const calling = input.status === "calling_provider";
  const retry = input.status === "retry_wait";
  const outcome = await conditionalCommit(db, {
    preamble: [
      {
        sql: `INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at)
      VALUES (?,'mail_send','{}',?,'pending',?,?) ON CONFLICT(id) DO NOTHING`,
        params: [mailJobId(row.id), now, now, now],
      },
    ],
    guard: {
      sql: `UPDATE mail_outbox SET status = ?,message_id = COALESCE(?,message_id),updated_at = ?,
        attempts = attempts + ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END,
        payload_ciphertext = CASE WHEN ? THEN NULL ELSE payload_ciphertext END,
        lease_owner = CASE WHEN ? THEN lease_owner ELSE NULL END,
        lease_expires_at = CASE WHEN ? THEN lease_expires_at WHEN ? THEN ? ELSE NULL END
        WHERE id = ? AND status = ? AND lease_version = ? AND lease_owner IS ?
          ${calling ? "AND lease_expires_at > ? AND period_key = ?" : ""}
          ${guards.map((g) => `AND ${g.sql}`).join(" ")}
          ${input.extraGuard ? `AND (${input.extraGuard.sql})` : ""}`,
      params: [
        input.status,
        input.messageId ?? null,
        now,
        Number(calling),
        Number(calling),
        now,
        Number(calling || (!retry && input.status !== "leased")),
        Number(calling),
        Number(calling),
        Number(retry),
        now + WATCHDOG_INTERVAL * 1000,
        row.id,
        row.status,
        row.lease_version,
        row.lease_owner,
        ...(calling ? [now, utcDayPeriod(now).key] : []),
        ...guards.flatMap((g) => g.params),
        ...(input.extraGuard?.params ?? []),
      ],
    },
    effects: [
      ...(budget ? budgetEffects(row, budget.from, budget.to, now) : []),
      {
        kind: "update",
        table: "jobs",
        set: {
          status: calling
            ? "leased"
            : retry
              ? "pending"
              : input.status === "failed"
                ? "failed"
                : "done",
          payload_json: JSON.stringify({
            provider_status:
              input.receipt ?? (input.status === "accepted" ? "submitted" : input.status),
          }),
          lease_version: row.lease_version,
          lease_owner: calling ? row.lease_owner : null,
          lease_expires_at: calling ? row.lease_expires_at : null,
          due_at: retry ? now + WATCHDOG_INTERVAL * 1000 : now,
          attempts: { sql: "attempts + 1" },
          last_error: input.reason ?? null,
          updated_at: now,
          completed_at: calling || retry ? null : now,
        },
        where: { sql: "id = ?", params: [mailJobId(row.id)] },
      },
      {
        kind: "update",
        table: "deliveries",
        set: { status: input.status, skip_reason: input.reason ?? null, updated_at: now },
        where: {
          sql: "mail_outbox_ref = ? AND status IN ('pending','leased','calling_provider','retry_wait','unknown','accepted','deferred')",
          params: [row.id],
        },
        allowZeroRowsIfLast: true,
      },
    ],
  });
  return outcome.outcome === "committed";
}
export async function repairMailPage(db: D1Database, now: number): Promise<number> {
  const rows = (
    await db
      .prepare(`SELECT * FROM mail_outbox WHERE lease_expires_at <= ?
    AND status IN ('leased','calling_provider','retry_wait') ORDER BY lease_expires_at LIMIT ?`)
      .bind(now, MATCH_PAGE)
      .all<MailRow>()
  ).results;
  for (const row of rows) {
    if (row.status === "calling_provider") {
      await transitionMail(db, row, now, { status: "unknown", reason: "calling_lease_expired" });
    } else if (row.status === "leased" || (row.status === "retry_wait" && row.sent_at === null)) {
      await db
        .prepare(`UPDATE mail_outbox SET status = 'pending',lease_version = lease_version + 1,
        lease_owner = NULL,lease_expires_at = NULL,updated_at = ? WHERE id = ? AND status = ? AND lease_version = ? AND lease_expires_at <= ?`)
        .bind(now, row.id, row.status, row.lease_version, now)
        .run();
    } else {
      // 明确拒绝之后需要一次新预算。P4-04 接线前不自动批准，也不反复扫描。
      await db
        .prepare(
          `UPDATE mail_outbox SET lease_expires_at = NULL WHERE id = ? AND status = 'retry_wait' AND lease_version = ?`,
        )
        .bind(row.id, row.lease_version)
        .run();
    }
  }
  return rows.length;
}
// 受控 Queue/对账的状态写原语；事件校验、eventId 去重与抑制归 P4-07。
export async function recordMailReceipt(
  db: D1Database,
  messageId: string,
  receipt: "delivered" | "deferred" | "bounced" | "failed" | "complained" | "rejected",
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT * FROM mail_outbox WHERE message_id = ?")
    .bind(messageId)
    .first<MailRow>();
  if (!row || !["accepted", "deferred", "unknown"].includes(row.status)) return false;
  return transitionMail(db, row, now, {
    status: receipt === "delivered" ? "accepted" : receipt,
    receipt,
    ...(row.status === "unknown"
      ? { budget: { from: "uncertain" as const, to: "settled" as const } }
      : {}),
    // 已收件服务器接受不被晚到 deferred 倒退；投诉/退信由上面的终态守卫保护。
    extraGuard: {
      sql: `(? <> 'deferred' OR NOT EXISTS (SELECT 1 FROM jobs WHERE id = ? AND json_extract(payload_json,'$.provider_status') = 'delivered'))`,
      params: [receipt, mailJobId(row.id)],
    },
  });
}
export { OUTBOX_UNRESERVED_PERIOD_KEY };
