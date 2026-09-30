// POST /api/v2/auth/challenges/resend 的业务逻辑（任务卡 P2-02；主方案 §4.3 全段、§7.2、A.2）。
//
// ★ 重发语义（§4.3 原文逐条）：
// - 只旋转**本挑战**的 generation（CAS on generation：UPDATE ... WHERE generation = ?），
//   新验证码 MAC 以新 generation 计算——任意时刻至多一个有效码。
// - **不重置累计失败次数**：attempts 原样保留（次数已耗尽的挑战拒绝重发——发一个永远
//   验不过的码只会浪费预算并误导用户）。
// - **不延长挑战最初截止**：deadline 列不动，开放性谓词按原截止判定。
// - **不废掉其他浏览器的挑战**：所有写语句都以本挑战 id 为谓词。
// - 旧发送任务终止（superseded）并即时清除其验证码密文（§4.3 清除条款），未外发预留
//   归还当日额度（P1-07 release）。
// - **明确重发才创建新发送意图**：网络重试沿用绑定预认证上下文的 idempotency_key
//   （mail_outbox.idempotency_key 全局唯一，取 `<preauth_id>:<key>` 作用域串）；重试与
//   并发重发都不会产生第二份有效码（CAS 输家幂等返回）。
//
// 配额与预算：重发是认证意图（A.2「登录、重发及重新验证合计」），发送间隔 OTP_COOLDOWN
// 与当日合计 EMAIL_AUTH_INTENTS_DAY 共用 preauth/quota 快照：两表首发 + 独立重发意图。
// 占位挑战参与冷却、日限与错码扣次，永远不生成 outbox、不占用预算。
// 预算走 P1-07 认证日池 existing_auth（auth_resend 意图）；当日剩余 <= MAIL_AUTH_FLOOR
// 时 decideMailIntent 拒绝——认证降级期间**全部重发暂停**（§7.2），仅既有账号首次登录
// 仍放行（其判定在准入管线，不经本模块）。
//
// 错误分层与 verify 相同：无/坏 Cookie → 401；无开放挑战 → no_open_challenge（不是码错）。
// P2-03 裁定授权注入：投递串只解挑战独立密文（AAD=auth_challenges.id）；
// 发送载荷清除后仍可重发，列缺失/损坏一律失败关闭，login 失败关闭语义保留。

import {
  canonicalizeEmail,
  decideMailIntent,
  OTP_ATTEMPTS,
  planMailReservation,
  utcDayPeriod,
} from "@hoyo/contracts";
import { ApiError, jsonResponse, parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey, macOtpVerification } from "../../storage/crypto/mac";
import { generateOtpCode } from "../../storage/crypto/random";
import {
  insertUsageRowStatement,
  type MailLedgerStatement,
  mailBudgetCapacityPredicate,
  readMailDayLedger,
  releaseUnsentAuthReservationsStatement,
  reserveMailPoolStatement,
} from "../../storage/ledger/mail-ledger";
import type { PreauthContext } from "../preauth/cookie";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../preauth/cookie";
import { authQuotaGuard, decideAuthQuota, readAuthQuotaSnapshot } from "../preauth/quota";
import { decryptDeliveryAddress } from "./delivery";
import { asEnvelopeBytes, encryptOtpPayload, OTP_PAYLOAD_KIND } from "./payload";
import { renewPreauthCookieForContext } from "./renewal";

/** mail_outbox.priority：同 create-challenge（认证邮件最高优先级，阶梯语义属 P4-03）。 */
const AUTH_MAIL_PRIORITY = 0;

export interface ResendOtpDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  readonly now: () => number;
}

export interface ResendOtpInput {
  readonly request: Request;
  readonly email: string;
  /** 客户端为本次明确重发生成的幂等键；网络重试携带同一键。 */
  readonly idempotencyKey: string;
}

/** 本上下文最新的开放挑战行（重发目标）。 */
interface ChallengeRow {
  readonly id: string;
  readonly purpose: string;
  readonly generation: number;
  readonly attempts: number;
  readonly deadline: number;
  readonly address_version: number;
  readonly recipient_user_id: string | null;
  readonly delivery_address_ciphertext: ArrayBuffer | Uint8Array | null;
}

async function loadLatestOpenChallenge(
  db: D1Database,
  preauthId: string,
  emailKey: string,
  now: number,
): Promise<ChallengeRow | null> {
  return (
    (await db
      .prepare(
        `SELECT c.id, c.purpose, c.generation, c.attempts, c.deadline, c.address_version,
                c.delivery_address_ciphertext,
                (SELECT u.id FROM users u WHERE u.email_key = c.email_key) AS recipient_user_id
           FROM auth_challenges c
          WHERE c.preauth_id = ? AND c.email_key = ? AND c.consumed_at IS NULL
            AND c.aborted_at IS NULL AND c.deadline > ?
          ORDER BY c.created_at DESC LIMIT 1`,
      )
      .bind(preauthId, emailKey, now)
      .first<ChallengeRow>()) ?? null
  );
}

