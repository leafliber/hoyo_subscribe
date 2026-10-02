// P3-07：仅专用所有者 GET 可解密地址；写操作由会话 + Feed 代次共同守卫。
import {
  type CalendarAction,
  calendarOutputState,
  calendarViewSchema,
  FEED_ACTIVITY_WRITE_INTERVAL,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { readSubscription } from "../../accounts/subscription/service";
import { currentRecoveryCodeSaved } from "../../auth/recovery/credential";
import { ApiError } from "../../shell/errors";
import { conditionalCommit, type GuardedEffect } from "../../storage/cas";
import { decryptFieldText, encryptField } from "../../storage/crypto/aead";
import { toHex, utf8Encode } from "../../storage/crypto/bytes";
import type { Keyring } from "../../storage/crypto/keyring";
import { generateSecretToken } from "../../storage/crypto/random";
import { hashFeedToken } from "../feed/store";

export interface CalendarSession {
  userId: string;
  sessionId: string;
  sessionTokenHash: string;
}
interface Row {
  user_id: string;
  namespace: string;
  state: string;
  token_hash: string;
  token_ciphertext: ArrayBuffer;
  token_generation: number;
  recovery_epoch: number;
  last_management_operation: string | null;
  last_output_at: number | null;
  last_output_diagnostic: string | null;
  last_served_at: number | null;
  last_served_node_count: number | null;
  last_guard_blocked_at: number | null;
  last_feed_poll_at: number | null;
}
const sessionPredicate = `id = ? AND user_id = ? AND token_hash = ? AND state='active'
  AND expires_at > ? AND absolute_expires_at > ?
  AND EXISTS (SELECT 1 FROM users u WHERE u.id=sessions.user_id AND u.status='active'
    AND u.auth_epoch=sessions.auth_epoch AND u.recovery_epoch=sessions.recovery_epoch)`;
function sessionParams(s: CalendarSession, now: number) {
  return [s.sessionId, s.userId, s.sessionTokenHash, now, now];
}
async function identity(db: D1Database, session: CalendarSession, now: number) {
  const value = await db
    .prepare(
      `SELECT recovery_epoch, recovery_code_required FROM sessions WHERE ${sessionPredicate}`,
    )
    .bind(...sessionParams(session, now))
    .first<{ recovery_epoch: number; recovery_code_required: number }>();
  if (!value) throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return value;
}
async function readRow(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM calendar_feeds WHERE user_id=?").bind(id).first<Row>();
}
function conflict(): never {
  throw new ApiError("conflict", { code: "conflict" });
}
function result(row: Row | null, changed = false) {
  return {
    changed,
    token_generation: row?.token_generation ?? 0,
    address_state: row?.state ?? "not_enabled",
  };
}
export async function readCalendar(
  db: D1Database,
  keys: Keyring,
  session: CalendarSession,
  origin: string,
  now: number,
) {
  const who = await identity(db, session, now);
  const row = await readRow(db, session.userId);
  const subscription = await readSubscription(db, session.userId);
  const enabled = row?.state === "enabled" && row.recovery_epoch === who.recovery_epoch;
  let url: string | null = null;
  if (enabled && row) {
    const token = await decryptFieldText(
      keys.fieldEncryption(),
      { type: "feed-token-owner-copy", id: row.namespace },
      new Uint8Array(row.token_ciphertext),
    );
    if ((await hashFeedToken(token)) !== row.token_hash)
      throw new Error("feed_ciphertext_mismatch");
    url = new URL(`/feeds/u/${token}.ics`, origin).href;
  }
  // 解密期间停用、删除或换代均不可向旧会话披露凭证。
  await identity(db, session, now);
  const current = await readRow(db, session.userId);
  if (
    (current?.token_generation ?? 0) !== (row?.token_generation ?? 0) ||
    current?.token_hash !== row?.token_hash
  )
    conflict();
  return calendarViewSchema.parse({
    address_state: row === null ? "not_enabled" : enabled ? "enabled" : "disabled",
    url,
    token_generation: row?.token_generation ?? 0,
    configuration: {
      state: subscription.state,
      revision: subscription.revision,
      alarms_enabled: subscription.config?.calendar.alarms_enabled ?? null,
    },
    output: {
      state: calendarOutputState(row?.last_output_at ?? null, row?.last_output_diagnostic ?? null),
      last_output_at: row?.last_output_at ?? null,
      diagnostic: row?.last_output_diagnostic ?? null,
      last_served_at: row?.last_served_at ?? null,
      last_served_node_count: row?.last_served_node_count ?? null,
      last_guard_blocked_at: row?.last_guard_blocked_at ?? null,
    },
    polling: {
      last_feed_poll_at: row?.last_feed_poll_at ?? null,
      merge_interval_days: FEED_ACTIVITY_WRITE_INTERVAL,
      meaning: "client_requested_address",
    },
  });
}
export interface PreviewBinding {
  expected_revision: number;
  publication_generation: number;
}
const previewPredicate = `EXISTS (SELECT 1 FROM user_subscriptions s
  WHERE s.user_id=? AND s.state='initialized' AND s.revision=?)
  AND EXISTS (SELECT 1 FROM public_snapshots p WHERE p.state='current'
    AND p.generation=? AND p.published_at IS NOT NULL AND p.node_count IS NOT NULL)`;
function previewParams(userId: string, binding: PreviewBinding) {
  return [userId, binding.expected_revision, binding.publication_generation];
}
async function assertPreview(db: D1Database, userId: string, binding?: PreviewBinding) {
  if (
    !binding ||
    !Number.isSafeInteger(binding.expected_revision) ||
    binding.expected_revision < 1 ||
    !Number.isSafeInteger(binding.publication_generation) ||
    binding.publication_generation < 1 ||
    !(await db
      .prepare(`SELECT 1 AS matched WHERE ${previewPredicate}`)
      .bind(...previewParams(userId, binding))
      .first())
  ) {
    throw new ApiError("conflict", { code: "conflict", reason: "preview_outdated" });
  }
}
export async function mutateCalendar(
  db: D1Database,
  keys: Keyring,
  session: CalendarSession,
  action: CalendarAction,
  expected: number,
  operationKey: string,
  now: number,
  preview?: PreviewBinding,
) {
  if (!Number.isSafeInteger(expected) || expected < 0) conflict();
  const who = await identity(db, session, now);
  if (who.recovery_code_required)
    throw new ApiError("unauthorized", {
      code: "unauthorized",
      reason: "recovery_code_unconfirmed",
    });
  const before = await readRow(db, session.userId);
  const operation = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        utf8Encode(
          JSON.stringify([
            action,
            expected,
            operationKey,
            ...(action === "enable"
              ? [preview?.expected_revision, preview?.publication_generation]
              : []),
          ]),
        ),
      ),
    ),
  );
  if (before?.last_management_operation === operation) {
    if (action !== "disable" && before.recovery_epoch !== who.recovery_epoch) conflict();
    return result(before, action === "enable");
  }
  if ((before?.token_generation ?? 0) !== expected) conflict();
  if (action !== "disable" && !(await currentRecoveryCodeSaved(db, session.userId)))
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "recovery_code_not_saved" });
  if (action === "enable") await assertPreview(db, session.userId, preview);
  const enabled = before?.state === "enabled" && before.recovery_epoch === who.recovery_epoch;
  if (
    (action === "enable" && enabled) ||
    (action === "disable" && (before === null || before.state === "disabled"))
  )
    return result(before);
  if (action === "reset" && before === null) conflict();
  const generation = expected + 1;
  const namespace = before?.namespace ?? crypto.randomUUID();
  const token = action === "disable" ? null : generateSecretToken().base64url;
  const hash = token === null ? `revoked:${namespace}:${generation}` : await hashFeedToken(token);
  if (hash === null) throw new Error("feed_token_generation_failed");
  const ciphertext =
    token === null
      ? new Uint8Array()
      : await encryptField(
          keys.fieldEncryption(),
          { type: "feed-token-owner-copy", id: namespace },
          token,
        );
  const { userKey, globalKey } = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
  const charge = action !== "disable";
  const effects: GuardedEffect[] = charge
    ? [globalKey, userKey].map((key) => ({
        kind: "update",
        table: "capacity_state",
        set: { value: { sql: "value+1" }, version: { sql: "version+1" }, updated_at: now },
        where: { sql: "key=?", params: [key] },
      }))
    : [];
  if (before)
    effects.push({
      kind: "update",
      table: "calendar_feeds",
      set: {
        state: action === "disable" ? "disabled" : "enabled",
        token_hash: hash,
        token_ciphertext: ciphertext,
        token_generation: generation,
        recovery_epoch: who.recovery_epoch,
        token_rotated_at: now,
        updated_at: now,
        last_management_operation: operation,
      },
      where: { sql: "user_id=?", params: [session.userId] },
    });
  else
    effects.push({
      kind: "insert",
      table: "calendar_feeds",
      columns: [
        "user_id",
        "namespace",
        "state",
        "token_hash",
        "token_ciphertext",
        "token_generation",
        "view_revision",
        "changed_at",
        "created_at",
        "updated_at",
        "recovery_epoch",
        "token_rotated_at",
        "last_management_operation",
      ],
      rows: [
        [
          session.userId,
          namespace,
          "enabled",
          hash,
          ciphertext,
          generation,
          0,
          now,
          now,
          now,
          who.recovery_epoch,
          now,
          operation,
        ],
      ],
    });
  const outcome = await conditionalCommit(db, {
    preamble: charge
      ? [userKey, globalKey].map((key) => ({
          sql: "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,0,0,?) ON CONFLICT(key) DO NOTHING",
          params: [key, now],
        }))
      : [],
    guard: {
      sql: `UPDATE sessions SET updated_at=? WHERE ${sessionPredicate} AND recovery_code_required=0
      ${action === "enable" ? `AND ${previewPredicate}` : ""}
      AND ${before ? "EXISTS (SELECT 1 FROM calendar_feeds f WHERE f.user_id=sessions.user_id AND f.token_generation=?)" : "NOT EXISTS (SELECT 1 FROM calendar_feeds f WHERE f.user_id=sessions.user_id)"}
      ${
        charge
          ? `AND EXISTS (SELECT 1 FROM recovery_credentials c WHERE c.user_id=sessions.user_id AND c.consumed_at IS NULL AND c.saved_confirmed_at IS NOT NULL)
      AND (SELECT value FROM capacity_state WHERE key=?) < ? AND (SELECT value FROM capacity_state WHERE key=?) < ?`
          : ""
      }`,
      params: [
        now,
        ...sessionParams(session, now),
        ...(action === "enable" && preview ? previewParams(session.userId, preview) : []),
        ...(before ? [expected] : []),
        ...(charge ? [userKey, USER_MUTATIONS_DAY, globalKey, GLOBAL_MUTATIONS_DAY] : []),
      ],
    },
    effects,
  });
  const current = await readRow(db, session.userId);
  if (outcome.outcome === "committed") return result(current, true);
  const latestIdentity = await identity(db, session, now);
  if (latestIdentity.recovery_code_required)
    throw new ApiError("unauthorized", {
      code: "unauthorized",
      reason: "recovery_code_unconfirmed",
    });
  if (current?.last_management_operation === operation) return result(current, action === "enable");
  if (charge && !(await currentRecoveryCodeSaved(db, session.userId)))
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "recovery_code_not_saved" });
  if (action === "enable") await assertPreview(db, session.userId, preview);
  if (charge) {
    for (const [key, limit, scope] of [
      [userKey, USER_MUTATIONS_DAY, "user_mutations_day"],
      [globalKey, GLOBAL_MUTATIONS_DAY, "global_mutations_day"],
    ] as const) {
      const row = await db
        .prepare("SELECT value FROM capacity_state WHERE key=?")
        .bind(key)
        .first<{ value: number }>();
      if ((row?.value ?? 0) >= limit)
        throw new ApiError("quota_paused", { code: "quota_paused", scope });
    }
  }
  conflict();
}
