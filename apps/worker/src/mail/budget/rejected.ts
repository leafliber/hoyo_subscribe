// P4-04 验收方裁定：已外调的可重试拒绝不自动取得新预算；计数一次，到期结束。
import { MATCH_PAGE } from "@hoyo/contracts";
import { logEvent } from "../../shell/logger";
import { conditionalCommit } from "../../storage/cas";
import { transitionMail } from "../outbox/state";
import { type MailRow, mailJobId } from "../outbox/types";
export const RETRY_BUDGET_NOT_SCHEDULED = "retry_budget_not_scheduled";
// 一个固定计数行，不按收件人建遥测键、不累积逐日历史。各用途字段仅用于 P5 告警。
export const RETRY_COUNTER_KEY = "mail_retry_budget_not_scheduled";
const REJECTED_FROM = `FROM mail_outbox o LEFT JOIN jobs j ON j.id='delivery:mail:'||o.id
  WHERE o.status='retry_wait' AND o.sent_at IS NOT NULL`;
export const MAIL_INTENT_EXPIRES_SQL = `CASE WHEN o.payload_kind='notification_digest' THEN
  COALESCE((SELECT MAX(expires_at) FROM deliveries WHERE mail_outbox_ref=o.id),?) ELSE
  COALESCE((SELECT deadline FROM auth_challenges WHERE id=o.payload_ref),
    (SELECT deadline FROM recent_auth_challenges WHERE id=o.payload_ref),?) END`;
export const REJECTED_RETRY_SQL = `SELECT o.*, ${MAIL_INTENT_EXPIRES_SQL} AS expires_at ${REJECTED_FROM}
  AND (COALESCE(json_extract(j.payload_json,'$.retry_budget_not_scheduled'),0)=0 OR (${MAIL_INTENT_EXPIRES_SQL})<=?)
  ORDER BY o.priority,o.created_at,o.id LIMIT ?`;
export async function finishRejectedRetryPage(db: D1Database, now: number): Promise<number> {
  const rows = (
    await db
      .prepare(REJECTED_RETRY_SQL)
      .bind(now, now, now, now, now, MATCH_PAGE)
      .all<MailRow & { expires_at: number }>()
  ).results;
  for (const row of rows) {
    const result = await conditionalCommit(db, {
      preamble: [
        {
          sql: `INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'{"count":0}',?) ON CONFLICT(key) DO NOTHING`,
          params: [RETRY_COUNTER_KEY, now],
        },
      ],
      guard: {
        sql: `UPDATE jobs SET payload_json=json_set(payload_json,'$.retry_budget_not_scheduled',1),last_error=?,updated_at=?
        WHERE id=? AND COALESCE(json_extract(payload_json,'$.retry_budget_not_scheduled'),0)=0
        AND EXISTS (SELECT 1 FROM mail_outbox WHERE id=? AND status='retry_wait' AND sent_at IS NOT NULL AND lease_version=? AND lease_owner IS ?)`,
        params: [
          RETRY_BUDGET_NOT_SCHEDULED,
          now,
          mailJobId(row.id),
          row.id,
          row.lease_version,
          row.lease_owner,
        ],
      },
      effects: [
        {
          kind: "update",
          table: "system_state",
          set: {
            value_json: {
              sql: `json_set(value_json,'$.count',COALESCE(json_extract(value_json,'$.count'),0)+1,?,COALESCE(json_extract(value_json,?),0)+1)`,
              params: [`$.${row.purpose}`, `$.${row.purpose}`],
            },
            updated_at: now,
          },
          where: { sql: "key=?", params: [RETRY_COUNTER_KEY] },
        },
      ],
    });
    if (result.outcome === "committed")
      logEvent("warn", "mail_retry_not_scheduled", {
        reason_code: RETRY_BUDGET_NOT_SCHEDULED,
        count: 1,
      });
    if (row.expires_at <= now)
      await transitionMail(db, row, now, { status: "expired", reason: RETRY_BUDGET_NOT_SCHEDULED });
  }
  return rows.length;
}
export async function nextRejectedRetryAlarm(db: D1Database, now: number): Promise<number | null> {
  const result = await db
    .prepare(
      `SELECT MIN(CASE WHEN COALESCE(json_extract(j.payload_json,'$.retry_budget_not_scheduled'),0)=0 THEN ? ELSE (${MAIL_INTENT_EXPIRES_SQL}) END) AS due ${REJECTED_FROM}`,
    )
    .bind(now, now, now)
    .first<{ due: number | null }>();
  return result?.due ?? null;
}
