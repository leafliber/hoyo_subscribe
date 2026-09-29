// P2-07：§4.7、§9.5、§9.6 的账号终止与换绑。最近认证证明、会话、邮箱绑定、
// 普通变更日额及新 pending 会话以一个 D1 条件提交决定；0017 触发器同批废止旧权限。
import {
  ACCOUNT_DELETING_STATUS,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  RECENT_AUTH_TTL,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import type { RecentSession } from "../../auth/challenges/recent-auth";
import { makePendingSession, type PendingSessionValues } from "../../auth/consume/session";
import { targetForAction } from "../../auth/recent-auth/target";
import { hashRecoverySecret } from "../../auth/recovery/credential";
import { ApiError } from "../../shell/errors";
import { conditionalCommit, type GuardedEffect } from "../../storage/cas";
import { encryptField } from "../../storage/crypto/aead";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey } from "../../storage/crypto/mac";
import { generateSecretToken } from "../../storage/crypto/random";
import { collectLifecycleEffects, type LifecycleEffectHook } from "./effects";

const SECOND = 1_000;

interface UserVersionRow {
  email_version: number;
  auth_epoch: number;
  recovery_epoch: number;
  status: string;
}

function proofRequired(): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason: "recent_auth_required" });
}

function proofExistsSql(role: "current" | "new_address"): string {
  return `EXISTS (SELECT 1 FROM recent_auth_proofs p WHERE p.id = ? AND p.user_id = sessions.user_id
    AND p.session_id = ? AND p.action = 'email_change' AND p.role = '${role}'
    AND p.target_digest = ? AND p.consumed_at IS NULL AND p.expires_at > ?)`;
}

function consumeProof(id: string, userId: string, sessionId: string, now: number): GuardedEffect {
  return {
    kind: "update",
    table: "recent_auth_proofs",
    set: { consumed_at: now },
    where: {
      sql: "id = ? AND user_id = ? AND session_id = ? AND consumed_at IS NULL",
      params: [id, userId, sessionId],
    },
  };
}

