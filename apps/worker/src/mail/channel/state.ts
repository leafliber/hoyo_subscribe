import {
  EMAIL_CONSENT_ENABLE_ACTION,
  type EmailChannelEnableFacts,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEATS_MAX,
} from "@hoyo/contracts";
import { decryptDeliveryAddress } from "../../auth/challenges/delivery";
import { asEnvelopeBytes } from "../../auth/challenges/payload";
import type { ActiveRecoverySession } from "../../auth/recovery/credential";
import { currentRecoveryCodeSaved } from "../../auth/recovery/credential";
import { ApiError } from "../../shell/errors";
import type { Keyring } from "../../storage/crypto/keyring";
import { suppressionAddressKey } from "../suppression";

export interface ChannelRow {
  enabled: number;
  routine_enabled: number;
  address_version: number;
  consent_version: number;
  channel_revision: number;
  lease_expires_at: number | null;
  last_renewed_at: number | null;
  last_renewed_reason: string | null;
}
export interface UserRow {
  email_binding_id: string;
  email_version: number;
  email_ciphertext: ArrayBuffer;
  auth_epoch: number;
  recovery_epoch: number;
}
export async function channelRow(db: D1Database, userId: string): Promise<ChannelRow | null> {
  return db
    .prepare("SELECT * FROM email_channels WHERE user_id=?")
    .bind(userId)
    .first<ChannelRow>();
}
export async function readCapacity(db: D1Database): Promise<EmailChannelEnableFacts["remaining"]> {
  try {
    const row = await db
      .prepare(`SELECT COALESCE(SUM(enabled=1),0) AS seats,
      COALESCE(SUM(enabled=1 AND routine_enabled=1),0) AS routine FROM email_channels`)
      .first<{ seats: number; routine: number }>();
    if (row === null) return { seat: "unknown", routine: "unknown" };
    // 过期本身不释放存量；只有明确关闭或 P5 的沉睡回收才释放。
    return {
      seat: Math.max(0, MAIL_SEATS_MAX - row.seats),
      routine: Math.max(0, MAIL_ROUTINE_SEATS_MAX - row.routine),
    };
  } catch {
    return { seat: "unknown", routine: "unknown" };
  }
}
export async function readContext(
  db: D1Database,
  keys: Keyring,
  session: ActiveRecoverySession,
  now: number,
) {
  const user = await db
    .prepare(`SELECT u.email_binding_id,u.email_version,u.email_ciphertext,u.auth_epoch,u.recovery_epoch,
    s.state AS session_state,s.recovery_code_required FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.status='active' AND s.id=? AND s.token_hash=? AND s.state IN ('active','pending')
      AND s.auth_epoch=u.auth_epoch AND s.recovery_epoch=u.recovery_epoch AND s.expires_at>? AND s.absolute_expires_at>?`)
    .bind(session.userId, session.sessionId, session.sessionTokenHash, now, now)
    .first<UserRow & { session_state: "active" | "pending"; recovery_code_required: number }>();
  if (!user) throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  const address = await decryptDeliveryAddress(
    keys.fieldEncryption(),
    session.userId,
    asEnvelopeBytes(user.email_ciphertext),
  );
  const addressKey = await suppressionAddressKey(keys.emailLookup(), address);
  const [channel, saved, remaining] = await Promise.all([
    channelRow(db, session.userId),
    currentRecoveryCodeSaved(db, session.userId),
    readCapacity(db),
  ]);
  let deliverability: EmailChannelEnableFacts["deliverability"] = "unknown";
  let suppressionKind: string | null = null;
  try {
    const suppression = await db
      .prepare(
        "SELECT kind FROM suppressions WHERE address_key=? AND (expires_at IS NULL OR expires_at>?)",
      )
      .bind(addressKey, now)
      .first<{ kind: string }>();
    deliverability = suppression ? "suppressed" : "deliverable";
    suppressionKind = suppression?.kind ?? null;
  } catch {
    /* D3：读取失败不能当作可投递。 */
  }
  const current = channel?.address_version === user.email_version;
  return {
    user,
    channel,
    addressKey,
    maskedAddress: `${address[0]}***${address.slice(address.lastIndexOf("@"))}`,
    suppressionKind,
    facts: {
      session_state: user.session_state,
      recovery_code_required: user.recovery_code_required === 1,
      recovery_code_saved: saved,
      deliverability,
      enabled: current && channel?.enabled === 1,
      routine_enabled: current && channel?.routine_enabled === 1,
      remaining,
    },
  };
}
export async function readLayerConsent(
  db: D1Database,
  userId: string,
  binding: string,
  layer: "seat" | "routine",
) {
  const [enabled, latest] = await Promise.all([
    db
      .prepare(`SELECT consent_version,created_at FROM consent_events WHERE user_id=? AND email_binding_id=?
      AND layer=? AND action=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .bind(userId, binding, layer, EMAIL_CONSENT_ENABLE_ACTION)
      .first<{ consent_version: number; created_at: number }>(),
    db
      .prepare(`SELECT action,created_at FROM consent_events WHERE user_id=? AND email_binding_id=?
      AND layer=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .bind(userId, binding, layer)
      .first<{ action: string; created_at: number }>(),
  ]);
  return {
    version: enabled?.consent_version ?? null,
    enabled_at: enabled?.created_at ?? null,
    last_event: latest,
  };
}
