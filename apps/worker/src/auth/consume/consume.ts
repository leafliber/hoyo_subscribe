// P2-03 · 正确 OTP 的一次性原子消费（主方案 §4.1、§4.4、§5.1、附录 A.1/A.2）。
// 2026-09-27 裁定：新账号地址只从挑战独立密文解出，绝不读 verify 请求邮箱。
// D1 batch 在 CAS 零行时不回滚；所有账号、容量、订阅和会话依赖写只经
// P1-05 conditionalCommit 的 changes() 谓词链执行。

import {
  AUTH_COMPLETION_TTL,
  OTP_ATTEMPTS,
  REGISTRATIONS_DAY,
  SESSION_PENDING_PER_USER,
  SUBSCRIPTION_INIT_STATE,
  SUBSCRIPTION_SCHEMA_VERSION,
} from "@hoyo/contracts";
import { registrationsDayKey } from "../../accounts/admission/registration";
import { allocateUserOrder } from "../../accounts/users/order";
import { ApiError } from "../../shell";
import { conditionalCommit } from "../../storage/cas";
import { encryptField } from "../../storage/crypto/aead";
import type { Keyring } from "../../storage/crypto/keyring";
import { DELIVERY_ADDRESS_RECORD_TYPE, decryptDeliveryAddress } from "../challenges/delivery";
import { asEnvelopeBytes } from "../challenges/payload";
import type { PreauthContext } from "../preauth/cookie";
import { encryptCompletionReceipt } from "./receipt";
import { makePendingSession, type PendingSessionValues } from "./session";

const MS_PER_SECOND = 1_000;

interface ChallengeRow {
  readonly id: string;
  readonly purpose: "login" | "signup";
  readonly email_key: string;
  readonly address_version: number;
  readonly preauth_id: string;
  readonly mac: string;
  readonly generation: number;
  readonly reservation_id: string | null;
  readonly delivery_address_ciphertext: ArrayBuffer | Uint8Array | null;
}

interface UserRow {
  readonly id: string;
  readonly status: string;
  readonly email_version: number;
  readonly auth_epoch: number;
  readonly recovery_epoch: number;
}

export interface VerifiedChallenge {
  readonly id: string;
  readonly purpose: string;
  readonly addressVersion: number;
  readonly generation: number;
  readonly mac: string;
}

