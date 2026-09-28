// P2-05 · public 恢复入口：预认证绑定、双维限速后才核 recovery_id+秘密。
// 三种无效情况（只交 ID、秘密错误、已消费）共用同一散列比较与 401；
// recover_login 在单次 CAS 中递增 auth_epoch、消费码、写 recovery 挑战/回执及 pending 会话。
import { AUTH_COMPLETION_TTL, PREAUTH_MARGIN } from "@hoyo/contracts";
import { ApiError, jsonResponse, parseCookieHeader } from "../../shell";
import { conditionalCommit } from "../../storage/cas";
import type { Keyring } from "../../storage/crypto/keyring";
import { renewPreauthCookieForContext } from "../challenges/renewal";
import { requireOperationKey } from "../consume/operation";
import { encryptCompletionReceipt } from "../consume/receipt";
import { makePendingSession, serializePendingSessionCookie } from "../consume/session";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../preauth/cookie";
import { hashRecoverySecret, secretHashesEqual } from "./credential";
import {
  collectSafetyPauseEffects,
  retireInvalidatedSessions,
  type SafetyPauseEffectHook,
} from "./pause";
import { chargeRecoveryId, type RecoverySourceGate } from "./rate";

const SECOND = 1_000;
const DUMMY_HASH = "0".repeat(64);

interface CurrentCredential {
  id: string;
  user_id: string;
  secret_hash: string;
  generation: number;
  consumed_at: number | null;
  email_key: string;
  email_version: number;
  auth_epoch: number;
  recovery_epoch: number;
  user_status: string;
}

export interface RecoveryActionDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  readonly sourceGate: RecoverySourceGate;
  readonly now: () => number;
  readonly pauseHooks?: readonly SafetyPauseEffectHook[];
  /** 测试屏障：两个请求读完凭证后同时争 CAS。 */
  readonly beforeCommit?: () => Promise<void>;
}

export interface RecoveryActionInput {
  readonly request: Request;
  readonly action: "emergency_stop" | "recover_login";
  readonly recoveryId: string;
  readonly secret: string;
}

function invalidCredential(): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
}

async function readCredential(
  db: D1Database,
  recoveryId: string,
): Promise<CurrentCredential | null> {
  return db
    .prepare(`SELECT c.id, c.user_id, c.secret_hash, c.generation, c.consumed_at,
      u.email_key, u.email_version, u.auth_epoch, u.recovery_epoch, u.status AS user_status
      FROM recovery_credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ?`)
    .bind(recoveryId)
    .first<CurrentCredential>();
}

/** 只有 ID 与秘密同时命中当前未消费码才返回行；所有失败走同一外部结果。 */
export async function verifyRecoveryCredential(
  db: D1Database,
  recoveryId: string,
  secret: string,
): Promise<CurrentCredential | null> {
  const row = await readCredential(db, recoveryId);
  const suppliedHash = await hashRecoverySecret(secret || "missing-recovery-secret");
  const hashMatch = secretHashesEqual(suppliedHash, row?.secret_hash ?? DUMMY_HASH);
  return hashMatch && row?.consumed_at === null && row.user_status === "active" ? row : null;
}

async function emergencyStop(
  deps: RecoveryActionDeps,
  row: CurrentCredential,
  now: number,
): Promise<void> {
  const effects = await collectSafetyPauseEffects(
    { db: deps.db, userId: row.user_id, now },
    deps.pauseHooks ?? [],
  );
  await deps.beforeCommit?.();
  const result = await conditionalCommit(deps.db, {
    guard: {
      sql: `UPDATE users SET auth_epoch = auth_epoch + 1,
          last_recovery_stop_epoch = auth_epoch + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND auth_epoch = ?
          AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.id = ?
            AND c.user_id = users.id AND c.secret_hash = ? AND c.consumed_at IS NULL)
          AND (last_recovery_stop_epoch IS NULL OR last_recovery_stop_epoch <> auth_epoch
            OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id
              AND s.auth_epoch = users.auth_epoch AND s.recovery_epoch = users.recovery_epoch
              AND s.state IN ('pending','active') AND s.expires_at > ? AND s.absolute_expires_at > ?))`,
      params: [now, row.user_id, row.auth_epoch, row.id, row.secret_hash, now, now],
    },
    effects,
  });
  if (result.outcome === "condition_missed") {
    // 只在另一请求已完成同一停用且当前无有效会话时折叠为幂等成功。
    // 若 CAS 输给了并发新登录，不能把仍需停用的账号谎报为已停用。
    const current = await readCredential(deps.db, row.id);
    if (current === null || current.consumed_at !== null || current.user_status !== "active")
      throw invalidCredential();
    const stop = await deps.db
      .prepare(`SELECT u.auth_epoch, u.last_recovery_stop_epoch,
        EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id
          AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch
          AND s.state IN ('pending','active') AND s.expires_at > ?
          AND s.absolute_expires_at > ?) AS has_current_session
        FROM users u WHERE u.id = ?`)
      .bind(now, now, row.user_id)
      .first<{
        auth_epoch: number;
        last_recovery_stop_epoch: number | null;
        has_current_session: number;
      }>();
    if (stop?.last_recovery_stop_epoch !== stop?.auth_epoch || stop?.has_current_session !== 0) {
      throw new ApiError("conflict", { code: "conflict" });
    }
  }
  await retireInvalidatedSessions(deps.db, row.user_id, now);
}

