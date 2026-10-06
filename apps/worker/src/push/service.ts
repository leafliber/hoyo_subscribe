// P6-01 / P6-02 · 本人 Push 绑定的读取与管理（主方案 §7.8、§8.2、§9.5；D3 §1.2、§2.8；ADR-0025）。
//
// 要点：
// - 只由 active 会话 + CSRF 操作（外壳保证）；所有权从会话派生，不接受请求里的 user_id。
// - 同 endpoint 同 owner 幂等（只轮换本浏览器的 receipt 凭证）；不同 owner 冲突，不 UPSERT 抢占。
// - 容量、日额度、恢复码、订阅状态、运行开关都在同一条件提交里复核；COUNT 只出现在守卫里，
//   不出现 COUNT 后无条件 INSERT（§8.1 末段）。
// - 暂停与删除是终止路径（§9.5）：不受普通修改日额、能力开关或订阅状态阻断。
// - 激活、测试通知在请求内同步外发一次（用户正在等结果）；业务通知由 DeliveryDO 后台外发。
import {
  checkPushEndpoint,
  checkPushKeys,
  derivePushActions,
  EXECUTOR_BATCH_WALL_LIMIT,
  GLOBAL_MUTATIONS_DAY,
  isPushBindingReplaceable,
  mutationCounterKeys,
  PUSH_ACTIVATION_ATTEMPTS,
  PUSH_NEW_DAY,
  PUSH_PENDING_MAX,
  PUSH_TEST_COOLDOWN,
  PUSH_TEST_DAY,
  PUSH_TOTAL_MAX,
  PUSH_USER_MAX,
  type PushAction,
  type PushBlockReason,
  type PushChannelView,
  PushChannelViewSchema,
  PushCreateRequestSchema,
  PushPatchRequestSchema,
  type PushSendOutcome,
  PushVersionRequestSchema,
  publicOperationalCapabilities,
  pushActivationDeadline,
  pushCounterKeys,
  pushEnableAvailability,
  pushLeaseExpiresAt,
  pushOwnedElsewhereRefusal,
  pushRefusal,
  pushSendDayLimit,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { readSubscription } from "../accounts/subscription/service";
import { currentRecoveryCodeSaved } from "../auth/recovery/credential";
import { ApiError } from "../shell/errors";
import {
  controlPredicate,
  readControls,
  WRITABLE_PREDICATE,
} from "../shell/observability/controls";
import {
  conditionalCommit,
  type GuardedEffect,
  type GuardStatement,
  type SqlParam,
} from "../storage/cas";
import type { Keyring } from "../storage/crypto/keyring";
import { generateSecretToken } from "../storage/crypto/random";
import type { PushTransport } from "./client";
import type { PushConfig } from "./config";
import { decodeBrowserBase64Url, importSubscriptionPublicKey, sha256Hex } from "./crypto";
import { activationPayload, sendPushMessage, testPayload } from "./outbound";
import {
  bindingView,
  openBindingSecrets,
  type PushBindingRow,
  readBindingRows,
  readCapacity,
  sealBindingSecrets,
} from "./store";

export interface PushDeps {
  readonly db: D1Database;
  readonly keys: () => Promise<Keyring>;
  readonly config: () => Promise<PushConfig | null>;
  readonly transport: PushTransport;
}
export interface PushSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
}

/** 写入拒绝：七类错误本体 + 与推导函数相同的 blocked_reason。 */
export class PushRefusalError extends ApiError {
  constructor(readonly body: ReturnType<typeof pushRefusal>) {
    super(body.error.code, body.error.details);
  }
}
function refuse(reason: PushBlockReason, retryAt?: number, now?: number): never {
  throw new PushRefusalError(pushRefusal(reason, retryAt, now));
}
function validation(path: string, reason: string): never {
  throw new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}
function notFound(): never {
  validation("id", "not_found");
}
function noSession(): never {
  throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
}

