// P2-07：持有当前恢复码可证明当前账号控制权；恢复码自身仍保持有效，
// 只把与会话、用途、目标绑定的短期证明设为单次消费。
import { RECENT_AUTH_TTL, type RecentAuthAction } from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import { conditionalCommit } from "../../storage/cas";
import type { RecentSession } from "../challenges/recent-auth";
import { verifyRecoveryCredential } from "../recovery/action";
import { chargeRecoveryId } from "../recovery/rate";
import { targetForAction } from "./target";

const SECOND = 1_000;

export async function proveWithRecoveryCode(
  db: D1Database,
  session: RecentSession,
  action: RecentAuthAction,
  rawTargetEmail: string | undefined,
  recoveryId: string,
  secret: string,
  now: number,
): Promise<string> {
  const target = await targetForAction(action, rawTargetEmail);
  // §4.6：核验前按 recovery_id 计入与公开恢复入口同一组窗口；未知 ID 与错误秘密同样入账。
  if (!(await chargeRecoveryId(db, recoveryId, now)))
    throw new ApiError("rate_limited", { code: "rate_limited" });
  const credential = await verifyRecoveryCredential(db, recoveryId, secret);
  if (credential === null || credential.user_id !== session.userId) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "recent_auth_required" });
  }
  const proofId = crypto.randomUUID();
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ? AND token_hash = ?
        AND state = 'active' AND recovery_code_required = 0
        AND expires_at > ? AND absolute_expires_at > ?
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
          AND u.status = 'active' AND u.auth_epoch = sessions.auth_epoch
          AND u.recovery_epoch = sessions.recovery_epoch)
        AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.id = ?
          AND c.user_id = sessions.user_id AND c.secret_hash = ? AND c.consumed_at IS NULL)`,
      params: [
        now,
        session.sessionId,
        session.userId,
        session.sessionTokenHash,
        now,
        now,
        credential.id,
        credential.secret_hash,
      ],
    },
    effects: [
      {
        kind: "insert",
        table: "recent_auth_proofs",
        columns: [
          "id",
          "user_id",
          "session_id",
          "action",
          "role",
          "target_digest",
          "method",
          "expires_at",
          "consumed_at",
          "created_at",
        ],
        rows: [
          [
            proofId,
            session.userId,
            session.sessionId,
            action,
            "current",
            target.digest,
            "recovery",
            now + RECENT_AUTH_TTL * SECOND,
            null,
            now,
          ],
        ],
      },
    ],
  });
  if (outcome.outcome !== "committed") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "recent_auth_required" });
  }
  return proofId;
}
