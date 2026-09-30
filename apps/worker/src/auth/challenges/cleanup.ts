// P4-03 所有者补充授权：修复过期清理与 calling_provider 交错造成聚合预算误退款。
// 过期挑战的验证码密文清除（任务卡 P2-02 §4.3 清除条款；A.5 EXPIRED_AUTH_CLEANUP）。
//
// §4.3：验证码原值只存在于短期加密发信载荷中，「接受、消费、过期或终止后清除」。
// 接受（发送结果落定）与消费（P2-03 原子消费）各自在其转换点即时清除；终止（abort /
// superseded）已在创建失败路径与重发旋转中即时清除。本模块补齐**过期**这条：
// 挑战截止已过、密文仍在的 outbox 行 → status 'expired' + payload_ciphertext 置空，
// 并归还其从未外发的当日预留（§9.1 release）。EXPIRED_AUTH_CLEANUP（24h）是清理
// 最迟时间——**过期即不能授权**；窗口结束后删除挑战行，不延长任何授权。
// 定时挂接归 P3-11；本卡交付原语及全部窗口结束后的物理删除。

import { OTP_COOLDOWN, OTP_TTL, utcDayPeriod } from "@hoyo/contracts";
import { expireOtpMail } from "../../mail/outbox/expiry";

/** 一条待回收的过期发送行（及其预算归属）。 */
interface ExpiredOutboxRow {
  readonly id: string;
}

/** 清除结果：清除的密文行数与归还的预留数（幂等：重复执行两者归零）。 */
export interface ExpiredPayloadCleanupResult {
  readonly cleared: number;
  readonly budgetReleased: number;
}

/**
 * 清除截止已过挑战的验证码密文并归还预留（幂等）。
 * 过期即不能授权（EXPIRED_AUTH_CLEANUP 只是清理最迟时间）；本原语不改动挑战行的
 * 授权语义；回收密文与预算后，删除所有保留窗口均已结束的挑战。
 */
export async function clearExpiredOtpPayloads(
  db: D1Database,
  now: number,
): Promise<ExpiredPayloadCleanupResult> {
  await db
    .prepare("DELETE FROM auth_resend_intents WHERE created_at < ?")
    .bind(Math.min(utcDayPeriod(now).startMs, now - Math.max(OTP_TTL, OTP_COOLDOWN) * 1_000))
    .run();
  const expired = await db
    .prepare(
      `SELECT o.id, o.purpose AS pool, o.period_key AS periodKey FROM mail_outbox o
         JOIN auth_challenges c ON c.id = o.payload_ref
        WHERE c.deadline <= ? AND c.consumed_at IS NULL AND c.aborted_at IS NULL
          AND o.payload_ciphertext IS NOT NULL
        UNION
        SELECT o.id, o.purpose AS pool, o.period_key AS periodKey FROM mail_outbox o
         JOIN recent_auth_challenges c ON c.outbox_id = o.id
        WHERE c.deadline <= ? AND c.consumed_at IS NULL AND c.aborted_at IS NULL
          AND o.payload_ciphertext IS NOT NULL`,
    )
    .bind(now, now)
    .all<ExpiredOutboxRow>();
  const rows = expired.results ?? [];
  let cleared = 0,
    released = 0;
  for (const row of rows) {
    const result = await expireOtpMail(db, row.id, now);
    if (result.cleared) cleared++;
    if (result.released) released++;
  }
  // 日意图、冷却、小时错误、挑战截止与完成回执全部结束才能删行。
  // 在载荷与预算清理之后运行，避免留下失去挑战关联的待发验证码。
  const createdBefore = Math.min(utcDayPeriod(now).startMs, now - OTP_COOLDOWN * 1_000);
  const attemptsBefore = now - 3_600 * 1_000;
  await db.batch([
    db
      .prepare(`DELETE FROM auth_challenges WHERE created_at < ? AND updated_at < ?
      AND deadline <= ? AND (receipt_expires_at IS NULL OR receipt_expires_at <= ?)`)
      .bind(createdBefore, attemptsBefore, now, now),
    db
      .prepare(`DELETE FROM recent_auth_challenges WHERE created_at < ? AND updated_at < ?
      AND deadline <= ?`)
      .bind(createdBefore, attemptsBefore, now),
  ]);
  return { cleared, budgetReleased: released };
}