export interface ConsumeOtpDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  /** Test seam: park competing requests after all reads, before CAS. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface ConsumeOtpInput {
  readonly verified: VerifiedChallenge;
  readonly preauth: PreauthContext;
  readonly emailKey: string;
  readonly operationKey: string;
  readonly now: number;
}

export type ConsumeOtpResult =
  | { readonly outcome: "committed"; readonly session: PendingSessionValues }
  | { readonly outcome: "condition_missed" };

function conflict(): ApiError {
  return new ApiError("conflict", { code: "conflict" });
}

function loginRequired(): ApiError {
  return new ApiError("validation", {
    code: "validation",
    fields: [{ path: "email", reason: "login_required" }],
  });
}

/** 消费依据已经验证的 MAC；CAS 内再核对代次、MAC、地址版本与开放条件。 */
export async function consumeVerifiedOtp(
  deps: ConsumeOtpDeps,
  input: ConsumeOtpInput,
): Promise<ConsumeOtpResult> {
  const { db, keys } = deps;
  const { verified, preauth, emailKey, operationKey, now } = input;
  const challenge = await db
    .prepare(
      `SELECT id, purpose, email_key, address_version, preauth_id, mac, generation,
              reservation_id, delivery_address_ciphertext
         FROM auth_challenges WHERE id = ?`,
    )
    .bind(verified.id)
    .first<ChallengeRow>();
  if (
    challenge === null ||
    challenge.delivery_address_ciphertext === null ||
    challenge.preauth_id !== preauth.preauthId ||
    challenge.email_key !== emailKey ||
    challenge.purpose !== verified.purpose ||
    challenge.address_version !== verified.addressVersion ||
    challenge.generation !== verified.generation ||
    challenge.mac !== verified.mac
  ) {
    return { outcome: "condition_missed" };
  }
  if (challenge.purpose !== "login" && challenge.purpose !== "signup") {
    throw new Error("P2-03 不消费未实现的挑战用途");
  }

  // 独立挑战列是唯一来源。损坏/跨记录搬运会由 AEAD 抛错，失败关闭。
  const deliveryAddress = await decryptDeliveryAddress(
    keys.fieldEncryption(),
    challenge.id,
    asEnvelopeBytes(challenge.delivery_address_ciphertext),
  );
  const existing = await db
    .prepare(
      "SELECT id, status, email_version, auth_epoch, recovery_epoch FROM users WHERE email_key = ?",
    )
    .bind(emailKey)
    .first<UserRow>();
  if (challenge.purpose === "signup" && existing !== null) {
    // 并发期间同规范键已被建立：即使验证码正确，也不能直接转为那个账号登录。
    throw loginRequired();
  }
  if (
    challenge.purpose === "login" &&
    (existing === null ||
      existing.status !== "active" ||
      existing.email_version !== challenge.address_version)
  ) {
    throw conflict();
  }
  if (challenge.purpose === "signup" && challenge.reservation_id === null) {
    throw new Error("signup 挑战缺少注册预占（失败关闭）");
  }

  const userId = existing?.id ?? crypto.randomUUID();
  const userOrder = challenge.purpose === "signup" ? await allocateUserOrder(db, now) : null;
  const emailCiphertext =
    challenge.purpose === "signup"
      ? await encryptField(
          keys.fieldEncryption(),
          { type: DELIVERY_ADDRESS_RECORD_TYPE, id: userId },
          deliveryAddress,
        )
      : null;
  const session = await makePendingSession(now);
  const receiptExpiresAt = Math.min(now + AUTH_COMPLETION_TTL * MS_PER_SECOND, session.expiresAt);
  const receiptCiphertext = await encryptCompletionReceipt(keys.fieldEncryption(), challenge.id, {
    preauthId: preauth.preauthId,
    operationKey,
    pendingSessionId: session.id,
    cookieValue: session.cookieValue,
  });
  const dayKey = registrationsDayKey(now);

  await deps.beforeCommit?.();
  const committed = await conditionalCommit(db, {
    preamble:
      challenge.purpose === "signup"
        ? [
            {
              sql: "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
              params: [dayKey, now],
            },
          ]
        : [],
    guard: {
      sql: `UPDATE auth_challenges
               SET consumed_at = ?, delivery_address_ciphertext = NULL,
                   receipt_ciphertext = ?, receipt_expires_at = ?, pending_session_id = ?, updated_at = ?
             WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?
               AND preauth_id = ? AND email_key = ? AND purpose = ?
               AND address_version = ? AND generation = ? AND mac = ? AND attempts < ?
               AND (purpose <> 'signup' OR (
                 reservation_id = ? AND EXISTS (
                   SELECT 1 FROM admission_reservations r
                    WHERE r.id = auth_challenges.reservation_id AND r.state = 'reserved'
                      AND r.email_key = auth_challenges.email_key AND r.expires_at > ?
                 ) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email_key = auth_challenges.email_key)
                 AND (SELECT value FROM capacity_state WHERE key = ?) < ?
               ))
               AND (purpose <> 'login' OR EXISTS (
                 SELECT 1 FROM users u WHERE u.id = ? AND u.email_key = auth_challenges.email_key
                   AND u.email_version = auth_challenges.address_version AND u.status = 'active'
                   AND u.auth_epoch = ? AND u.recovery_epoch = ?
               ))
               AND (SELECT count(*) FROM sessions s
                     WHERE s.user_id = ? AND s.state = 'pending' AND s.expires_at > ?) < ?`,
      params: [
        now,
        receiptCiphertext,
        receiptExpiresAt,
        session.id,
        now,
        challenge.id,
        now,
        preauth.preauthId,
        emailKey,
        challenge.purpose,
        challenge.address_version,
        challenge.generation,
        challenge.mac,
        OTP_ATTEMPTS,
        challenge.reservation_id,
        now,
        dayKey,
        REGISTRATIONS_DAY,
        existing?.id ?? "",
        existing?.auth_epoch ?? 0,
        existing?.recovery_epoch ?? 0,
        userId,
        now,
        SESSION_PENDING_PER_USER,
      ],
    },
    effects: [
      ...(challenge.purpose === "signup"
        ? ([
            {
              kind: "insert",
              table: "users",
              columns: [
                "id",
                "order",
                "status",
                "email_key",
                "email_binding_id",
                "email_ciphertext",
                "email_version",
                "auth_epoch",
                "recovery_epoch",
                "created_at",
                "updated_at",
              ],
              rows: [
                [
                  userId,
                  userOrder,
                  "active",
                  emailKey,
                  crypto.randomUUID(),
                  emailCiphertext,
                  challenge.address_version,
                  0,
                  0,
                  now,
                  now,
                ],
              ],
            },
            {
              kind: "insert",
              table: "user_subscriptions",
              columns: [
                "user_id",
                "state",
                "schema_version",
                "revision",
                "scope_json",
                "calendar_json",
                "notifications_json",
                "created_at",
                "updated_at",
              ],
              rows: [
                [
                  userId,
                  SUBSCRIPTION_INIT_STATE,
                  SUBSCRIPTION_SCHEMA_VERSION,
                  0,
                  null,
                  null,
                  null,
                  now,
                  now,
                ],
              ],
            },
            {
              kind: "update",
              table: "admission_reservations",
              set: { state: "converted", converted_user_id: userId, updated_at: now },
              where: { sql: "id = ? AND state = 'reserved'", params: [challenge.reservation_id] },
            },
            {
              kind: "update",
              table: "capacity_state",
              set: {
                value: { sql: "value + 1" },
                version: { sql: "version + 1" },
                updated_at: now,
              },
              where: { sql: "key = ?", params: [dayKey] },
            },
          ] as const)
        : []),
      {
        kind: "insert",
        table: "sessions",
        columns: [
          "id",
          "user_id",
          "token_hash",
          "state",
          "label",
          "platform_hint",
          "issued_at",
          "absolute_expires_at",
          "expires_at",
          "renewed_at",
          "auth_epoch",
          "recovery_epoch",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            session.id,
            userId,
            session.tokenHash,
            "pending",
            session.label,
            session.platformHint,
            now,
            session.absoluteExpiresAt,
            session.expiresAt,
            now,
            existing?.auth_epoch ?? 0,
            existing?.recovery_epoch ?? 0,
            now,
            now,
          ],
        ],
      },
    ],
  });
  if (committed.outcome === "condition_missed") {
    if (challenge.purpose === "signup") {
      const wonElsewhere = await db
        .prepare("SELECT id FROM users WHERE email_key = ?")
        .bind(emailKey)
        .first();
      if (wonElsewhere !== null) throw loginRequired();
    }
    return { outcome: "condition_missed" };
  }
  return { outcome: "committed", session };
}
