// P2-05 授权跨卡改动：用途守卫改从 contracts 引用，避免恢复入口出现第二份用途定义。
// POST /api/v2/auth/challenges/verify 的业务逻辑（任务卡 P2-02；主方案 §4.3 全段、A.2）。
//
// ★ 关键约束（任务卡「最易错」第 3 条）：Cookie 丢失或响应丢失导致的失败**不得误报为
// 验证码错误**——用户会一直重输一个正确的码。因此错误分层：
//   - 无/坏预认证 Cookie            → 401 unauthorized no_session（重新建立流程）
//   - 上下文有效但无未过期挑战       → validation no_open_challenge（提示重新申请验证码）
//   - 挑战累计错误次数已达上限       → validation attempts_exhausted（须重新申请）
//   - 验证码不匹配                  → validation mismatch（真·验证码错误）
// 四种 reason 互不相同，前端可据稳定短码区分提示，绝不互相冒充。
//
// ★ 关键约束（第 2 条）：错误尝试**持久扣减**。attempts 自增是独立的已提交语句，
// 随后的错误响应不经过任何回滚路径（无事务包裹、无 catch-rollback）。
// 先扣次数再比对：每次比对前先以条件更新抢到一次尝试名额，并发请求不能越过
// OTP_ATTEMPTS 与 EMAIL_VERIFY_ATTEMPTS_HOUR；命中后退回这一次，attempts 只计错误。
//
// P2-03 获准注入点：仅 MAC 命中后的成功出口改为原子消费、pending Session 与回执。
// 消费前若原 preauth 剩余期限不足，先交同值续期 Cookie，客户端重试同一码。
// 邮箱级防猜测边界 EMAIL_VERIFY_ATTEMPTS_HOUR（A.2）按最近一小时 attempts 合计读侧
// 门控（每次错误尝试都持久落行，窗口读即真实计数）。

import {
  AUTH_COMPLETION_TTL,
  canonicalizeEmail,
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  isChallengePurpose,
  OTP_ATTEMPTS,
  OTP_DIGITS,
  PREAUTH_MARGIN,
} from "@hoyo/contracts";
import { ApiError, dummyOtpMacVerify, jsonResponse, parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey, verifyOtpMac } from "../../storage/crypto/mac";
import { clearTerminalOtpPayloads } from "../consume/cleanup";
import { consumeVerifiedOtp } from "../consume/consume";
import { requireOperationKey } from "../consume/operation";
import { serializePendingSessionCookie } from "../consume/session";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../preauth/cookie";
import { authQuotaGuard, readAuthQuotaSnapshot } from "../preauth/quota";
import { renewPreauthCookieForContext } from "./renewal";

/** 单位换算（注册表秒值的换算，不引入第二份业务常量）。 */
const MS_PER_SECOND = 1_000;

export interface VerifyOtpDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  readonly now: () => number;
}

export interface VerifyOtpInput {
  readonly request: Request;
  readonly email: string;
  readonly code: string;
}

/** 待尝试的开放挑战（同一上下文+邮箱可能有多条，最新优先）。 */
interface OpenChallengeRow {
  readonly id: string;
  readonly purpose: string;
  readonly mac: string;
  readonly generation: number;
  readonly attempts: number;
  readonly address_version: number;
}

/** 验证码形状（OTP_DIGITS 位纯数字；结构问题不烧尝试次数，也不进 MAC）。 */
function otpCodeShapeOk(code: string): boolean {
  return new RegExp(`^\\d{${OTP_DIGITS}}$`).test(code);
}

