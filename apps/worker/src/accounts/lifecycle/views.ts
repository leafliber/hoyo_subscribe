// F2-04 返工获准跨卡：仅在 readAccountSummary 返回 user_id，供已确认身份的本机草稿分键。
// P2-10：D3 §1.2/§2.10 的本人事实摘要；动作与临期提示由 contracts 在浏览器推导。
// 视图只读主状态，未知通道显式 unknown；导出不包含邮箱、任何凭证、URL 或通道同意。
import { type AccountRecentAuth, type AccountSummary, AccountSummarySchema } from "@hoyo/contracts";
import { decryptDeliveryAddress } from "../../auth/challenges/delivery";
import { asEnvelopeBytes } from "../../auth/challenges/payload";
import { targetForAction } from "../../auth/recent-auth/target";
import { currentRecoveryCodeSaved } from "../../auth/recovery/credential";
import type { ShellAuth } from "../../shell/domains";
import { ApiError } from "../../shell/errors";
import type { Keyring } from "../../storage/crypto/keyring";
import { readSubscription } from "../subscription/service";

interface AccountRow {
  email_ciphertext: ArrayBuffer | Uint8Array;
  email_version: number;
  reclaim_grace_until: number | null;
  status: string;
}

function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

/** 只提取当前会话可用的证明到期时间；不向客户端披露 ID、方法或目标摘要。 */
async function readRecentAuth(
  db: D1Database,
  auth: Extract<ShellAuth, { domain: "user" }>,
  now: number,
): Promise<AccountRecentAuth> {
  const proofRows =
    (
      await db
        .prepare(`SELECT p.action, p.role, p.target_digest, p.expires_at
    FROM recent_auth_proofs p WHERE p.user_id = ? AND p.session_id = ?
      AND p.consumed_at IS NULL AND p.expires_at > ?`)
        .bind(auth.userId, auth.sessionId, now)
        .all<{ action: string; role: string; target_digest: string; expires_at: number }>()
    ).results ?? [];
  const rotateDigest = (await targetForAction("recovery_code_rotate")).digest;
  const deleteDigest = (await targetForAction("account_delete")).digest;
  const latest = (times: number[]): number | null =>
    times.length === 0 ? null : Math.max(...times);
  const expiresAt = (action: string, digest: string) =>
    latest(
      proofRows
        .filter(
          (row) => row.action === action && row.role === "current" && row.target_digest === digest,
        )
        .map((row) => row.expires_at),
    );
  // 每对证明取较早到期；多组可用证明取最长可用期，避免数据库行顺序影响结果。
  const emailExpiries = proofRows.flatMap((row) =>
    row.action === "email_change" && row.role === "current"
      ? proofRows
          .filter(
            (other) =>
              other.action === "email_change" &&
              other.role === "new_address" &&
              other.target_digest === row.target_digest,
          )
          .map((other) => Math.min(row.expires_at, other.expires_at))
      : [],
  );
  return {
    email_change: latest(emailExpiries),
    recovery_code_rotate: expiresAt("recovery_code_rotate", rotateDigest),
    account_delete: expiresAt("account_delete", deleteDigest),
  };
}

export async function readAccountSummary(
  db: D1Database,
  keys: Keyring,
  auth: ShellAuth,
  now: number,
): Promise<AccountSummary> {
  if (auth.kind !== "session" || auth.domain !== "user") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  const [account, subscription, session, emailChannel, saved, recovery] = await Promise.all([
    db
      .prepare(`SELECT email_ciphertext,email_version,reclaim_grace_until,status
      FROM users WHERE id = ?`)
      .bind(auth.userId)
      .first<AccountRow>(),
    readSubscription(db, auth.userId),
    db
      .prepare(`SELECT state,expires_at,absolute_expires_at,activated_at
      FROM sessions WHERE id = ? AND user_id = ?`)
      .bind(auth.sessionId, auth.userId)
      .first<{
        state: string;
        expires_at: number;
        absolute_expires_at: number;
        activated_at: number | null;
      }>(),
    db
      .prepare(
        `SELECT enabled,routine_enabled,address_version FROM email_channels WHERE user_id = ?`,
      )
      .bind(auth.userId)
      .first<{ enabled: number; routine_enabled: number; address_version: number }>(),
    currentRecoveryCodeSaved(db, auth.userId),
    db
      .prepare(
        `SELECT generation FROM recovery_credentials WHERE user_id = ? AND consumed_at IS NULL`,
      )
      .bind(auth.userId)
      .first<{ generation: number }>(),
  ]);
  if (account === null || account.status !== "active" || session === null) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  const address = await decryptDeliveryAddress(
    keys.fieldEncryption(),
    auth.userId,
    asEnvelopeBytes(account.email_ciphertext),
  );
  const recoveryLogin = await db
    .prepare(`SELECT s.activated_at FROM auth_challenges c
    JOIN sessions s ON s.id = c.pending_session_id WHERE s.id = ? AND s.user_id = ?
      AND c.purpose = 'recovery' AND c.consumed_at IS NOT NULL`)
    .bind(auth.sessionId, auth.userId)
    .first<{ activated_at: number | null }>();
  return AccountSummarySchema.parse({
    user_id: auth.userId,
    server_time: now,
    email: { masked: maskEmail(address), email_version: account.email_version },
    recovery_code_saved: saved,
    recovery_code_generation: recovery?.generation ?? null,
    subscription: { state: subscription.state },
    session: {
      state: session.state,
      expires_at: session.expires_at,
      absolute_expires_at: session.absolute_expires_at,
      recovery_login_at: recoveryLogin?.activated_at ?? null,
      recovery_code_required: auth.recoveryCodeRequired,
    },
    channels: {
      calendar: { state: "unknown" },
      email:
        emailChannel === null
          ? { state: "unknown" }
          : {
              state:
                emailChannel.enabled === 1 && emailChannel.address_version === account.email_version
                  ? "enabled"
                  : "disabled",
              routine_enabled: emailChannel.routine_enabled === 1,
            },
      push: { state: "unknown" },
    },
    reclaim_grace_until: account.reclaim_grace_until,
    recent_auth: await readRecentAuth(db, auth, now),
  });
}

export async function exportPreferences(db: D1Database, userId: string): Promise<unknown> {
  const subscription = await readSubscription(db, userId);
  return {
    format: "hoyo-preferences",
    subscription:
      subscription.state === "initialized"
        ? { state: subscription.state, config: subscription.config }
        : { state: subscription.state, config: null },
  };
}