async function readUser(db: D1Database, userId: string): Promise<UserVersionRow> {
  const row = await db
    .prepare(`SELECT email_version,auth_epoch,recovery_epoch,status
    FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserVersionRow>();
  if (row === null || row.status !== "active") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  return row;
}

/** 新邮箱验证后换绑；改变 email_binding_id 防旧邮件退订 token 操作新地址。 */
export async function changeEmail(
  db: D1Database,
  keys: Keyring,
  session: RecentSession,
  rawEmail: string,
  currentProofId: string,
  newProofId: string,
  now: number,
  hooks: readonly LifecycleEffectHook[] = [],
): Promise<{ pendingSession: PendingSessionValues; emailVersion: number }> {
  if (currentProofId === newProofId) throw proofRequired();
  const target = await targetForAction("email_change", rawEmail);
  const user = await readUser(db, session.userId);
  const emailKey = await computeEmailKey(keys.emailLookup(), target.canonicalEmail ?? "");
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id: session.userId },
    target.deliveryAddress ?? "",
  );
  const pendingSession = await makePendingSession(now);
  const { userKey, globalKey } = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
  const channelEffects = await collectLifecycleEffects(
    { db, userId: session.userId, now, event: "email_change" },
    hooks,
  );
  const effects: GuardedEffect[] = [
    {
      kind: "update",
      table: "users",
      set: {
        email_key: emailKey,
        email_ciphertext: ciphertext,
        email_binding_id: crypto.randomUUID(),
        email_version: { sql: "email_version + 1" },
        auth_epoch: { sql: "auth_epoch + 1" },
        updated_at: now,
      },
      where: {
        sql: "id = ? AND status = 'active' AND email_version = ? AND auth_epoch = ?",
        params: [session.userId, user.email_version, user.auth_epoch],
      },
    },
    {
      kind: "update",
      table: "capacity_state",
      set: { value: { sql: "value + 1" }, version: { sql: "version + 1" }, updated_at: now },
      where: { sql: "key = ?", params: [globalKey] },
    },
    {
      kind: "update",
      table: "capacity_state",
      set: { value: { sql: "value + 1" }, version: { sql: "version + 1" }, updated_at: now },
      where: { sql: "key = ?", params: [userKey] },
    },
    consumeProof(currentProofId, session.userId, session.sessionId, now),
    consumeProof(newProofId, session.userId, session.sessionId, now),
    ...channelEffects,
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
          pendingSession.id,
          session.userId,
          pendingSession.tokenHash,
          "pending",
          pendingSession.label,
          pendingSession.platformHint,
          pendingSession.issuedAt,
          pendingSession.absoluteExpiresAt,
          pendingSession.expiresAt,
          pendingSession.issuedAt,
          user.auth_epoch + 1,
          user.recovery_epoch,
          0,
          now,
          now,
        ],
      ],
    },
  ];
  let result: Awaited<ReturnType<typeof conditionalCommit>>;
  try {
    result = await conditionalCommit(db, {
      preamble: [userKey, globalKey].map((key) => ({
        sql: `INSERT INTO capacity_state (key,value,version,updated_at)
          VALUES (?,0,0,?) ON CONFLICT (key) DO NOTHING`,
        params: [key, now],
      })),
      guard: {
        sql: `UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?
          AND token_hash = ? AND state = 'active' AND recovery_code_required = 0
          AND expires_at > ? AND absolute_expires_at > ?
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
            AND u.status = 'active' AND u.email_version = ? AND u.auth_epoch = ?
            AND u.auth_epoch = sessions.auth_epoch AND u.recovery_epoch = sessions.recovery_epoch)
          AND ${proofExistsSql("current")} AND ${proofExistsSql("new_address")}
          AND (SELECT value FROM capacity_state WHERE key = ?) < ?
          AND (SELECT value FROM capacity_state WHERE key = ?) < ?`,
        params: [
          now,
          session.sessionId,
          session.userId,
          session.sessionTokenHash,
          now,
          now,
          user.email_version,
          user.auth_epoch,
          currentProofId,
          session.sessionId,
          target.digest,
          now,
          newProofId,
          session.sessionId,
          target.digest,
          now,
          userKey,
          USER_MUTATIONS_DAY,
          globalKey,
          GLOBAL_MUTATIONS_DAY,
        ],
      },
      effects,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed.*users.email_key/i.test(error.message)
    ) {
      throw new ApiError("conflict", { code: "conflict" });
    }
    throw error;
  }
  if (result.outcome !== "committed") {
    const counters =
      (
        await db
          .prepare("SELECT key,value FROM capacity_state WHERE key IN (?,?)")
          .bind(userKey, globalKey)
          .all<{ key: string; value: number }>()
      ).results ?? [];
    if ((counters.find((r) => r.key === userKey)?.value ?? 0) >= USER_MUTATIONS_DAY)
      throw new ApiError("quota_paused", { code: "quota_paused", scope: "user_mutations_day" });
    if ((counters.find((r) => r.key === globalKey)?.value ?? 0) >= GLOBAL_MUTATIONS_DAY)
      throw new ApiError("quota_paused", { code: "quota_paused", scope: "global_mutations_day" });
    throw proofRequired();
  }
  return { pendingSession, emailVersion: user.email_version + 1 };
}

/** 删除是终止路径；普通修改日额不能阻断，触发器同批废止旧会话与待发任务。 */
export async function markAccountDeleting(
  db: D1Database,
  session: RecentSession,
  proofId: string | undefined,
  now: number,
  hooks: readonly LifecycleEffectHook[] = [],
): Promise<void> {
  const target = await targetForAction("account_delete");
  const effects = await collectLifecycleEffects(
    { db, userId: session.userId, now, event: "account_delete" },
    hooks,
  );
  effects.unshift({
    kind: "update",
    table: "users",
    set: {
      status: ACCOUNT_DELETING_STATUS,
      auth_epoch: { sql: "auth_epoch + 1" },
      updated_at: now,
    },
    where: { sql: "id = ? AND status = 'active'", params: [session.userId] },
  });
  if (proofId !== undefined)
    effects.splice(1, 0, consumeProof(proofId, session.userId, session.sessionId, now));
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?
        AND token_hash = ? AND state = 'active' AND expires_at > ?
        AND absolute_expires_at > ?
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
          AND u.status = 'active' AND u.auth_epoch = sessions.auth_epoch
          AND u.recovery_epoch = sessions.recovery_epoch)
        AND (${
          proofId === undefined
            ? `EXISTS (SELECT 1 FROM sessions recovery_session
          JOIN auth_challenges c ON c.pending_session_id = recovery_session.id
          WHERE recovery_session.id = ? AND recovery_session.user_id = sessions.user_id
          AND recovery_session.recovery_code_required = 1
          AND recovery_session.activated_at BETWEEN ? AND ?
          AND c.purpose = 'recovery' AND c.consumed_at IS NOT NULL)`
            : `EXISTS (SELECT 1 FROM recent_auth_proofs p WHERE p.id = ?
          AND p.user_id = sessions.user_id AND p.session_id = ? AND p.action = 'account_delete'
          AND p.role = 'current' AND p.target_digest = ?
          AND p.consumed_at IS NULL AND p.expires_at > ?)`
        })`,
      params:
        proofId === undefined
          ? [
              now,
              session.sessionId,
              session.userId,
              session.sessionTokenHash,
              now,
              now,
              session.sessionId,
              now - RECENT_AUTH_TTL * SECOND,
              now,
            ]
          : [
              now,
              session.sessionId,
              session.userId,
              session.sessionTokenHash,
              now,
              now,
              proofId,
              session.sessionId,
              target.digest,
              now,
            ],
    },
    effects,
  });
  if (result.outcome !== "committed") throw proofRequired();
}

