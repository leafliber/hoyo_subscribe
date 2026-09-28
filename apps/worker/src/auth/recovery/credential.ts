// P2-05 · 离线恢复码的单一散列、生成与保存确认（§4.6，附录 A.2）。
// 生成端只返回一次明文；普通会话须最近激活，受限恢复会话可随时补领新码。
// 未确认码可作废重生，确认后的轮换留给 P2-07 最近认证流程。
import { API_BODY_MAX_BYTES, RECENT_AUTH_TTL } from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import { conditionalCommit } from "../../storage/cas";
import { constantTimeEqual, fromHex, toHex, utf8Encode } from "../../storage/crypto/bytes";
import { generateSecretToken } from "../../storage/crypto/random";

interface CredentialRow {
  id: string;
  generation: number;
  saved_confirmed_at: number | null;
}

const SECOND = 1_000;
const GENERATION_ELIGIBILITY = "(s.recovery_code_required = 1 OR s.activated_at BETWEEN ? AND ?)";

function invalidCode(): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
}

export async function hashRecoverySecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encode(value));
  return toHex(new Uint8Array(digest));
}

export function secretHashesEqual(left: string, right: string): boolean {
  const leftBytes = fromHex(left);
  const rightBytes = fromHex(right);
  return leftBytes !== null && rightBytes !== null && constantTimeEqual(leftBytes, rightBytes);
}

/** 供 Feed / 邮件 / Push 首次启用时调用；实际启用写入仍须在本身 CAS 中复核。 */
export async function currentRecoveryCodeSaved(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS ready FROM recovery_credentials WHERE user_id = ? AND consumed_at IS NULL AND saved_confirmed_at IS NOT NULL",
    )
    .bind(userId)
    .first<{ ready: number }>();
  return row?.ready === 1;
}

export interface ActiveRecoverySession {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
}

/** 首次创建或作废未确认码后重新生成；确认码不得由本端点轮换。 */
export async function generateRecoveryCode(
  db: D1Database,
  session: ActiveRecoverySession,
  now: number,
): Promise<{ recovery_id: string; secret: string; saved_confirmed: false }> {
  const current = await db
    .prepare(
      "SELECT id, generation, saved_confirmed_at FROM recovery_credentials WHERE user_id = ? AND consumed_at IS NULL",
    )
    .bind(session.userId)
    .first<CredentialRow>();
  if (current?.saved_confirmed_at !== null && current !== null) {
    throw new ApiError("conflict", { code: "conflict" });
  }
  const last = await db
    .prepare(
      "SELECT coalesce(max(generation), 0) AS generation FROM recovery_credentials WHERE user_id = ?",
    )
    .bind(session.userId)
    .first<{ generation: number }>();
  const recoveryId = crypto.randomUUID();
  const secret = generateSecretToken().base64url;
  const secretHash = await hashRecoverySecret(secret);
  const recentStart = now - RECENT_AUTH_TTL * SECOND;
  const sessionPredicate = `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.token_hash = ? AND s.state = 'active'
        AND s.expires_at > ? AND s.absolute_expires_at > ? AND u.status = 'active'
        AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch
        AND ${GENERATION_ELIGIBILITY})`;
  const sessionParams = [
    session.sessionId,
    session.userId,
    session.sessionTokenHash,
    now,
    now,
    recentStart,
    now,
  ];
  const guard =
    current === null
      ? {
          sql: `UPDATE users SET updated_at = ? WHERE id = ? AND status = 'active'
          AND NOT EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.user_id = users.id AND c.consumed_at IS NULL)
          AND ${sessionPredicate}`,
          params: [now, session.userId, ...sessionParams],
        }
      : {
          sql: `UPDATE recovery_credentials SET consumed_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND consumed_at IS NULL AND saved_confirmed_at IS NULL
          AND ${sessionPredicate}`,
          params: [now, now, current.id, session.userId, ...sessionParams],
        };
  const outcome = await conditionalCommit(db, {
    guard,
    effects: [
      {
        kind: "insert",
        table: "recovery_credentials",
        columns: [
          "id",
          "user_id",
          "secret_hash",
          "generation",
          "consumed_at",
          "saved_confirmed_at",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            recoveryId,
            session.userId,
            secretHash,
            (last?.generation ?? 0) + 1,
            null,
            null,
            now,
            now,
          ],
        ],
      },
    ],
  });
  if (outcome.outcome !== "committed") {
    // 守卫已阻止任何码行变化；只在失败后判定是否应提示最近认证。
    const eligibility = await db
      .prepare(`SELECT ${GENERATION_ELIGIBILITY} AS allowed FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.token_hash = ? AND s.state = 'active'
          AND s.expires_at > ? AND s.absolute_expires_at > ? AND u.status = 'active'
          AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch`)
      .bind(recentStart, now, session.sessionId, session.userId, session.sessionTokenHash, now, now)
      .first<{ allowed: number }>();
    if (eligibility === null) {
      throw invalidCode();
    }
    if (eligibility.allowed !== 1) {
      throw new ApiError("unauthorized", {
        code: "unauthorized",
        reason: "recent_auth_required",
      });
    }
    throw new ApiError("conflict", { code: "conflict" });
  }
  return { recovery_id: recoveryId, secret, saved_confirmed: false };
}

/** 持有本人 active 会话且回传当前秘密，才能确认保存；该确认不声称验证外部备份。 */
export async function confirmRecoveryCode(
  db: D1Database,
  session: ActiveRecoverySession,
  recoveryId: string,
  secret: string,
  now: number,
): Promise<void> {
  if (recoveryId.length > API_BODY_MAX_BYTES || secret.length > API_BODY_MAX_BYTES) {
    throw invalidCode();
  }
  const secretHash = await hashRecoverySecret(secret);
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE recovery_credentials SET saved_confirmed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND secret_hash = ? AND consumed_at IS NULL
          AND saved_confirmed_at IS NULL
          AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id = ? AND s.user_id = recovery_credentials.user_id
              AND s.token_hash = ? AND s.state = 'active' AND s.expires_at > ?
              AND s.absolute_expires_at > ? AND u.status = 'active'
              AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch)`,
      params: [
        now,
        now,
        recoveryId,
        session.userId,
        secretHash,
        session.sessionId,
        session.sessionTokenHash,
        now,
        now,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "sessions",
        set: { recovery_code_required: 0, updated_at: now },
        where: {
          sql: "id = ? AND user_id = ? AND state = 'active'",
          params: [session.sessionId, session.userId],
        },
      },
    ],
  });
  if (outcome.outcome === "committed") return;
  // 确认响应丢失时可重试同一秘密；旧码、错误秘密与不存在 ID 仍同形失败。
  const existing = await db
    .prepare(
      "SELECT secret_hash, saved_confirmed_at FROM recovery_credentials WHERE id = ? AND user_id = ? AND consumed_at IS NULL",
    )
    .bind(recoveryId, session.userId)
    .first<{ secret_hash: string; saved_confirmed_at: number | null }>();
  if (
    existing?.saved_confirmed_at !== null &&
    existing !== null &&
    secretHashesEqual(existing.secret_hash, secretHash)
  )
    return;
  throw invalidCode();
}