/**
 * 重发只认挑战创建时独立加密的实际投递串。login 与 signup 均不能从请求地址
 * 或发送载荷回退；发送后载荷按 §4.3 清空仍须可重发。失败发生在预算预占前。
 */
async function resolveResendAddress(
  db: D1Database,
  keys: Keyring,
  challenge: ChallengeRow,
): Promise<string> {
  // 所有用途均做同形查询；占位只参与折叠，永不解析为可投递地址。
  const user = await db
    .prepare("SELECT email_version, status FROM users WHERE id = ?")
    .bind(challenge.recipient_user_id)
    .first<{ email_version: number; status: string }>();
  if (challenge.purpose === "equalization") return "";
  if (challenge.purpose === "login") {
    if (challenge.recipient_user_id === null) {
      throw new Error("login 用途重发未找到已验证账号（失败关闭）");
    }
    if (
      user === null ||
      user.email_version !== challenge.address_version ||
      user.status !== "active"
    ) {
      throw new Error("login 用途重发地址版本已变化（失败关闭）");
    }
  }
  if (challenge.delivery_address_ciphertext === null) {
    throw new Error("挑战绑定的投递地址缺失（失败关闭）");
  }
  return decryptDeliveryAddress(
    keys.fieldEncryption(),
    challenge.id,
    asEnvelopeBytes(challenge.delivery_address_ciphertext),
  );
}

function scopedOutboxIdempotencyKey(preauthId: string, clientKey: string): string {
  return `${preauthId}:${clientKey}`;
}

async function finalizeResend(
  deps: ResendOtpDeps,
  context: PreauthContext,
  now: number,
): Promise<Response> {
  const renewal = await renewPreauthCookieForContext(
    deps.db,
    deps.keys.preauthCookie(),
    context,
    now,
  );
  const response = jsonResponse({ resent: true }, 202);
  response.headers.append("set-cookie", renewal.setCookie);
  return response;
}

