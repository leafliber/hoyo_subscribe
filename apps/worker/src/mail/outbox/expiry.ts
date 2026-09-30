// P4-03 · 给认证过期清理的原子适配：只归还从未越过外调边界的那一封预留。
import { OUTBOX_UNRESERVED_PERIOD_KEY } from "@hoyo/contracts";
import { transitionMail } from "./state";
import type { MailRow } from "./types";
export async function expireOtpMail(
  db: D1Database,
  id: string,
  now: number,
): Promise<{ cleared: boolean; released: boolean }> {
  const row = await db
    .prepare("SELECT * FROM mail_outbox WHERE id=? AND payload_ciphertext IS NOT NULL")
    .bind(id)
    .first<MailRow>();
  if (!row) return { cleared: false, released: false };
  const neverCalled =
    ["pending", "leased", "retry_wait"].includes(row.status) && row.sent_at === null;
  if (!neverCalled) {
    // 兼容旧存量：不把任何已经调用的结果改写为 expired，也不动其预算。
    const result = await db
      .prepare(
        `UPDATE mail_outbox SET payload_ciphertext=NULL,updated_at=? WHERE id=? AND status=? AND lease_version=? AND payload_ciphertext IS NOT NULL`,
      )
      .bind(now, id, row.status, row.lease_version)
      .run();
    return { cleared: result.meta.changes === 1, released: false };
  }
  const release = row.period_key !== OUTBOX_UNRESERVED_PERIOD_KEY;
  const changed = await transitionMail(db, row, now, {
    status: "expired",
    reason: "otp_expired",
    ...(release ? { budget: { from: "reserved" as const, to: null } } : {}),
    extraGuard: {
      sql: `payload_ciphertext IS NOT NULL AND (
      EXISTS (SELECT 1 FROM auth_challenges c WHERE c.id=mail_outbox.payload_ref AND c.deadline<=?) OR
      EXISTS (SELECT 1 FROM recent_auth_challenges c WHERE c.outbox_id=mail_outbox.id AND c.deadline<=?))`,
      params: [now, now],
    },
  });
  return { cleared: changed, released: changed && release };
}
