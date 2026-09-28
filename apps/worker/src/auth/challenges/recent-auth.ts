// P2-07 获准跨卡分支：当前会话的用途限定 OTP，不改变 login/signup 的预认证挑战路径。
// 当前地址从 users 受控密文读取；新地址取用户本次明确提交的投递形态。两者的 MAC
// 都绑定挑战 ID、用途、email_key、地址版本和代次，成功后只产生会话绑定的一次性证明。
import {
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  OTP_ATTEMPTS,
  OTP_COOLDOWN,
  OTP_DIGITS,
  OTP_TTL,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  poolOfMailIntent,
  RECENT_AUTH_TTL,
  type RecentAuthAction,
  type RecentAuthRole,
  recentAuthOtpPurpose,
  utcDayPeriod,
} from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import { conditionalCommit } from "../../storage/cas";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey, macOtpVerification, verifyOtpMac } from "../../storage/crypto/mac";
import { generateOtpCode } from "../../storage/crypto/random";
import { reserveMailBudget } from "../../storage/ledger/mail-ledger";
import { targetForAction } from "../recent-auth/target";
import { decryptDeliveryAddress } from "./delivery";
import { asEnvelopeBytes, encryptOtpPayload, OTP_PAYLOAD_KIND } from "./payload";

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const AUTH_MAIL_PRIORITY = 0;
const INITIAL_GENERATION = 0;

export interface RecentSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
}

interface UserAddressRow {
  email_key: string;
  email_ciphertext: ArrayBuffer | Uint8Array;
  email_version: number;
}

interface ChallengeRow {
  id: string;
  user_id: string;
  session_id: string;
  action: RecentAuthAction;
  role: RecentAuthRole;
  target_digest: string;
  email_key: string;
  address_version: number;
  mac: string;
  attempts: number;
  deadline: number;
}

function invalidProof(): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason: "recent_auth_required" });
}

/** 发信任务仅入 outbox；P4 发送器负责外发。没有预算时挑战和载荷立即作废。 */
export async function startRecentOtp(
  db: D1Database,
  keys: Keyring,
  session: RecentSession,
  action: RecentAuthAction,
  role: RecentAuthRole,
  rawTargetEmail: string | undefined,
  idempotencyKey: string,
  now: number,
): Promise<string> {
  if (idempotencyKey.length === 0) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "idempotency_key", reason: "required" }],
    });
  }
  if (role === "new_address" && action !== "email_change") throw invalidProof();
  const target = await targetForAction(action, rawTargetEmail);
  const replay = await db
    .prepare(`SELECT id,action,role,target_digest,aborted_at
    FROM recent_auth_challenges WHERE session_id = ? AND idempotency_key = ?`)
    .bind(session.sessionId, idempotencyKey)
    .first<{
      id: string;
      action: string;
      role: string;
      target_digest: string;
      aborted_at: number | null;
    }>();
  if (replay !== null) {
    if (replay.action !== action || replay.role !== role || replay.target_digest !== target.digest)
      throw new ApiError("conflict", { code: "conflict" });
    if (replay.aborted_at !== null)
      throw new ApiError("quota_paused", { code: "quota_paused", scope: "auth_mail" });
    return replay.id;
  }
  const previous = await db
    .prepare(`SELECT created_at FROM recent_auth_challenges
    WHERE session_id = ? AND action = ? AND role = ? AND target_digest = ?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(session.sessionId, action, role, target.digest)
    .first<{ created_at: number }>();
  if (previous !== null && previous.created_at + OTP_COOLDOWN * SECOND > now)
    throw new ApiError("rate_limited", {
      code: "rate_limited",
      retry_after_ms: previous.created_at + OTP_COOLDOWN * SECOND - now,
    });
  const user = await db
    .prepare(
      `SELECT u.email_key, u.email_ciphertext, u.email_version FROM users u
      JOIN sessions s ON s.user_id = u.id WHERE u.id = ? AND u.status = 'active'
      AND s.id = ? AND s.token_hash = ? AND s.state = 'active'
      AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch
      AND s.expires_at > ? AND s.absolute_expires_at > ?`,
    )
    .bind(session.userId, session.sessionId, session.sessionTokenHash, now, now)
    .first<UserAddressRow>();
  if (user === null) throw invalidProof();
  const address =
    role === "current"
      ? await decryptDeliveryAddress(
          keys.fieldEncryption(),
          session.userId,
          asEnvelopeBytes(user.email_ciphertext),
        )
      : target.deliveryAddress;
  if (address === undefined || address.length === 0) throw invalidProof();
  const emailKey =
    role === "current"
      ? user.email_key
      : await computeEmailKey(keys.emailLookup(), target.canonicalEmail ?? "");
  const challengeId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const code = generateOtpCode();
  const mac = await macOtpVerification(keys.otpMac(), {
    purpose: recentAuthOtpPurpose(action, role),
    challengeId,
    emailKey,
    addressVersion: user.email_version,
    generation: INITIAL_GENERATION,
    code,
  });
  const payload = await encryptOtpPayload(keys.fieldEncryption(), outboxId, {
    challengeId,
    generation: INITIAL_GENERATION,
    code,
    address,
  });
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO mail_outbox
      (id,purpose,priority,period_key,recipient_user_id,address_version,payload_kind,payload_ref,
       payload_ciphertext,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .bind(
          outboxId,
          poolOfMailIntent("account_change_auth"),
          AUTH_MAIL_PRIORITY,
          OUTBOX_UNRESERVED_PERIOD_KEY,
          session.userId,
          user.email_version,
          OTP_PAYLOAD_KIND,
          challengeId,
          payload,
          now,
          now,
        ),
      db
        .prepare(`INSERT INTO recent_auth_challenges
      (id,user_id,session_id,idempotency_key,action,role,target_digest,email_key,address_version,mac,attempts,
       deadline,outbox_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`)
        .bind(
          challengeId,
          session.userId,
          session.sessionId,
          idempotencyKey,
          action,
          role,
          target.digest,
          emailKey,
          user.email_version,
          mac,
          now + OTP_TTL * SECOND,
          outboxId,
          now,
          now,
        ),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed.*recent_auth_challenges/i.test(error.message)
    ) {
      const winner = await db
        .prepare(`SELECT id,action,role,target_digest,aborted_at FROM recent_auth_challenges
        WHERE session_id = ? AND idempotency_key = ?`)
        .bind(session.sessionId, idempotencyKey)
        .first<{
          id: string;
          action: string;
          role: string;
          target_digest: string;
          aborted_at: number | null;
        }>();
      if (winner !== null) {
        if (
          winner.action !== action ||
          winner.role !== role ||
          winner.target_digest !== target.digest
        )
          throw new ApiError("conflict", { code: "conflict" });
        if (winner.aborted_at !== null)
          throw new ApiError("quota_paused", { code: "quota_paused", scope: "auth_mail" });
        return winner.id;
      }
    }
    throw error;
  }
  const budget = await reserveMailBudget(db, {
    intent: "account_change_auth",
    period: utcDayPeriod(now),
    now,
    outboxId,
  });
  if (budget.outcome === "condition_missed") {
    await db.batch([
      db
        .prepare(`UPDATE recent_auth_challenges SET aborted_at = ?, updated_at = ? WHERE id = ?`)
        .bind(now, now, challengeId),
      db
        .prepare(`UPDATE mail_outbox SET status = 'skipped', payload_ciphertext = NULL,
        payload_ref = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(now, outboxId),
    ]);
    throw new ApiError("quota_paused", { code: "quota_paused", scope: "auth_mail" });
  }
  return challengeId;
}