/** 明确重发：旋转本挑战 generation 并创建新发送意图。 */
export async function runResendOtp(deps: ResendOtpDeps, input: ResendOtpInput): Promise<Response> {
  const now = deps.now();

  const canonical = canonicalizeEmail(input.email);
  if (!canonical.ok) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "canonicalization_failed" }],
    });
  }

  const cookieValue = parseCookieHeader(input.request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  if (cookieValue === undefined) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  const preauth = await verifyPreauthCookieValue(deps.keys.preauthCookie(), cookieValue, now);
  if (!preauth.ok) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }

  const emailKey = await computeEmailKey(deps.keys.emailLookup(), canonical.canonical);

  const replay = await deps.db
    .prepare("SELECT id FROM auth_resend_intents WHERE preauth_id = ? AND idempotency_key = ?")
    .bind(preauth.context.preauthId, input.idempotencyKey)
    .first();
  if (replay !== null) return finalizeResend(deps, preauth.context, now);
  const snapshot = await readAuthQuotaSnapshot(deps.db, emailKey, now);
  const quota = decideAuthQuota(
    { ...snapshot, emailOpenChallenges: 0, globalOpenChallenges: 0 },
    now,
  );
  if (!quota.ok)
    throw new ApiError("rate_limited", {
      code: "rate_limited",
      ...(quota.rejection.reason === "cooldown"
        ? { retry_after_ms: quota.rejection.retryAfterMs }
        : {}),
    });

  // —— 目标挑战（本上下文、本邮箱最新一条开放挑战；不是码错类失败） ——
  const challenge = await loadLatestOpenChallenge(
    deps.db,
    preauth.context.preauthId,
    emailKey,
    now,
  );
  if (challenge === null) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "no_open_challenge" }],
    });
  }
  if (challenge.attempts >= OTP_ATTEMPTS) {
    // 重发不重置累计失败次数（§4.3）：已耗尽的挑战发新码也验不过，拒绝并提示重新申请。
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "code", reason: "attempts_exhausted" }],
    });
  }

  // —— 发信预算（P1-07 认证日池；decideMailIntent 唯一判定源，§7.2 降级暂停重发） ——
  const period = utcDayPeriod(now);
  const ledger = await readMailDayLedger(deps.db, period.key);
  const decision = decideMailIntent("auth_resend", ledger);
  if (decision.decision === "reject") {
    throw new ApiError("rate_limited", {
      code: "rate_limited",
      retry_after_ms: Math.max(1, period.endMsExclusive - now),
    });
  }

  // —— 网络重试幂等：同一 (preauth_id, idempotency_key) 的重发只旋转一次 ——
  const scopedKey = scopedOutboxIdempotencyKey(preauth.context.preauthId, input.idempotencyKey);
  const quotaGuard = authQuotaGuard(emailKey, now, "resend");
  const intentId = crypto.randomUUID();
  const eligible = challenge.purpose !== "equalization";
  // 投递地址不可用仍在任何写入之前失败关闭；占位的空地址只用于丢弃的加密工作。
  const address = await resolveResendAddress(deps.db, deps.keys, challenge);

  // —— 新码 + 新 MAC（六元组以旋转后的 generation 计算）+ 新载荷 ——
  const newGeneration = challenge.generation + 1;
  const code = generateOtpCode();
  const mac = await macOtpVerification(deps.keys.otpMac(), {
    purpose: challenge.purpose,
    challengeId: challenge.id,
    emailKey,
    addressVersion: challenge.address_version,
    generation: newGeneration,
    code,
  });
  const outboxId = crypto.randomUUID();
  const payload = await encryptOtpPayload(deps.keys.fieldEncryption(), outboxId, {
    challengeId: challenge.id,
    generation: newGeneration,
    code,
    address,
  });
  // 预算阈值仍由 contracts 的唯一规则源提供；将预占、旋转、意图、outbox 和旧预留
  // 归还放进一个 D1 batch，避免占位路径另开短路，也不让它短暂占用预算。
  const plan = planMailReservation("auth_resend");
  const capacity = mailBudgetCapacityPredicate(plan, period.key);
  const accepted = "EXISTS (SELECT 1 FROM auth_resend_intents WHERE id = ?)";
  const prepareLedger = (statement: MailLedgerStatement) =>
    deps.db.prepare(statement.sql).bind(...statement.params);
  const rotation = await deps.db.batch([
    prepareLedger(insertUsageRowStatement(plan.pool, period, now)),
    deps.db
      .prepare(`UPDATE auth_challenges SET generation = ?, mac = ?, updated_at = ?
      WHERE id = ? AND generation = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?
        AND attempts < ? AND (purpose <> 'login' OR EXISTS (
          SELECT 1 FROM users u WHERE u.id = ? AND u.email_key = auth_challenges.email_key
            AND u.email_version = auth_challenges.address_version AND u.status = 'active'))
        AND ${quotaGuard.sql}
        AND ${capacity.sql}`)
      .bind(
        newGeneration,
        eligible ? mac : "never-authorize",
        now,
        challenge.id,
        challenge.generation,
        now,
        OTP_ATTEMPTS,
        challenge.recipient_user_id,
        ...quotaGuard.params,
        ...capacity.params,
      ),
    deps.db
      .prepare(`INSERT INTO auth_resend_intents (id,email_key,preauth_id,idempotency_key,created_at)
      SELECT ?,?,?,?,? WHERE changes() = 1`)
      .bind(intentId, emailKey, preauth.context.preauthId, input.idempotencyKey, now),
    // 后续效果都由本次唯一意图 ID 守卫，不依赖可以合法为零行的 outbox 写入。
    prepareLedger(
      reserveMailPoolStatement(
        { pool: plan.pool, periodKey: period.key, now },
        { sql: accepted, params: [intentId] },
        eligible ? 1 : 0,
      ),
    ),
    deps.db
      .prepare(`INSERT INTO mail_outbox (id,purpose,priority,period_key,recipient_user_id,address_version,
      payload_kind,payload_ref,payload_ciphertext,status,idempotency_key,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,'pending',?,?,? WHERE ? AND ${accepted}`)
      .bind(
        outboxId,
        plan.pool,
        AUTH_MAIL_PRIORITY,
        period.key,
        challenge.recipient_user_id,
        challenge.address_version,
        OTP_PAYLOAD_KIND,
        challenge.id,
        payload,
        scopedKey,
        now,
        now,
        eligible ? 1 : 0,
        intentId,
      ),
    prepareLedger(
      releaseUnsentAuthReservationsStatement(challenge.id, outboxId, now, {
        sql: `? AND ${accepted}`,
        params: [eligible ? 1 : 0, intentId],
      }),
    ),
    deps.db
      .prepare(`UPDATE mail_outbox SET status = 'superseded', payload_ciphertext = NULL, updated_at = ?
      WHERE payload_ref = ? AND id <> ? AND status IN ('pending','leased') AND ? AND ${accepted}`)
      .bind(now, challenge.id, outboxId, eligible ? 1 : 0, intentId),
  ]);

  if (rotation[1]?.meta.changes !== 1) {
    // CAS 输家：并发请求已旋转，或挑战刚被消费/终止/到期。
    const replayed = await deps.db
      .prepare("SELECT id FROM auth_resend_intents WHERE preauth_id = ? AND idempotency_key = ?")
      .bind(preauth.context.preauthId, input.idempotencyKey)
      .first();
    if (replayed !== null) {
      return finalizeResend(deps, preauth.context, now);
    }
    if (
      decideMailIntent("auth_resend", await readMailDayLedger(deps.db, period.key)).decision ===
      "reject"
    )
      throw new ApiError("rate_limited", { code: "rate_limited" });
    const stillOpen = await loadLatestOpenChallenge(
      deps.db,
      preauth.context.preauthId,
      emailKey,
      now,
    );
    if (stillOpen !== null) {
      // 不同键的并发赢家刚产出新有效码：如实受理，不再追加旋转。
      return finalizeResend(deps, preauth.context, now);
    }
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "no_open_challenge" }],
    });
  }

  return finalizeResend(deps, preauth.context, now);
}
