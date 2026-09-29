// P2-07：删除后的分页清理入口。P3-11 负责定时调用；只有所有页清完才释放账号存量。
// 保留邮件发送/同意/抑制的必要审计行，清除可继续发信的载荷及私人凭证和偏好。
import { ACCOUNT_DELETING_STATUS } from "@hoyo/contracts";
import { conditionalCommit } from "../../storage/cas";
import { ACCOUNTS_TOTAL_CAPACITY_KEY } from "../admission/registration";

type CleanupStep = { readonly table: string; readonly ownerColumn: string };
const STEPS: readonly CleanupStep[] = [
  { table: "recovery_rotations", ownerColumn: "user_id" },
  { table: "recent_auth_challenges", ownerColumn: "user_id" },
  { table: "recent_auth_proofs", ownerColumn: "user_id" },
  { table: "recovery_credentials", ownerColumn: "user_id" },
  { table: "auth_challenges", ownerColumn: "email_key" },
  { table: "sessions", ownerColumn: "user_id" },
  { table: "subscription_interests", ownerColumn: "user_id" },
  { table: "user_subscriptions", ownerColumn: "user_id" },
  { table: "calendar_feeds", ownerColumn: "user_id" },
  { table: "push_bindings", ownerColumn: "user_id" },
  { table: "email_channels", ownerColumn: "user_id" },
];

export type CleanupPageResult =
  | { readonly state: "progress"; readonly table: string; readonly removed: number }
  | { readonly state: "complete" };

export async function cleanupDeletedAccountPage(
  db: D1Database,
  userId: string,
  pageSize: number,
  now: number,
): Promise<CleanupPageResult> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0)
    throw new Error("invalid_cleanup_page_size");
  const account = await db
    .prepare(`SELECT status,email_key,deletion_completed_at FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ status: string; email_key: string; deletion_completed_at: number | null }>();
  if (account === null || account.status !== ACCOUNT_DELETING_STATUS) {
    throw new Error("account_not_deleting");
  }
  if (account.deletion_completed_at !== null) return { state: "complete" };
  for (const step of STEPS) {
    const owner = step.ownerColumn === "email_key" ? account.email_key : userId;
    const result = await db
      .prepare(`DELETE FROM ${step.table} WHERE rowid IN
      (SELECT rowid FROM ${step.table} WHERE ${step.ownerColumn} = ? LIMIT ?)`)
      .bind(owner, pageSize)
      .run();
    const removed = result.meta.changes ?? 0;
    if (removed > 0) return { state: "progress", table: step.table, removed };
  }
  const mailPayload = await db
    .prepare(`UPDATE mail_outbox SET payload_ciphertext = NULL,
    payload_ref = NULL, updated_at = ? WHERE id IN
      (SELECT id FROM mail_outbox WHERE recipient_user_id = ?
        AND (payload_ciphertext IS NOT NULL OR payload_ref IS NOT NULL) LIMIT ?)`)
    .bind(now, userId, pageSize)
    .run();
  if ((mailPayload.meta.changes ?? 0) > 0) {
    return {
      state: "progress",
      table: "mail_outbox_payload",
      removed: mailPayload.meta.changes ?? 0,
    };
  }
  // 账号行作为最小撤销审计保留，但邮箱 HMAC/密文与绑定 ID 被不可逆随机值替换。
  // 只有所有数据页都清空且账号仍在 deleting 时，才一次性登记完成并释放存量。
  const remaining = STEPS.map(
    (step) => `NOT EXISTS (SELECT 1 FROM ${step.table}
    WHERE ${step.ownerColumn} = ${step.ownerColumn === "email_key" ? "users.email_key" : "users.id"})`,
  ).join(" AND ");
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE users SET email_key = ?, email_binding_id = ?,
      email_ciphertext = X'', deletion_completed_at = ?, updated_at = ?
      WHERE id = ? AND status = ? AND deletion_completed_at IS NULL
      AND ${remaining}
      AND NOT EXISTS (SELECT 1 FROM mail_outbox WHERE recipient_user_id = users.id
        AND (payload_ciphertext IS NOT NULL OR payload_ref IS NOT NULL))`,
      params: [
        `deleted:${crypto.randomUUID()}`,
        crypto.randomUUID(),
        now,
        now,
        userId,
        ACCOUNT_DELETING_STATUS,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "capacity_state",
        allowZeroRowsIfLast: true,
        set: { value: { sql: "value - 1" }, version: { sql: "version + 1" }, updated_at: now },
        where: { sql: "key = ? AND value > 0", params: [ACCOUNTS_TOTAL_CAPACITY_KEY] },
      },
    ],
  });
  return result.outcome === "committed"
    ? { state: "complete" }
    : { state: "progress", table: "account_finalize", removed: 0 };
}