/** 错码持久扣次数；命中后挑战消费和证明插入在同一 CAS 中完成。 */
export async function verifyRecentOtp(
  db: D1Database,
  keys: Keyring,
  session: RecentSession,
  challengeId: string,
  code: string,
  now: number,
): Promise<string> {
  if (!new RegExp(`^\\d{${OTP_DIGITS}}$`).test(code)) throw invalidProof();
  const row = await db
    .prepare(`SELECT id,user_id,session_id,action,role,target_digest,email_key,
    address_version,mac,attempts,deadline FROM recent_auth_challenges WHERE id = ?
    AND user_id = ? AND session_id = ? AND consumed_at IS NULL AND aborted_at IS NULL`)
    .bind(challengeId, session.userId, session.sessionId)
    .first<ChallengeRow>();
  if (row === null || row.deadline <= now || row.attempts >= OTP_ATTEMPTS) throw invalidProof();
  const recent = await db
    .prepare(`SELECT coalesce(sum(attempts),0) AS total
    FROM recent_auth_challenges WHERE email_key = ? AND updated_at >= ?`)
    .bind(row.email_key, now - HOUR)
    .first<{ total: number }>();
  if ((recent?.total ?? 0) >= EMAIL_VERIFY_ATTEMPTS_HOUR)
    throw new ApiError("rate_limited", { code: "rate_limited" });
  const matched = await verifyOtpMac(
    keys.otpMac(),
    {
      purpose: recentAuthOtpPurpose(row.action, row.role),
      challengeId: row.id,
      emailKey: row.email_key,
      addressVersion: row.address_version,
      generation: INITIAL_GENERATION,
      code,
    },
    row.mac,
  );
  if (!matched) {
    await db
      .prepare(`UPDATE recent_auth_challenges SET attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ? AND attempts < ?`)
      .bind(now, row.id, now, OTP_ATTEMPTS)
      .run();
    throw invalidProof();
  }
  const proofId = crypto.randomUUID();
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE recent_auth_challenges SET consumed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND session_id = ? AND mac = ?
        AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ? AND attempts < ?
        AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = recent_auth_challenges.session_id AND s.token_hash = ?
          AND s.state = 'active' AND s.expires_at > ? AND s.absolute_expires_at > ?
          AND u.status = 'active' AND s.auth_epoch = u.auth_epoch
          AND s.recovery_epoch = u.recovery_epoch
          AND u.email_version = recent_auth_challenges.address_version)`,
      params: [
        now,
        now,
        row.id,
        session.userId,
        session.sessionId,
        row.mac,
        now,
        OTP_ATTEMPTS,
        session.sessionTokenHash,
        now,
        now,
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
            row.action,
            row.role,
            row.target_digest,
            "otp",
            now + RECENT_AUTH_TTL * SECOND,
            null,
            now,
          ],
        ],
      },
    ],
  });
  if (outcome.outcome !== "committed") throw invalidProof();
  return proofId;
}
