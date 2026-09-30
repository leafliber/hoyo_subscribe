// F2-04 返工获准跨卡：仅在 readAccountSummary 返回 user_id，供已确认身份的本机草稿分键。
// P2-07：D3 草案 §1.2/§2.10 的本人摘要与可分享偏好导出。
// 视图只读主状态，未知通道显式 unknown；导出不包含邮箱、任何凭证、URL 或通道同意。
import {
  ACCOUNT_ACTIONS,
  type AccountAction,
  type ActionAvailability,
  RECENT_AUTH_TTL,
  SESSION_EXPIRY_NOTICE,
} from "@hoyo/contracts";
import { decryptDeliveryAddress } from "../../auth/challenges/delivery";
import { asEnvelopeBytes } from "../../auth/challenges/payload";
import { targetForAction } from "../../auth/recent-auth/target";
import { currentRecoveryCodeSaved } from "../../auth/recovery/credential";
import type { ShellAuth } from "../../shell/domains";
import { ApiError } from "../../shell/errors";
import type { Keyring } from "../../storage/crypto/keyring";
import { readSubscription } from "../subscription/service";

const SECOND = 1_000;

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

/** 与账号页和其他私人视图共用的服务端动作表计算入口。 */
export async function accountActions(
  db: D1Database,
  auth: Extract<ShellAuth, { domain: "user" }>,
  now: number,
): Promise<Record<AccountAction, ActionAvailability>> {
  const proofRows =
    (
      await db
        .prepare(`SELECT p.action, p.role, p.target_digest
    FROM recent_auth_proofs p WHERE p.user_id = ? AND p.session_id = ?
      AND p.consumed_at IS NULL AND p.expires_at > ?`)
        .bind(auth.userId, auth.sessionId, now)
        .all<{ action: string; role: string; target_digest: string }>()
    ).results ?? [];
  const rotateDigest = (await targetForAction("recovery_code_rotate")).digest;
  const deleteDigest = (await targetForAction("account_delete")).digest;
  const has = (action: string, digest: string) =>
    proofRows.some(
      (row) => row.action === action && row.role === "current" && row.target_digest === digest,
    );
  const emailReady = proofRows.some(
    (row) =>
      row.action === "email_change" &&
      row.role === "current" &&
      proofRows.some(
        (other) =>
          other.action === "email_change" &&
          other.role === "new_address" &&
          other.target_digest === row.target_digest,
      ),
  );
  const recoveryLoginRecent = await db
    .prepare(`SELECT 1 AS ready FROM auth_challenges c
    JOIN sessions s ON s.id = c.pending_session_id WHERE s.id = ? AND s.user_id = ?
      AND c.purpose = 'recovery' AND c.consumed_at IS NOT NULL
      AND s.activated_at BETWEEN ? AND ?`)
    .bind(auth.sessionId, auth.userId, now - RECENT_AUTH_TTL * SECOND, now)
    .first<{ ready: number }>();
  const unavailable: ActionAvailability = { allowed: false, reason: "recent_auth_required" };
  const allowed: ActionAvailability = { allowed: true };
  const restricted: ActionAvailability = { allowed: false, reason: "recovery_code_unconfirmed" };
  const result: Record<AccountAction, ActionAvailability> = {
    save_subscription: auth.recoveryCodeRequired ? restricted : allowed,
    export_data: allowed,
    email_change: auth.recoveryCodeRequired ? restricted : emailReady ? allowed : unavailable,
    recovery_code_rotate: auth.recoveryCodeRequired
      ? restricted
      : has("recovery_code_rotate", rotateDigest)
        ? allowed
        : unavailable,
    account_delete:
      has("account_delete", deleteDigest) ||
      (auth.recoveryCodeRequired && recoveryLoginRecent?.ready === 1)
        ? allowed
        : unavailable,
  };
  // 编译期与运行时均保证闭合动作表，不让新增动作静默缺字段。
  if (Object.keys(result).length !== ACCOUNT_ACTIONS.length)
    throw new Error("account_actions_incomplete");
  return result;
}

export async function readAccountSummary(
  db: D1Database,
  keys: Keyring,
  auth: ShellAuth,
  now: number,
): Promise<unknown> {
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
  return {
    user_id: auth.userId,
    email: { masked: maskEmail(address), email_version: account.email_version },
    recovery_code_saved: saved,
    recovery_code_generation: recovery?.generation ?? null,
    subscription: { state: subscription.state },
    session: {
      state: session.state,
      expires_at: session.expires_at,
      absolute_expires_at: session.absolute_expires_at,
      expiry_notice: session.expires_at - now <= SESSION_EXPIRY_NOTICE * SECOND,
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
    actions: await accountActions(db, auth, now),
  };
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