async function loadOpenChallenges(
  db: D1Database,
  preauthId: string,
  emailKey: string,
  now: number,
): Promise<OpenChallengeRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, purpose, mac, generation, attempts, address_version FROM auth_challenges
        WHERE preauth_id = ? AND email_key = ? AND consumed_at IS NULL AND aborted_at IS NULL
          AND deadline > ?
        ORDER BY created_at DESC`,
    )
    .bind(preauthId, emailKey, now)
    .all<OpenChallengeRow>();
  return rows.results ?? [];
}

/** 比对前预扣一次尝试（独立提交；错误响应在其后返回，无回滚可抵消）。未抢到名额不得比对。 */
async function reserveAttempt(
  db: D1Database,
  challengeId: string,
  emailKey: string,
  now: number,
): Promise<boolean> {
  const quota = authQuotaGuard(emailKey, now, "verify");
  const result = await db
    .prepare(
      `UPDATE auth_challenges SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ? AND attempts < ? AND ${quota.sql}`,
    )
    .bind(now, challengeId, now, OTP_ATTEMPTS, ...quota.params)
    .run();
  return result.meta.changes === 1;
}

/** 命中后退回本次预扣：只有知道正确码才会走到这里，错误次数仍只计错误。 */
async function refundAttempt(db: D1Database, challengeId: string, now: number): Promise<void> {
  await db
    .prepare(
      "UPDATE auth_challenges SET attempts = attempts - 1, updated_at = ? WHERE id = ? AND attempts > 0",
    )
    .bind(now, challengeId)
    .run();
}

/**
 * 校验验证码。成功返回 200（附同值续期的预认证 Cookie，为 P2-03 消费交付备足余量，
 * §4.3 续期条款）；失败按上述分层抛 ApiError。
 */
export async function runVerifyOtp(deps: VerifyOtpDeps, input: VerifyOtpInput): Promise<Response> {
  const now = deps.now();

  // —— 邮箱规范化（§4.1 唯一实现；失败属结构问题） ——
  const canonical = canonicalizeEmail(input.email);
  if (!canonical.ok) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "canonicalization_failed" }],
    });
  }

  // —— 预认证上下文（无/坏 Cookie 是「重新建立流程」，不是验证码错误） ——
  const cookieValue = parseCookieHeader(input.request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  if (cookieValue === undefined) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  const preauth = await verifyPreauthCookieValue(deps.keys.preauthCookie(), cookieValue, now);
  if (!preauth.ok) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }

  const emailKey = await computeEmailKey(deps.keys.emailLookup(), canonical.canonical);

  // —— 邮箱级防猜测边界（A.2：读侧门控，先于 MAC 校验以真正约束猜测） ——
  const recentAttempts = (await readAuthQuotaSnapshot(deps.db, emailKey, now)).verifyAttempts;
  if (recentAttempts >= EMAIL_VERIFY_ATTEMPTS_HOUR) {
    throw new ApiError("rate_limited", { code: "rate_limited" });
  }

  // —— 形状（结构问题：不烧次数、不进 MAC） ——
  if (!otpCodeShapeOk(input.code)) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "code", reason: "malformed_code" }],
    });
  }

  const open = await loadOpenChallenges(deps.db, preauth.context.preauthId, emailKey, now);
  if (open.length === 0) {
    // 上下文有效但无未过期挑战（Cookie 换过、挑战过期/终止）：提示重新申请，不是码错。
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "no_open_challenge" }],
    });
  }

  // —— MAC 校验（§4.3 六元组；最新挑战优先；每条都先扣次数再比对） ——
  let candidates = 0;
  let reserved = 0;
  for (const row of open) {
    if (row.attempts >= OTP_ATTEMPTS) {
      continue;
    }
    candidates++;
    if (!(await reserveAttempt(deps.db, row.id, emailKey, now))) {
      continue;
    }
    reserved++;
    if (!isChallengePurpose(row.purpose)) {
      await dummyOtpMacVerify(deps.keys.otpMac());
      continue;
    }
    const matched = await verifyOtpMac(
      deps.keys.otpMac(),
      {
        purpose: row.purpose,
        challengeId: row.id,
        emailKey,
        addressVersion: row.address_version,
        generation: row.generation,
        code: input.code,
      },
      row.mac,
    );
    if (matched) {
      await refundAttempt(deps.db, row.id, now);
      const operationKey = requireOperationKey(input.request);
      // §4.4：先续期，等浏览器确认新 preauth 到手后再消费一次性凭证。
      if (
        preauth.context.expiresAt - now <
        (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * MS_PER_SECOND
      ) {
        const renewal = await renewPreauthCookieForContext(
          deps.db,
          deps.keys.preauthCookie(),
          preauth.context,
          now,
        );
        const response = jsonResponse({ verified: false, preauth_renewal_required: true }, 409);
        response.headers.append("set-cookie", renewal.setCookie);
        response.headers.set("cache-control", "no-store");
        return response;
      }
      const consumed = await consumeVerifiedOtp(
        { db: deps.db, keys: deps.keys },
        {
          verified: {
            id: row.id,
            purpose: row.purpose,
            addressVersion: row.address_version,
            generation: row.generation,
            mac: row.mac,
          },
          preauth: preauth.context,
          emailKey,
          operationKey,
          now,
        },
      );
      if (consumed.outcome === "condition_missed") {
        throw new ApiError("conflict", { code: "conflict" });
      }
      await clearTerminalOtpPayloads(deps.db, now, row.id);
      const renewal = await renewPreauthCookieForContext(
        deps.db,
        deps.keys.preauthCookie(),
        preauth.context,
        now,
      );
      const response = jsonResponse({ verified: true, pending_session_id: consumed.session.id });
      response.headers.append("set-cookie", renewal.setCookie);
      response.headers.append(
        "set-cookie",
        serializePendingSessionCookie(consumed.session.cookieValue),
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }
  }

  // —— 一个名额都没抢到：快照之后被并发请求用尽；邮箱级小时合计到顶时同读侧门控返回 429 ——
  if (reserved === 0) {
    if (
      candidates > 0 &&
      (await readAuthQuotaSnapshot(deps.db, emailKey, now)).verifyAttempts >=
        EMAIL_VERIFY_ATTEMPTS_HOUR
    ) {
      throw new ApiError("rate_limited", { code: "rate_limited" });
    }
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "code", reason: "attempts_exhausted" }],
    });
  }
  // —— 未命中：比对过的挑战都已持久扣减，返回验证码错误 ——
  throw new ApiError("validation", {
    code: "validation",
    fields: [{ path: "code", reason: "mismatch" }],
  });
}
