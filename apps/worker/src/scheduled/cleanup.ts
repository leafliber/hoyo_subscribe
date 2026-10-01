// P3-10 获准跨卡：只追加管理员审计到期清理，一轮 MATCH_PAGE，不改系统审计。
// P3-11：按已有导出名接 P2；不修改 P2-09 正在返工的挑战清理。

import { ACCOUNT_DELETING_STATUS, MATCH_PAGE } from "@hoyo/contracts";
import { releaseExpiredRegistration } from "../accounts/admission/registration";
import { cleanupDeletedAccountPage } from "../accounts/lifecycle/cleanup";
import { cleanupAdminAuditPage } from "../admin/audit";
import { clearExpiredOtpPayloads } from "../auth/challenges/cleanup";
import { clearExpiredAuthMaterials } from "../auth/consume/cleanup";
import { cleanupExpiredPendingSessions } from "../auth/sessions/lifecycle";
import { logEvent } from "../shell/logger";
export const cleanupTasks = {
  registrations: async (db: D1Database, now: number) => {
    const rows = (
      await db
        .prepare(
          "SELECT id, expires_at AS expiresAt FROM admission_reservations WHERE state = 'reserved' AND expires_at <= ? ORDER BY expires_at,id LIMIT ?",
        )
        .bind(now, MATCH_PAGE)
        .all<{ id: string; expiresAt: number }>()
    ).results;
    for (const row of rows) await releaseExpiredRegistration(db, row, now);
  },
  challenges: clearExpiredOtpPayloads,
  authMaterials: clearExpiredAuthMaterials,
  pendingSessions: cleanupExpiredPendingSessions,
  deletedAccounts: async (db: D1Database, now: number) => {
    // 一轮一账号一页；updated_at 轮转，避免大账号饿死后续账号。
    const row = await db
      .prepare(
        "SELECT id FROM users WHERE status = ? AND deletion_completed_at IS NULL ORDER BY updated_at,id LIMIT 1",
      )
      .bind(ACCOUNT_DELETING_STATUS)
      .first<{ id: string }>();
    if (row !== null) {
      await cleanupDeletedAccountPage(db, row.id, MATCH_PAGE, now);
      await db
        .prepare("UPDATE users SET updated_at = ? WHERE id = ? AND deletion_completed_at IS NULL")
        .bind(now, row.id)
        .run();
    }
  },
  adminAudit: cleanupAdminAuditPage,
};
export async function runCleanup(
  db: D1Database,
  now: number,
  deadline: number,
  clock: () => number = Date.now,
): Promise<void> {
  for (const [name, task] of Object.entries(cleanupTasks)) {
    if (clock() >= deadline) {
      logEvent("warn", "pipeline_cleanup_deferred", { reason_code: "wall_limit" });
      break;
    }
    try {
      await task(db, now);
    } catch {
      logEvent("error", "pipeline_cleanup_failed", { reason_code: name });
    }
  }
}