export interface PendingRotation {
  readonly rotationId: string;
  readonly recoveryId: string;
  readonly secret: string;
}

/** 两步轮换：旧码保持有效，直到新码由本人回传确认。 */
export async function startRecoveryRotation(
  db: D1Database,
  session: RecentSession,
  proofId: string,
  operationKey: string,
  now: number,
): Promise<PendingRotation> {
  const target = await targetForAction("recovery_code_rotate");
  const secret = generateSecretToken().base64url;
  const newHash = await hashRecoverySecret(secret);
  const existing = await db
    .prepare(`SELECT id,old_credential_id,new_credential_id,proof_id,expires_at,confirmed_at
    FROM recovery_rotations WHERE session_id = ? AND operation_key = ?`)
    .bind(session.sessionId, operationKey)
    .first<{
      id: string;
      old_credential_id: string;
      new_credential_id: string;
      proof_id: string;
      expires_at: number;
      confirmed_at: number | null;
    }>();
  if (existing !== null) {
    if (
      existing.proof_id !== proofId ||
      existing.confirmed_at !== null ||
      existing.expires_at <= now
    )
      throw proofRequired();
    const result = await conditionalCommit(db, {
      guard: {
        sql: `UPDATE recovery_rotations SET new_secret_hash = ?, updated_at = ?
        WHERE id = ? AND session_id = ? AND operation_key = ? AND confirmed_at IS NULL
        AND expires_at > ? AND EXISTS (SELECT 1 FROM recovery_credentials c
          WHERE c.id = recovery_rotations.old_credential_id AND c.consumed_at IS NULL
          AND c.saved_confirmed_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = recovery_rotations.session_id AND s.token_hash = ?
          AND s.state = 'active' AND s.expires_at > ? AND s.absolute_expires_at > ?
          AND u.status = 'active' AND s.auth_epoch = u.auth_epoch
          AND s.recovery_epoch = u.recovery_epoch)`,
        params: [
          newHash,
          now,
          existing.id,
          session.sessionId,
          operationKey,
          now,
          session.sessionTokenHash,
          now,
          now,
        ],
      },
    });
    if (result.outcome !== "committed") throw proofRequired();
    return { rotationId: existing.id, recoveryId: existing.new_credential_id, secret };
  }
  const credential = await db
    .prepare(`SELECT id,generation FROM recovery_credentials
    WHERE user_id = ? AND consumed_at IS NULL AND saved_confirmed_at IS NOT NULL`)
    .bind(session.userId)
    .first<{ id: string; generation: number }>();
  if (credential === null) throw proofRequired();
  const rotationId = crypto.randomUUID();
  const recoveryId = crypto.randomUUID();
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE recent_auth_proofs SET consumed_at = ? WHERE id = ? AND user_id = ?
      AND session_id = ? AND action = 'recovery_code_rotate' AND role = 'current'
      AND target_digest = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = recent_auth_proofs.session_id AND s.token_hash = ?
        AND s.state = 'active' AND s.recovery_code_required = 0
        AND s.expires_at > ? AND s.absolute_expires_at > ? AND u.status = 'active'
        AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch)
      AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.id = ?
        AND c.user_id = recent_auth_proofs.user_id AND c.consumed_at IS NULL
        AND c.saved_confirmed_at IS NOT NULL)`,
      params: [
        now,
        proofId,
        session.userId,
        session.sessionId,
        target.digest,
        now,
        session.sessionTokenHash,
        now,
        now,
        credential.id,
      ],
    },
    effects: [
      {
        kind: "insert",
        table: "recovery_rotations",
        columns: [
          "id",
          "user_id",
          "session_id",
          "operation_key",
          "proof_id",
          "old_credential_id",
          "new_credential_id",
          "new_secret_hash",
          "new_generation",
          "expires_at",
          "confirmed_at",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            rotationId,
            session.userId,
            session.sessionId,
            operationKey,
            proofId,
            credential.id,
            recoveryId,
            newHash,
            credential.generation + 1,
            now + RECENT_AUTH_TTL * SECOND,
            null,
            now,
            now,
          ],
        ],
      },
    ],
  });
  if (result.outcome !== "committed") throw proofRequired();
  return { rotationId, recoveryId, secret };
}

export async function confirmRecoveryRotation(
  db: D1Database,
  session: RecentSession,
  rotationId: string,
  secret: string,
  now: number,
): Promise<void> {
  const secretHash = await hashRecoverySecret(secret);
  const row = await db
    .prepare(`SELECT old_credential_id,new_credential_id,new_generation FROM recovery_rotations
    WHERE id = ? AND user_id = ? AND session_id = ? AND new_secret_hash = ?
      AND confirmed_at IS NULL AND expires_at > ?`)
    .bind(rotationId, session.userId, session.sessionId, secretHash, now)
    .first<{ old_credential_id: string; new_credential_id: string; new_generation: number }>();
  if (row === null) throw proofRequired();
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE recovery_rotations SET confirmed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND session_id = ? AND new_secret_hash = ?
      AND confirmed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = recovery_rotations.session_id AND s.token_hash = ?
        AND s.state = 'active' AND s.expires_at > ? AND s.absolute_expires_at > ?
        AND u.status = 'active' AND s.auth_epoch = u.auth_epoch
        AND s.recovery_epoch = u.recovery_epoch)
      AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.id = ?
        AND c.user_id = recovery_rotations.user_id AND c.consumed_at IS NULL
        AND c.saved_confirmed_at IS NOT NULL)`,
      params: [
        now,
        now,
        rotationId,
        session.userId,
        session.sessionId,
        secretHash,
        now,
        session.sessionTokenHash,
        now,
        now,
        row.old_credential_id,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "recovery_credentials",
        set: { consumed_at: now, updated_at: now },
        where: {
          sql: "id = ? AND user_id = ? AND consumed_at IS NULL",
          params: [row.old_credential_id, session.userId],
        },
      },
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
            row.new_credential_id,
            session.userId,
            secretHash,
            row.new_generation,
            null,
            now,
            now,
            now,
          ],
        ],
      },
    ],
  });
  if (result.outcome !== "committed") throw proofRequired();
}
