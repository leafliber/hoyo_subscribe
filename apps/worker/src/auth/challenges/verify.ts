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
//
// 本卡到「挑战可被校验」为止：验证成功不消费挑战、不创建会话（P2-03）。
// 邮箱级防猜测边界 EMAIL_VERIFY_ATTEMPTS_HOUR（A.2）按最近一小时 attempts 合计读侧
// 门控（每次错误尝试都持久落行，窗口读即真实计数）。

import {
  canonicalizeEmail,
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  OTP_ATTEMPTS,
  OTP_DIGITS,
} from "@hoyo/contracts";
import { ApiError, jsonResponse, parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey, verifyOtpMac } from "../../storage/crypto/mac";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../preauth/cookie";
import { isChallengePurpose } from "./purposes";
import { renewPreauthCookieForContext } from "./renewal";

/** 单位换算（注册表秒值的换算，不引入第二份业务常量）。 */
const MS_PER_SECOND = 1_000;
const SECONDS_PER_HOUR = 3_600;

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

/** 最近一小时内同邮箱持久化的错误尝试合计（含已到期挑战的行——防猜测边界不因过期豁免）。 */
async function recentVerifyAttempts(
  db: D1Database,
  emailKey: string,
  now: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT coalesce(sum(attempts), 0) AS total FROM auth_challenges WHERE email_key = ? AND updated_at >= ?",
    )
    .bind(emailKey, now - EMAIL_VERIFY_ATTEMPTS_HOUR * SECONDS_PER_HOUR * MS_PER_SECOND)
    .first<{ total: number }>();
  return row?.total ?? 0;
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

/** 持久化一次错误尝试（独立提交；错误响应在其后返回，无回滚可抵消）。 */
async function persistWrongAttempt(
  db: D1Database,
  challengeId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE auth_challenges SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL",
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
  const recentAttempts = await recentVerifyAttempts(deps.db, emailKey, now);
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

  // —— MAC 校验（§4.3 六元组；最新挑战优先） ——
  for (const row of open) {
    if (row.attempts >= OTP_ATTEMPTS) {
      continue;
    }
    if (!isChallengePurpose(row.purpose)) {
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
      // 本卡止于「可被校验」：不消费、不建会话（P2-03 原子消费）。
      // 续期同一 Cookie 值：消费前上下文须具备完成交付剩余期限（§4.4）。
      const renewal = await renewPreauthCookieForContext(
        deps.db,
        deps.keys.preauthCookie(),
        preauth.context,
        now,
      );
      const response = jsonResponse({ verified: true, challenge_id: row.id });
      response.headers.append("set-cookie", renewal.setCookie);
      return response;
    }
  }

  // —— 未命中：持久扣减（最新一条未耗尽的挑战），再返回验证码错误 ——
  const chargeable = open.find((row) => row.attempts < OTP_ATTEMPTS);
  if (chargeable === undefined) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "code", reason: "attempts_exhausted" }],
    });
  }
  await persistWrongAttempt(deps.db, chargeable.id, now);
  throw new ApiError("validation", {
    code: "validation",
    fields: [{ path: "code", reason: "mismatch" }],
  });
}