/** 守卫 SQL 与参数按片段顺序拼接，避免手工对齐参数位置。 */
class Guard {
  private readonly parts: string[] = [];
  private readonly values: SqlParam[] = [];
  add(sql: string, ...params: SqlParam[]): this {
    this.parts.push(sql);
    this.values.push(...params);
    return this;
  }
  /** 当前会话仍是本账号有效的 active、非恢复受限会话（与外壳鉴权同一口径，提交时再核一次）。 */
  session(session: PushSession, now: number): this {
    return this.add(
      `AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=? AND s.user_id=? AND s.token_hash=? AND s.state='active' AND s.recovery_code_required=0
          AND s.auth_epoch=u.auth_epoch AND s.recovery_epoch=u.recovery_epoch
          AND s.expires_at>? AND s.absolute_expires_at>? AND u.status='active')`,
      session.sessionId,
      session.userId,
      session.sessionTokenHash,
      now,
      now,
    );
  }
  /** 开启类动作的共同前置：已保存订阅、已确认恢复码、Push 开关与外发总闸、非只读。 */
  enabling(userId: string): this {
    return this.add(
      `AND EXISTS (SELECT 1 FROM user_subscriptions WHERE user_id=? AND state='initialized')
        AND EXISTS (SELECT 1 FROM recovery_credentials WHERE user_id=? AND consumed_at IS NULL AND saved_confirmed_at IS NOT NULL)
        AND ${controlPredicate("push_enabled")} AND ${controlPredicate("outbound_enabled")} AND ${WRITABLE_PREDICATE}`,
      userId,
      userId,
    );
  }
  /** 计数行低于上限（键与上限都作绑定参数）。 */
  below(key: string, limit: number): this {
    return this.add("AND COALESCE((SELECT value FROM capacity_state WHERE key=?),0)<?", key, limit);
  }
  build(): GuardStatement {
    return { sql: this.parts.join("\n"), params: this.values };
  }
}
function counterRow(key: string, now: number): GuardStatement {
  return {
    sql: "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,0,0,?) ON CONFLICT(key) DO NOTHING",
    params: [key, now],
  };
}
function counterIncrement(key: string, now: number): GuardedEffect {
  return {
    kind: "update",
    table: "capacity_state",
    set: { value: { sql: "value+1" }, version: { sql: "version+1" }, updated_at: now },
    where: { sql: "key=?", params: [key] },
  };
}

async function readSessionFacts(db: D1Database, session: PushSession, now: number) {
  const row = await db
    .prepare(`SELECT s.state AS session_state, s.recovery_code_required FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.status='active' AND s.id=? AND s.token_hash=? AND s.state IN ('active','pending')
      AND s.auth_epoch=u.auth_epoch AND s.recovery_epoch=u.recovery_epoch AND s.expires_at>? AND s.absolute_expires_at>?`)
    .bind(session.userId, session.sessionId, session.sessionTokenHash, now, now)
    .first<{ session_state: "active" | "pending"; recovery_code_required: number }>();
  if (row === null) noSession();
  return row;
}

/** `GET /api/v2/me/push-bindings`：只给事实（D3 §2.8），不含端点、密钥或任何凭证。 */
export async function readPushChannel(
  deps: PushDeps,
  session: PushSession,
  now: number,
): Promise<PushChannelView> {
  const { db } = deps;
  const facts = await readSessionFacts(db, session, now);
  const [rows, saved, subscription, controls, config] = await Promise.all([
    readBindingRows(db, session.userId),
    currentRecoveryCodeSaved(db, session.userId),
    readSubscription(db, session.userId),
    readControls(db),
    deps.config(),
  ]);
  return PushChannelViewSchema.parse({
    server_time: now,
    configured: config !== null,
    application_server_key: config?.vapid.publicKey ?? null,
    service: publicOperationalCapabilities(controls, { push_configured: config !== null }).push,
    session_state: facts.session_state,
    recovery_code_required: facts.recovery_code_required === 1,
    recovery_code_saved: saved,
    subscription_state: subscription.state,
    remaining: await readCapacity(db, rows.length, now),
    bindings: rows.map(bindingView),
  });
}

