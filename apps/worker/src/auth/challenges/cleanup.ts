// 过期挑战的验证码密文清除（任务卡 P2-02 §4.3 清除条款；A.5 EXPIRED_AUTH_CLEANUP）。
//
// §4.3：验证码原值只存在于短期加密发信载荷中，「接受、消费、过期或终止后清除」。
// 接受（发送结果落定）与消费（P2-03 原子消费）各自在其转换点即时清除；终止（abort /
// superseded）已在创建失败路径与重发旋转中即时清除。本模块补齐**过期**这条：
// 挑战截止已过、密文仍在的 outbox 行 → status 'expired' + payload_ciphertext 置空，
// 并归还其从未外发的当日预留（§9.1 release）。EXPIRED_AUTH_CLEANUP（24h）是清理
// 最迟时间——**过期即不能授权**，本原语只负责密文与预算的兜底回收，不延长任何授权。
// 挂接点（Cron/队列）属 P4/P5 任务卡；本卡交付原语并以测试钉住行为。

import { type MailPool, OUTBOX_UNRESERVED_PERIOD_KEY } from "@hoyo/contracts";
import { transitionMailReservation } from "../../storage/ledger/mail-ledger";

/** 一条待回收的过期发送行（及其预算归属）。 */
interface ExpiredOutboxRow {
  readonly id: string;
  readonly pool: MailPool;
  readonly periodKey: string;
}

/** 清除结果：清除的密文行数与归还的预留数（幂等：重复执行两者归零）。 */
export interface ExpiredPayloadCleanupResult {
  readonly cleared: number;
  readonly budgetReleased: number;
}

/**
 * 清除截止已过挑战的验证码密文并归还预留（幂等）。
 * 过期即不能授权（EXPIRED_AUTH_CLEANUP 只是清理最迟时间）；本原语不改动挑战行的
 * 授权语义，只回收密文与预算。
 */
export async function clearExpiredOtpPayloads(
  db: D1Database,
  now: number,
): Promise<ExpiredPayloadCleanupResult> {
  const expired = await db
    .prepare(
      `SELECT o.id, o.purpose AS pool, o.period_key AS periodKey FROM mail_outbox o
         JOIN auth_challenges c ON c.id = o.payload_ref
        WHERE c.deadline <= ? AND c.consumed_at IS NULL AND c.aborted_at IS NULL
          AND o.payload_ciphertext IS NOT NULL`,
    )
    .bind(now)
    .all<ExpiredOutboxRow>();
  const rows = expired.results ?? [];
  if (rows.length === 0) {
    return { cleared: 0, budgetReleased: 0 };
  }
  await db.batch(
    rows.map((row) =>
      db
        .prepare(
          `UPDATE mail_outbox SET status = 'expired', payload_ciphertext = NULL, updated_at = ?
            WHERE id = ? AND payload_ciphertext IS NOT NULL`,
        )
        .bind(now, row.id),
    ),
  );
  let released = 0;
  for (const row of rows) {
    if (row.periodKey === OUTBOX_UNRESERVED_PERIOD_KEY) {
      continue; // 从未预占（无预算可归还）
    }
    const outcome = await transitionMailReservation(
      db,
      { pool: row.pool, periodKey: row.periodKey, now },
      "release",
    );
    if (outcome.outcome === "committed") {
      released += 1;
    }
  }
  return { cleared: rows.length, budgetReleased: released };
}
