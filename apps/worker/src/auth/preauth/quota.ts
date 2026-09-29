// 邮箱与全局认证配额（任务卡 P2-01 交付物二第 5 步；主方案 §4.2、附录 A.2）。
//
// 合同约束：
// - 精确配额的唯一权威是 D1（[R16]）：同规范邮箱当日认证意图 EMAIL_AUTH_INTENTS_DAY、
//   发送间隔 OTP_COOLDOWN、同时有效挑战 AUTH_CHALLENGES_PER_EMAIL、全站短期挑战
//   AUTH_CHALLENGES_MAX 合计两张挑战表；重发另记意图，不依赖 outbox 载荷。
// - 全部阈值来自参数注册表（本文件零字面量）；判定是纯函数，供 pipeline 第 5 步与
//   后续任务卡（P2-02 挑战创建）共用同一语义。
// - 这些条件对已注册与未注册邮箱同等适用，不携带存在性信息：超限返回
//   rate_limited（可公开 retry 提示），与存在性折叠（pipeline 第 6/7 步）分离。

import {
  AUTH_CHALLENGES_MAX,
  AUTH_CHALLENGES_PER_EMAIL,
  EMAIL_AUTH_INTENTS_DAY,
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  OTP_COOLDOWN,
  utcDayPeriod,
} from "@hoyo/contracts";

/** 秒→毫秒（注册表秒值的换算，不引入第二份常量）。 */
const MS_PER_SECOND = 1_000;

/** 邮箱/全局维度的精确配额读快照（pipeline 第 5 步一次读齐；同形状查询保证路径等成本）。 */
export interface AuthQuotaSnapshot {
  /** 同规范邮箱当日已创建的认证意图数（登录、重发及重新验证合计）。 */
  readonly emailIntentsToday: number;
  /** 同规范邮箱最近一次创建认证意图的时刻（毫秒）；从未创建为 null。 */
  readonly emailLastIntentAt: number | null;
  /** 同规范邮箱当前有效（未消费、未终止、未到期）挑战数。 */
  readonly emailOpenChallenges: number;
  /** 全站当前有效挑战数（AUTH_CHALLENGES_MAX 口径）。 */
  readonly globalOpenChallenges: number;
}

export type AuthQuotaRejection =
  | { readonly reason: "cooldown"; readonly retryAfterMs: number }
  | { readonly reason: "intents_day" }
  | { readonly reason: "open_challenges" }
  | { readonly reason: "challenges_max" };

/** 精确配额判定（纯函数）：四条之一不满足即拒绝。时间与快照由调用方注入。 */
export function decideAuthQuota(
  snapshot: AuthQuotaSnapshot,
  now: number,
): { readonly ok: true } | { readonly ok: false; readonly rejection: AuthQuotaRejection } {
  if (
    snapshot.emailLastIntentAt !== null &&
    snapshot.emailLastIntentAt + OTP_COOLDOWN * MS_PER_SECOND > now
  ) {
    return {
      ok: false,
      rejection: {
        reason: "cooldown",
        retryAfterMs: snapshot.emailLastIntentAt + OTP_COOLDOWN * MS_PER_SECOND - now,
      },
    };
  }
  if (snapshot.emailIntentsToday >= EMAIL_AUTH_INTENTS_DAY) {
    return { ok: false, rejection: { reason: "intents_day" } };
  }
  if (snapshot.emailOpenChallenges >= AUTH_CHALLENGES_PER_EMAIL) {
    return { ok: false, rejection: { reason: "open_challenges" } };
  }
  if (snapshot.globalOpenChallenges >= AUTH_CHALLENGES_MAX) {
    return { ok: false, rejection: { reason: "challenges_max" } };
  }
  return { ok: true };
}

/** 邮箱意图计数窗口的起点（UTC 日毫秒；与账本周期同用 contracts 的 utcDayPeriod）。 */
export function intentsDayStartMs(now: number): number {
  return utcDayPeriod(now).startMs;
}

/** 同一个 SQL 快照供读侧与条件提交复核；参数数目不随挑战数增长。 */
export function authQuotaSql(emailKey: string, now: number) {
  return {
    sql: `WITH context AS (SELECT ? AS email_key, ? AS now, ? AS day_start),
      challenges AS (
        SELECT email_key,created_at,updated_at,attempts,deadline,consumed_at,aborted_at FROM auth_challenges
        UNION ALL
        SELECT email_key,created_at,updated_at,attempts,deadline,consumed_at,aborted_at FROM recent_auth_challenges
      ), intents AS (
        SELECT email_key,created_at FROM challenges
        UNION ALL SELECT email_key,created_at FROM auth_resend_intents
      ) SELECT
        (SELECT count(*) FROM intents,context c WHERE intents.email_key=c.email_key AND created_at>=c.day_start) AS emailIntentsToday,
        (SELECT max(created_at) FROM intents,context c WHERE intents.email_key=c.email_key) AS emailLastIntentAt,
        (SELECT count(*) FROM challenges,context c WHERE challenges.email_key=c.email_key AND consumed_at IS NULL AND aborted_at IS NULL AND deadline>c.now) AS emailOpenChallenges,
        (SELECT count(*) FROM challenges,context c WHERE consumed_at IS NULL AND aborted_at IS NULL AND deadline>c.now) AS globalOpenChallenges,
        (SELECT coalesce(sum(attempts),0) FROM challenges,context c WHERE challenges.email_key=c.email_key AND updated_at>=c.now-?) AS verifyAttempts`,
    params: [emailKey, now, intentsDayStartMs(now), 3_600 * MS_PER_SECOND],
  };
}

export async function readAuthQuotaSnapshot(db: D1Database, emailKey: string, now: number) {
  const query = authQuotaSql(emailKey, now);
  const row = await db
    .prepare(query.sql)
    .bind(...query.params)
    .first<AuthQuotaSnapshot & { verifyAttempts: number }>();
  if (row === null) throw new Error("认证配额快照缺失");
  return row;
}

/** 重发不增加挑战数，故只复核意图配额；校验仅复核小时错误次数。 */
export function authQuotaGuard(
  emailKey: string,
  now: number,
  mode: "create" | "resend" | "verify" = "create",
) {
  const query = authQuotaSql(emailKey, now);
  if (mode === "verify")
    return {
      sql: `EXISTS (SELECT 1 FROM (${query.sql}) WHERE verifyAttempts < ?)`,
      params: [...query.params, EMAIL_VERIFY_ATTEMPTS_HOUR],
    };
  return {
    sql: `EXISTS (SELECT 1 FROM (${query.sql}) WHERE emailIntentsToday < ?
      AND (emailLastIntentAt IS NULL OR emailLastIntentAt + ? <= ?)
      ${mode === "create" ? "AND emailOpenChallenges < ? AND globalOpenChallenges < ?" : ""})`,
    params: [
      ...query.params,
      EMAIL_AUTH_INTENTS_DAY,
      OTP_COOLDOWN * MS_PER_SECOND,
      now,
      ...(mode === "create" ? [AUTH_CHALLENGES_PER_EMAIL, AUTH_CHALLENGES_MAX] : []),
    ],
  };
}