async function bindingRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare("SELECT * FROM push_bindings WHERE id=? AND user_id=?")
    .bind(id, userId)
    .first<PushBindingRow>();
}

export interface PushCreateResult {
  result: "created" | "existing";
  binding_id: string;
  /** 本浏览器的 receipt 窄能力：只在此响应出现一次，由页面存进本机给 Service Worker 使用。 */
  receipt_token: string;
  state: PushChannelView;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * `POST /api/v2/me/push-bindings`：用户主动授权本浏览器后，登记 pending 绑定并交付 receipt 凭证。
 * 不在这里外发：页面先把凭证存进本机，再用 PATCH activate 发可见激活通知——否则激活通知可能
 * 先于凭证落地到达 Service Worker，回执无从发出。
 */
export async function createPushBinding(
  deps: PushDeps,
  session: PushSession,
  body: unknown,
  now: number,
): Promise<PushCreateResult> {
  const parsed = PushCreateRequestSchema.safeParse(body);
  if (!parsed.success) validation("", "invalid_push_subscription");
  const { endpoint, keys } = parsed.data;
  const checked = checkPushEndpoint(endpoint);
  if (!checked.ok) validation("endpoint", checked.reason);
  const keyIssue = checkPushKeys(keys);
  if (keyIssue) validation(keyIssue === "p256dh_invalid" ? "keys.p256dh" : "keys.auth", keyIssue);
  const p256dh = decodeBrowserBase64Url(keys.p256dh);
  const auth = decodeBrowserBase64Url(keys.auth);
  if (p256dh === null || (await importSubscriptionPublicKey(p256dh)) === null)
    validation("keys.p256dh", "p256dh_invalid");
  if (auth === null) validation("keys.auth", "auth_invalid");
  const { db } = deps;
  const view = await readPushChannel(deps, session, now);
  const endpointHash = await sha256Hex(endpoint);
  const existing = await db
    .prepare("SELECT * FROM push_bindings WHERE endpoint_hash=?")
    .bind(endpointHash)
    .first<PushBindingRow>();
  if (existing !== null && existing.user_id !== session.userId)
    throw new PushRefusalError(pushOwnedElsewhereRefusal());
  const ring = await deps.keys();
  if (existing !== null && !isPushBindingReplaceable(bindingView(existing), now)) {
    const stored = await openBindingSecrets(ring, existing);
    if (
      stored.endpoint === endpoint &&
      equalBytes(stored.keys.p256dh, p256dh) &&
      equalBytes(stored.keys.auth, auth)
    )
      return reRegister(deps, session, existing, now);
  }
  // 新建，或在同一事务内替换本浏览器已失效 / 激活过期 / 换了密钥的旧绑定。
  const replacing = existing;
  const availability = pushEnableAvailability(view, replacing !== null);
  if (!availability.allowed) refuse(availability.reason);
  const config = await deps.config();
  if (config === null) refuse("feature_closed");
  const id = crypto.randomUUID();
  const receipt = generateSecretToken().base64url;
  const sealed = await sealBindingSecrets(ring, id, endpoint, keys);
  const day = utcDayPeriod(now).key;
  const daily = pushCounterKeys(day);
  const mutations = mutationCounterKeys(session.userId, day);
  const replacedId = replacing?.id ?? "";
  const guard = new Guard()
    .add("UPDATE users SET updated_at=updated_at WHERE id=? AND status='active'", session.userId)
    .session(session, now)
    .enabling(session.userId);
  if (replacing)
    guard.add(
      "AND EXISTS (SELECT 1 FROM push_bindings WHERE id=? AND user_id=users.id AND endpoint_hash=?)",
      replacing.id,
      endpointHash,
    );
  else
    guard.add("AND NOT EXISTS (SELECT 1 FROM push_bindings WHERE endpoint_hash=?)", endpointHash);
  guard
    .add(
      "AND (SELECT COUNT(*) FROM push_bindings WHERE user_id=users.id AND id<>?)<?",
      replacedId,
      PUSH_USER_MAX,
    )
    .add(
      `AND (SELECT COUNT(*) FROM push_bindings WHERE id<>?
        AND (state IN ('active','paused') OR (state='pending' AND activation_deadline>?)))<?`,
      replacedId,
      now,
      PUSH_TOTAL_MAX,
    )
    .add(
      "AND (SELECT COUNT(*) FROM push_bindings WHERE id<>? AND state='pending' AND activation_deadline>?)<?",
      replacedId,
      now,
      PUSH_PENDING_MAX,
    )
    .below(daily.created, PUSH_NEW_DAY)
    .below(daily.send, pushSendDayLimit(false))
    .below(mutations.userKey, USER_MUTATIONS_DAY)
    .below(mutations.globalKey, GLOBAL_MUTATIONS_DAY);
  const outcome = await conditionalCommit(db, {
    preamble: [
      counterRow(mutations.userKey, now),
      counterRow(mutations.globalKey, now),
      counterRow(daily.created, now),
    ],
    guard: guard.build(),
    effects: [
      ...(replacing
        ? [
            {
              kind: "delete",
              table: "push_bindings",
              where: { sql: "id=? AND user_id=?", params: [replacing.id, session.userId] },
            } satisfies GuardedEffect,
          ]
        : []),
      {
        kind: "insert",
        table: "push_bindings",
        columns: [
          "id",
          "user_id",
          "endpoint_hash",
          "endpoint_ciphertext",
          "keys_ciphertext",
          "state",
          "binding_version",
          "receipt_token_hash",
          "created_at",
          "updated_at",
          "push_service",
          "activation_deadline",
          "activation_attempts",
          "activation_challenges_json",
        ],
        rows: [
          [
            id,
            session.userId,
            endpointHash,
            sealed.endpoint,
            sealed.keys,
            "pending",
            0,
            await sha256Hex(receipt),
            now,
            now,
            checked.service,
            pushActivationDeadline(now),
            0,
            "[]",
          ],
        ],
      },
      counterIncrement(mutations.userKey, now),
      counterIncrement(mutations.globalKey, now),
      counterIncrement(daily.created, now),
    ],
  });
  if (outcome.outcome !== "committed") {
    const owner = await db
      .prepare("SELECT user_id FROM push_bindings WHERE endpoint_hash=?")
      .bind(endpointHash)
      .first<{ user_id: string }>();
    if (owner !== null && owner.user_id !== session.userId)
      throw new PushRefusalError(pushOwnedElsewhereRefusal());
    await explainEnableMiss(deps, session, now, replacing !== null);
  }
  return {
    result: "created",
    binding_id: id,
    receipt_token: receipt,
    state: await readPushChannel(deps, session, now),
  };
}

/** 同 endpoint 同 owner：只轮换本浏览器的 receipt 凭证，绑定身份与状态不变（幂等）。 */
async function reRegister(
  deps: PushDeps,
  session: PushSession,
  row: PushBindingRow,
  now: number,
): Promise<PushCreateResult> {
  const receipt = generateSecretToken().base64url;
  const mutations = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
  const outcome = await conditionalCommit(deps.db, {
    preamble: [counterRow(mutations.userKey, now), counterRow(mutations.globalKey, now)],
    guard: new Guard()
      .add(
        `UPDATE push_bindings SET receipt_token_hash=?, binding_version=binding_version+1, updated_at=?
        WHERE id=? AND user_id=? AND binding_version=? AND state IN ('pending','active','paused')
        AND ${WRITABLE_PREDICATE}`,
        await sha256Hex(receipt),
        now,
        row.id,
        session.userId,
        row.binding_version,
      )
      .session(session, now)
      .below(mutations.userKey, USER_MUTATIONS_DAY)
      .below(mutations.globalKey, GLOBAL_MUTATIONS_DAY)
      .build(),
    effects: [counterIncrement(mutations.userKey, now), counterIncrement(mutations.globalKey, now)],
  });
  if (outcome.outcome !== "committed") {
    const view = await readPushChannel(deps, session, now);
    if (view.session_state === "pending") refuse("pending_activation");
    if (view.recovery_code_required) refuse("recovery_code_unconfirmed");
    await quotaMiss(deps.db, session.userId, now);
    refuse("state_mismatch");
  }
  return {
    result: "existing",
    binding_id: row.id,
    receipt_token: receipt,
    state: await readPushChannel(deps, session, now),
  };
}

/** 条件未命中时按最新事实给出与推导函数一致的原因；无可解释变化时返回冲突。 */
async function explainEnableMiss(
  deps: PushDeps,
  session: PushSession,
  now: number,
  replacing: boolean,
): Promise<never> {
  const view = await readPushChannel(deps, session, now);
  const decision = pushEnableAvailability(view, replacing);
  if (!decision.allowed) refuse(decision.reason);
  await quotaMiss(deps.db, session.userId, now);
  refuse("state_mismatch");
}
async function explainActionMiss(
  deps: PushDeps,
  session: PushSession,
  bindingId: string,
  now: number,
  action: PushAction,
): Promise<never> {
  const view = await readPushChannel(deps, session, now);
  const fresh = view.bindings.find((binding) => binding.id === bindingId) ?? null;
  if (fresh === null) notFound();
  const decision = derivePushActions(view, fresh, now)[action];
  if (!decision.allowed) refuse(decision.reason, decision.retry_at, now);
  await quotaMiss(deps.db, session.userId, now);
  refuse("state_mismatch");
}
/** 普通修改日额用尽（§9.5）：与其他通道相同的 quota_paused 形状。 */
async function quotaMiss(db: D1Database, userId: string, now: number): Promise<void> {
  const { userKey, globalKey } = mutationCounterKeys(userId, utcDayPeriod(now).key);
  const rows = (
    await db
      .prepare("SELECT key,value FROM capacity_state WHERE key IN (?,?)")
      .bind(userKey, globalKey)
      .all<{ key: string; value: number }>()
  ).results;
  for (const [key, limit, scope] of [
    [userKey, USER_MUTATIONS_DAY, "user_mutations_day"],
    [globalKey, GLOBAL_MUTATIONS_DAY, "global_mutations_day"],
  ] as const)
    if ((rows.find((row) => row.key === key)?.value ?? 0) >= limit)
      throw new ApiError("quota_paused", { code: "quota_paused", scope });
}

/** 请求内同步外发的消息行：直接以 calling_provider 落库并计入当日预算。 */
function messageInsert(
  id: string,
  row: Pick<PushBindingRow, "id" | "user_id">,
  purpose: "activation" | "test",
  periodKey: string,
  expiresAt: number,
  now: number,
): GuardedEffect {
  return {
    kind: "insert",
    table: "push_messages",
    columns: [
      "id",
      "binding_id",
      "user_id",
      "purpose",
      "critical",
      "period_key",
      "status",
      "attempts",
      "lease_version",
      "lease_expires_at",
      "expires_at",
      "created_at",
      "updated_at",
    ],
    rows: [
      [
        id,
        row.id,
        row.user_id,
        purpose,
        0,
        periodKey,
        "calling_provider",
        1,
        1,
        now + EXECUTOR_BATCH_WALL_LIMIT * 1000,
        expiresAt,
        now,
        now,
      ],
    ],
  };
}

/**
 * 发出一次可见激活通知（§7.8）。预算、次数、期限、冷却与开关在同一条件提交里核对并记账；
 * 挑战明文只进端到端加密载荷，库里只存它的 SHA-256。未能预留（竞态或额度）返回 null。
 */
export async function sendActivation(
  deps: PushDeps,
  config: PushConfig,
  userId: string,
  bindingId: string,
  now: number,
): Promise<PushSendOutcome | null> {
  const { db } = deps;
  const row = await bindingRow(db, userId, bindingId);
  if (row === null || row.state !== "pending" || row.activation_deadline === null) return null;
  const challenge = generateSecretToken().base64url;
  const messageId = crypto.randomUUID();
  const day = utcDayPeriod(now).key;
  const daily = pushCounterKeys(day);
  const reserved = await conditionalCommit(db, {
    preamble: [counterRow(daily.send, now)],
    guard: new Guard()
      .add(
        `UPDATE push_bindings SET activation_attempts=activation_attempts+1, activation_sent_at=?,
          activation_outcome=NULL,
          activation_challenges_json=json_insert(COALESCE(activation_challenges_json,'[]'),'$[#]',?),
          binding_version=binding_version+1, updated_at=?
        WHERE id=? AND user_id=? AND state='pending' AND activation_deadline>? AND activation_attempts<?
          AND (activation_sent_at IS NULL OR activation_sent_at<=?)
          AND ${controlPredicate("push_enabled")} AND ${controlPredicate("outbound_enabled")}`,
        now,
        await sha256Hex(challenge),
        now,
        bindingId,
        userId,
        now,
        PUSH_ACTIVATION_ATTEMPTS,
        now - PUSH_TEST_COOLDOWN * 1000,
      )
      .below(daily.send, pushSendDayLimit(false))
      .build(),
    effects: [
      counterIncrement(daily.send, now),
      messageInsert(messageId, row, "activation", day, row.activation_deadline, now),
    ],
  });
  if (reserved.outcome !== "committed") return null;
  const secrets = await openBindingSecrets(await deps.keys(), row);
  const outcome = await sendPushMessage(
    { db, config, transport: deps.transport },
    {
      messageId,
      bindingId,
      purpose: "activation",
      endpoint: secrets.endpoint,
      keys: secrets.keys,
      payload: activationPayload(bindingId, challenge),
      expiresAt: row.activation_deadline,
      urgency: "high",
      leaseVersion: 1,
      attempts: 1,
      deliveryId: null,
    },
    now,
  );
  await db
    .prepare("UPDATE push_bindings SET activation_outcome=? WHERE id=? AND state='pending'")
    .bind(outcome, bindingId)
    .run();
  return outcome;
}

export interface PushActionResult {
  result: "completed";
  outcome: PushSendOutcome | null;
  state: PushChannelView;
}

/** PATCH：pause（终止路径）或 activate（重发激活 / 暂停后重新验证接收）。 */
export async function patchPushBinding(
  deps: PushDeps,
  session: PushSession,
  bindingId: string,
  body: unknown,
  now: number,
): Promise<PushActionResult> {
  const parsed = PushPatchRequestSchema.safeParse(body);
  if (!parsed.success) validation("", "invalid_push_patch");
  const { db } = deps;
  const row = await bindingRow(db, session.userId, bindingId);
  if (row === null) notFound();
  if (parsed.data.action === "pause") {
    // 已暂停或已失效即不再外发：幂等成功，不重复写库（§9.5）。不受版本、开关、名额或日额阻断。
    if (row.state === "pending" || row.state === "active") {
      const outcome = await conditionalCommit(db, {
        guard: new Guard()
          .add(
            `UPDATE push_bindings SET state='paused', paused_reason='user', activation_challenges_json=NULL,
            binding_version=binding_version+1, updated_at=?
            WHERE id=? AND user_id=? AND state IN ('pending','active')`,
            now,
            bindingId,
            session.userId,
          )
          .session(session, now)
          .build(),
      });
      if (outcome.outcome !== "committed") {
        const fresh = await bindingRow(db, session.userId, bindingId);
        if (fresh === null) notFound();
        if (fresh.state === "pending" || fresh.state === "active") {
          const facts = await readSessionFacts(db, session, now);
          if (facts.session_state !== "active") refuse("pending_activation");
          refuse(
            facts.recovery_code_required === 1 ? "recovery_code_unconfirmed" : "state_mismatch",
          );
        }
      }
    }
    return { result: "completed", outcome: null, state: await readPushChannel(deps, session, now) };
  }
  if (parsed.data.expected_version !== row.binding_version) refuse("state_mismatch");
  const view = await readPushChannel(deps, session, now);
  const availability = derivePushActions(view, bindingView(row), now).activate;
  if (!availability.allowed) refuse(availability.reason, availability.retry_at, now);
  const config = await deps.config();
  if (config === null) refuse("feature_closed");
  if (row.state === "paused") {
    // 暂停后恢复必须重新验证接收：开启新一轮激活（新截止、次数清零），占 pending 名额与普通修改日额。
    const mutations = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
    const resumed = await conditionalCommit(db, {
      preamble: [counterRow(mutations.userKey, now), counterRow(mutations.globalKey, now)],
      guard: new Guard()
        .add(
          `UPDATE push_bindings SET state='pending', paused_reason=NULL, activation_deadline=?,
            activation_attempts=0, activation_sent_at=NULL, activation_outcome=NULL,
            activation_challenges_json='[]', binding_version=binding_version+1, updated_at=?
          WHERE id=? AND user_id=? AND binding_version=? AND state='paused'
            AND (SELECT COUNT(*) FROM push_bindings WHERE state='pending' AND activation_deadline>?)<?`,
          pushActivationDeadline(now),
          now,
          bindingId,
          session.userId,
          row.binding_version,
          now,
          PUSH_PENDING_MAX,
        )
        .session(session, now)
        .enabling(session.userId)
        .below(mutations.userKey, USER_MUTATIONS_DAY)
        .below(mutations.globalKey, GLOBAL_MUTATIONS_DAY)
        .build(),
      effects: [
        counterIncrement(mutations.userKey, now),
        counterIncrement(mutations.globalKey, now),
      ],
    });
    if (resumed.outcome !== "committed")
      await explainActionMiss(deps, session, bindingId, now, "activate");
  }
  const outcome = await sendActivation(deps, config, session.userId, bindingId, now);
  if (outcome === null) await explainActionMiss(deps, session, bindingId, now, "activate");
  return { result: "completed", outcome, state: await readPushChannel(deps, session, now) };
}

/** POST …/{id}/test：对已激活绑定发一条测试通知；受同绑定冷却、全站测试日量与外发预算约束。 */
export async function testPushBinding(
  deps: PushDeps,
  session: PushSession,
  bindingId: string,
  body: unknown,
  now: number,
): Promise<PushActionResult> {
  const parsed = PushVersionRequestSchema.safeParse(body);
  if (!parsed.success) validation("", "invalid_push_test");
  const { db } = deps;
  const row = await bindingRow(db, session.userId, bindingId);
  if (row === null) notFound();
  if (parsed.data.expected_version !== row.binding_version) refuse("state_mismatch");
  const view = await readPushChannel(deps, session, now);
  const availability = derivePushActions(view, bindingView(row), now).test;
  if (!availability.allowed) refuse(availability.reason, availability.retry_at, now);
  const config = await deps.config();
  if (config === null) refuse("feature_closed");
  const messageId = crypto.randomUUID();
  const day = utcDayPeriod(now).key;
  const daily = pushCounterKeys(day);
  const expiresAt = now + PUSH_TEST_COOLDOWN * 1000;
  const reserved = await conditionalCommit(db, {
    preamble: [counterRow(daily.test, now), counterRow(daily.send, now)],
    guard: new Guard()
      .add(
        // 测试也是账号操作：顺带续租（§9.4"账号操作可续期"）。
        `UPDATE push_bindings SET last_test_at=?, last_test_outcome=NULL, last_test_received_at=NULL,
          lease_expires_at=MAX(COALESCE(lease_expires_at,0),?), binding_version=binding_version+1, updated_at=?
        WHERE id=? AND user_id=? AND binding_version=? AND state='active'
          AND (last_test_at IS NULL OR last_test_at<=?)`,
        now,
        pushLeaseExpiresAt(now),
        now,
        bindingId,
        session.userId,
        row.binding_version,
        now - PUSH_TEST_COOLDOWN * 1000,
      )
      .session(session, now)
      .enabling(session.userId)
      .below(daily.test, PUSH_TEST_DAY)
      .below(daily.send, pushSendDayLimit(false))
      .build(),
    effects: [
      counterIncrement(daily.test, now),
      counterIncrement(daily.send, now),
      messageInsert(messageId, row, "test", day, expiresAt, now),
    ],
  });
  if (reserved.outcome !== "committed")
    await explainActionMiss(deps, session, bindingId, now, "test");
  const secrets = await openBindingSecrets(await deps.keys(), row);
  const outcome = await sendPushMessage(
    { db, config, transport: deps.transport },
    {
      messageId,
      bindingId,
      purpose: "test",
      endpoint: secrets.endpoint,
      keys: secrets.keys,
      payload: testPayload(bindingId, messageId),
      expiresAt,
      urgency: "high",
      leaseVersion: 1,
      attempts: 1,
      deliveryId: null,
    },
    now,
  );
  await db
    .prepare("UPDATE push_bindings SET last_test_outcome=? WHERE id=? AND last_test_at=?")
    .bind(outcome, bindingId, now)
    .run();
  return { result: "completed", outcome, state: await readPushChannel(deps, session, now) };
}

/** POST …/{id}/renew：账号操作续租（§9.4）；只对已激活绑定。 */
export async function renewPushBinding(
  deps: PushDeps,
  session: PushSession,
  bindingId: string,
  body: unknown,
  now: number,
): Promise<PushActionResult> {
  const parsed = PushVersionRequestSchema.safeParse(body);
  if (!parsed.success) validation("", "invalid_push_renew");
  const { db } = deps;
  const row = await bindingRow(db, session.userId, bindingId);
  if (row === null) notFound();
  if (parsed.data.expected_version !== row.binding_version) refuse("state_mismatch");
  const view = await readPushChannel(deps, session, now);
  const availability = derivePushActions(view, bindingView(row), now).renew;
  if (!availability.allowed) refuse(availability.reason);
  const mutations = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
  const outcome = await conditionalCommit(db, {
    preamble: [counterRow(mutations.userKey, now), counterRow(mutations.globalKey, now)],
    guard: new Guard()
      .add(
        `UPDATE push_bindings SET lease_expires_at=?, binding_version=binding_version+1, updated_at=?
        WHERE id=? AND user_id=? AND binding_version=? AND state='active'`,
        pushLeaseExpiresAt(now),
        now,
        bindingId,
        session.userId,
        row.binding_version,
      )
      .session(session, now)
      .enabling(session.userId)
      .below(mutations.userKey, USER_MUTATIONS_DAY)
      .below(mutations.globalKey, GLOBAL_MUTATIONS_DAY)
      .build(),
    effects: [counterIncrement(mutations.userKey, now), counterIncrement(mutations.globalKey, now)],
  });
  if (outcome.outcome !== "committed")
    await explainActionMiss(deps, session, bindingId, now, "renew");
  return { result: "completed", outcome: null, state: await readPushChannel(deps, session, now) };
}

/** DELETE …/{id}：终止路径，幂等；目标已不在本人列表即视为已删除（D3 §3 以 GET 核对）。 */
export async function deletePushBinding(
  deps: PushDeps,
  session: PushSession,
  bindingId: string,
  now: number,
): Promise<{ result: "completed"; state: PushChannelView }> {
  const { db } = deps;
  const outcome = await conditionalCommit(db, {
    guard: new Guard()
      .add("DELETE FROM push_bindings WHERE id=? AND user_id=?", bindingId, session.userId)
      .session(session, now)
      .build(),
  });
  if (outcome.outcome !== "committed") {
    const facts = await readSessionFacts(db, session, now);
    if (facts.session_state !== "active") refuse("pending_activation");
    if (facts.recovery_code_required === 1) refuse("recovery_code_unconfirmed");
  }
  return { result: "completed", state: await readPushChannel(deps, session, now) };
}
