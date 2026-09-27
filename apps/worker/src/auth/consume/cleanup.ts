// P2-03 · 挑战/回执短期密文清理原语（主方案 §4.3、§4.4；2026-09-27 裁定）。
// P2-04 激活事务必须把 activatedReceiptClearEffect 放进同一 conditionalCommit，
// 激活 guard 同时要求该会话存在未过期回执；本卡不实现激活。

import { type MailPool, OUTBOX_UNRESERVED_PERIOD_KEY } from "@hoyo/contracts";
import type { GuardedEffect } from "../../storage/cas";
import { transitionMailReservation } from "../../storage/ledger/mail-ledger";

interface OutboxRow {
  readonly id: string;
  readonly purpose: MailPool;
  readonly period_key: string;
  readonly status: string;
}

/** 已消费/终止/过期挑战的 OTP 载荷即时清除；未外发预留归还。 */
export async function clearTerminalOtpPayloads(
  db: D1Database,
  now: number,
  challengeId?: string,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT o.id, o.purpose, o.period_key, o.status FROM mail_outbox o
         JOIN auth_challenges c ON c.id = o.payload_ref
        WHERE o.payload_ciphertext IS NOT NULL
          AND (c.consumed_at IS NOT NULL OR c.aborted_at IS NOT NULL OR c.deadline <= ?)
          AND (? IS NULL OR c.id = ?)`,
    )
    .bind(now, challengeId ?? null, challengeId ?? null)
    .all<OutboxRow>();
  let cleared = 0;
  for (const row of rows.results ?? []) {
    const neverSent = row.status === "pending" || row.status === "leased";
    const result = await db
      .prepare(
        `UPDATE mail_outbox
            SET payload_ciphertext = NULL,
                status = CASE WHEN status IN ('pending','leased') THEN 'superseded' ELSE status END,
                updated_at = ?
          WHERE id = ? AND payload_ciphertext IS NOT NULL`,
      )
      .bind(now, row.id)
      .run();
    if (result.meta.changes !== 1) continue;
    cleared += 1;
    if (neverSent && row.period_key !== OUTBOX_UNRESERVED_PERIOD_KEY) {
      await transitionMailReservation(
        db,
        { pool: row.purpose, periodKey: row.period_key, now },
        "release",
      );
    }
  }
  return cleared;
}

/** 到期兜底：回执与挑战地址密文均按各自生命周期清空。 */
export async function clearExpiredAuthMaterials(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE auth_challenges SET receipt_ciphertext = NULL, receipt_expires_at = NULL,
              updated_at = ? WHERE receipt_ciphertext IS NOT NULL AND receipt_expires_at <= ?`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `UPDATE auth_challenges SET delivery_address_ciphertext = NULL, updated_at = ?
        WHERE delivery_address_ciphertext IS NOT NULL
          AND (consumed_at IS NOT NULL OR aborted_at IS NOT NULL OR deadline <= ?)`,
    )
    .bind(now, now)
    .run();
  await clearTerminalOtpPayloads(db, now);
}

/** P2-04 激活 CAS 的依赖效果：pending→active 与回执清空在同一个 batch 中提交。 */
export function activatedReceiptClearEffect(sessionId: string, now: number): GuardedEffect {
  return {
    kind: "update",
    table: "auth_challenges",
    set: { receipt_ciphertext: null, receipt_expires_at: null, updated_at: now },
    where: {
      sql: "pending_session_id = ? AND receipt_ciphertext IS NOT NULL",
      params: [sessionId],
    },
  };
}
