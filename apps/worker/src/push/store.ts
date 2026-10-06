// P6 · push_bindings / push_messages 的读取、视图投影与受控密文（§8.1 第 10 组；D3 §2.8；ADR-0025）。
import {
  PUSH_ACTIVE_MAX,
  PUSH_NEW_DAY,
  PUSH_PENDING_MAX,
  PUSH_SERVICES,
  PUSH_TEST_DAY,
  PUSH_TOTAL_MAX,
  PUSH_USER_MAX,
  type PushBindingView,
  type PushPauseReason,
  type PushSendOutcome,
  type PushService,
  pushCounterKeys,
  pushSendDayLimit,
  utcDayPeriod,
} from "@hoyo/contracts";
import { asEnvelopeBytes } from "../auth/challenges/payload";
import { decryptField, decryptFieldText, encryptField } from "../storage/crypto/aead";
import type { Keyring } from "../storage/crypto/keyring";
import { decodeBrowserBase64Url } from "./crypto";

export interface PushBindingRow {
  id: string;
  user_id: string;
  endpoint_hash: string;
  endpoint_ciphertext: ArrayBuffer;
  keys_ciphertext: ArrayBuffer;
  state: string;
  binding_version: number;
  receipt_token_hash: string | null;
  lease_expires_at: number | null;
  activated_at: number | null;
  last_processed_at: number | null;
  created_at: number;
  updated_at: number;
  push_service: string;
  activation_deadline: number | null;
  activation_attempts: number;
  activation_sent_at: number | null;
  activation_outcome: string | null;
  activation_challenges_json: string | null;
  last_test_at: number | null;
  last_test_outcome: string | null;
  last_test_received_at: number | null;
  paused_reason: string | null;
  gone_at: number | null;
}

const STATES = new Set(["pending", "active", "paused", "gone"]);
const PAUSE_REASONS = new Set(["user", "safety", "lease_expired", "restore"]);
const OUTCOMES = new Set([
  "accepted",
  "gone",
  "auth_rejected",
  "retry_later",
  "rejected",
  "unknown",
]);

/** 行 → 视图：只给事实，不含端点、密钥、receipt 或挑战；未知取值使整行解析失败（不涂成成功）。 */
export function bindingView(row: PushBindingRow): PushBindingView {
  if (!STATES.has(row.state)) throw new Error("push_binding_state_invalid");
  if (!(PUSH_SERVICES as readonly string[]).includes(row.push_service))
    throw new Error("push_binding_service_invalid");
  const outcome = (value: string | null) =>
    value !== null && OUTCOMES.has(value) ? (value as PushSendOutcome) : null;
  return {
    id: row.id,
    state: row.state as PushBindingView["state"],
    service: row.push_service as PushService,
    binding_version: row.binding_version,
    created_at: row.created_at,
    activated_at: row.activated_at,
    activation:
      row.state === "pending" && row.activation_deadline !== null
        ? {
            deadline: row.activation_deadline,
            attempts: row.activation_attempts,
            last_sent_at: row.activation_sent_at,
            last_outcome: outcome(row.activation_outcome),
          }
        : null,
    lease_expires_at: row.lease_expires_at,
    last_processed_at: row.last_processed_at,
    last_test:
      row.last_test_at === null
        ? null
        : {
            sent_at: row.last_test_at,
            outcome: outcome(row.last_test_outcome),
            received_at: row.last_test_received_at,
          },
    paused_reason:
      row.paused_reason !== null && PAUSE_REASONS.has(row.paused_reason)
        ? (row.paused_reason as PushPauseReason)
        : null,
    gone_at: row.gone_at,
  };
}

export async function readBindingRows(db: D1Database, userId: string): Promise<PushBindingRow[]> {
  return (
    await db
      .prepare("SELECT * FROM push_bindings WHERE user_id = ? ORDER BY created_at, id")
      .bind(userId)
      .all<PushBindingRow>()
  ).results;
}

/** 全站计数口径：有效 pending（未过激活截止）、active，以及有效存量（active + paused + 有效 pending）。 */
export const LIVE_PENDING_SQL = "state='pending' AND activation_deadline>?";
export const ACTIVE_COUNT_SQL = "(SELECT COUNT(*) FROM push_bindings WHERE state='active')";
export const PENDING_COUNT_SQL = `(SELECT COUNT(*) FROM push_bindings WHERE ${LIVE_PENDING_SQL})`;
export const TOTAL_COUNT_SQL = `(SELECT COUNT(*) FROM push_bindings WHERE state IN ('active','paused') OR (${LIVE_PENDING_SQL}))`;