async function recoverLogin(
  deps: RecoveryActionDeps,
  row: CurrentCredential,
  preauthId: string,
  operationKey: string,
  now: number,
): Promise<Response> {
  const session = await makePendingSession(now);
  const challengeId = crypto.randomUUID();
  const receiptExpiresAt = Math.min(now + AUTH_COMPLETION_TTL * SECOND, session.expiresAt);
  const receiptCiphertext = await encryptCompletionReceipt(
    deps.keys.fieldEncryption(),
    challengeId,
    {
      preauthId,
      operationKey,
      pendingSessionId: session.id,
      cookieValue: session.cookieValue,
    },
  );
  const channelEffects = await collectSafetyPauseEffects(
    { db: deps.db, userId: row.user_id, now },
    deps.pauseHooks ?? [],
  );
  await deps.beforeCommit?.();
  const result = await conditionalCommit(deps.db, {
    guard: {
      sql: `UPDATE users SET auth_epoch = auth_epoch + 1,
          last_recovery_stop_epoch = auth_epoch + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND auth_epoch = ? AND recovery_epoch = ?
          AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.id = ?
            AND c.user_id = users.id AND c.secret_hash = ? AND c.consumed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM auth_challenges c
            WHERE c.preauth_id = ? AND c.idempotency_key = ?)`,
      params: [
        now,
        row.user_id,
        row.auth_epoch,
        row.recovery_epoch,
        row.id,
        row.secret_hash,
        preauthId,
        operationKey,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "recovery_credentials",
        set: { consumed_at: now, updated_at: now },
        where: {
          sql: "id = ? AND user_id = ? AND consumed_at IS NULL",
          params: [row.id, row.user_id],
        },
      },
      ...channelEffects,
      {
        kind: "insert",
        table: "auth_challenges",
        columns: [
          "id",
          "purpose",
          "email_key",
          "address_version",
          "preauth_id",
          "idempotency_key",
          "mac",
          "generation",
          "attempts",
          "deadline",
          "consumed_at",
          "receipt_ciphertext",
          "receipt_expires_at",
          "pending_session_id",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            challengeId,
            "recovery",
            row.email_key,
            row.email_version,
            preauthId,
            operationKey,
            row.secret_hash,
            row.generation,
            0,
            receiptExpiresAt,
            now,
            receiptCiphertext,
            receiptExpiresAt,
            session.id,
            now,
            now,
          ],
        ],
      },
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
          "recovery_code_required",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            session.id,
            row.user_id,
            session.tokenHash,
            "pending",
            session.label,
            session.platformHint,
            now,
            session.absoluteExpiresAt,
            session.expiresAt,
            now,
            row.auth_epoch + 1,
            row.recovery_epoch,
            1,
            now,
            now,
          ],
        ],
      },
    ],
  });
  if (result.outcome !== "committed") throw invalidCredential();
  await retireInvalidatedSessions(deps.db, row.user_id, now);
  const response = jsonResponse({ completed: true, pending_session_id: session.id });
  response.headers.append("set-cookie", serializePendingSessionCookie(session.cookieValue));
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function runRecoveryAction(
  deps: RecoveryActionDeps,
  input: RecoveryActionInput,
): Promise<Response> {
  const now = deps.now();
  const cookie = parseCookieHeader(input.request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  if (cookie === undefined) throw invalidCredential();
  const preauth = await verifyPreauthCookieValue(deps.keys.preauthCookie(), cookie, now);
  if (!preauth.ok) throw invalidCredential();
  const operationKey = input.action === "recover_login" ? requireOperationKey(input.request) : null;
  if (
    !(await deps.sourceGate.charge(input.request, now)) ||
    !(await chargeRecoveryId(deps.db, input.recoveryId, now))
  ) {
    throw new ApiError("rate_limited", { code: "rate_limited" });
  }
  // 一次性消费前要确保原浏览器持有足够长的已认证 preauth；所有码形态走同一续期分支。
  if (
    input.action === "recover_login" &&
    preauth.context.expiresAt - now < (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND
  ) {
    const renewed = await renewPreauthCookieForContext(
      deps.db,
      deps.keys.preauthCookie(),
      preauth.context,
      now,
    );
    const response = jsonResponse({ completed: false, preauth_renewal_required: true }, 409);
    response.headers.append("set-cookie", renewed.setCookie);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  const row = await verifyRecoveryCredential(deps.db, input.recoveryId, input.secret);
  if (row === null) throw invalidCredential();
  if (input.action === "emergency_stop") {
    await emergencyStop(deps, row, now);
    return jsonResponse({ stopped: true });
  }
  return recoverLogin(deps, row, preauth.context.preauthId, operationKey as string, now);
}