type Remaining = number | "unknown";
export interface PushCapacityFacts {
  user: number;
  pending: Remaining;
  active: Remaining;
  total: Remaining;
  new_today: Remaining;
  test_today: Remaining;
  send_today: Remaining;
}

/** 名额与日额度余量；全站读取失败时显式 unknown（D3 §1.1），本人计数来自已读的行。 */
export async function readCapacity(
  db: D1Database,
  userBindings: number,
  now: number,
): Promise<PushCapacityFacts> {
  const user = Math.max(0, PUSH_USER_MAX - userBindings);
  try {
    const keys = pushCounterKeys(utcDayPeriod(now).key);
    const row = await db
      .prepare(`SELECT ${PENDING_COUNT_SQL} AS pending, ${ACTIVE_COUNT_SQL} AS active, ${TOTAL_COUNT_SQL} AS total,
      COALESCE((SELECT value FROM capacity_state WHERE key=?),0) AS created,
      COALESCE((SELECT value FROM capacity_state WHERE key=?),0) AS tested,
      COALESCE((SELECT value FROM capacity_state WHERE key=?),0) AS sent`)
      .bind(now, now, keys.created, keys.test, keys.send)
      .first<{
        pending: number;
        active: number;
        total: number;
        created: number;
        tested: number;
        sent: number;
      }>();
    if (row === null) throw new Error("push_capacity_unreadable");
    return {
      user,
      pending: Math.max(0, PUSH_PENDING_MAX - row.pending),
      active: Math.max(0, PUSH_ACTIVE_MAX - row.active),
      total: Math.max(0, PUSH_TOTAL_MAX - row.total),
      new_today: Math.max(0, PUSH_NEW_DAY - row.created),
      test_today: Math.max(0, PUSH_TEST_DAY - row.tested),
      send_today: Math.max(0, pushSendDayLimit(false) - row.sent),
    };
  } catch {
    return {
      user,
      pending: "unknown",
      active: "unknown",
      total: "unknown",
      new_today: "unknown",
      test_today: "unknown",
      send_today: "unknown",
    };
  }
}

export interface SubscriptionKeys {
  readonly p256dh: Uint8Array;
  readonly auth: Uint8Array;
}

/** 端点与密钥各一份受控密文；AAD 绑定记录类型与绑定 ID，跨记录搬运即解密失败。 */
export async function sealBindingSecrets(
  keys: Keyring,
  bindingId: string,
  endpoint: string,
  subscription: { p256dh: string; auth: string },
): Promise<{ endpoint: Uint8Array; keys: Uint8Array }> {
  return {
    endpoint: await encryptField(
      keys.fieldEncryption(),
      { type: "push-endpoint", id: bindingId },
      endpoint,
    ),
    keys: await encryptField(
      keys.fieldEncryption(),
      { type: "push-keys", id: bindingId },
      JSON.stringify({ p256dh: subscription.p256dh, auth: subscription.auth }),
    ),
  };
}

export async function openBindingSecrets(
  keys: Keyring,
  row: Pick<PushBindingRow, "id" | "endpoint_ciphertext" | "keys_ciphertext">,
): Promise<{ endpoint: string; keys: SubscriptionKeys }> {
  const endpoint = await decryptFieldText(
    keys.fieldEncryption(),
    { type: "push-endpoint", id: row.id },
    asEnvelopeBytes(row.endpoint_ciphertext),
  );
  const raw = await decryptField(
    keys.fieldEncryption(),
    { type: "push-keys", id: row.id },
    asEnvelopeBytes(row.keys_ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as { p256dh?: unknown; auth?: unknown };
  raw.fill(0);
  const p256dh = typeof parsed.p256dh === "string" ? decodeBrowserBase64Url(parsed.p256dh) : null;
  const auth = typeof parsed.auth === "string" ? decodeBrowserBase64Url(parsed.auth) : null;
  if (!p256dh || !auth) throw new Error("push_keys_invalid");
  return { endpoint, keys: { p256dh, auth } };
}
