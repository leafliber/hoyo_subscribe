// 邮箱与全局认证配额（任务卡 P2-01 交付物二第 5 步；主方案 §4.2、附录 A.2）。
//
// 合同约束：
// - 精确配额的唯一权威是 D1（[R16]）：同规范邮箱当日认证意图 EMAIL_AUTH_INTENTS_DAY、
//   发送间隔 OTP_COOLDOWN、同时有效挑战 AUTH_CHALLENGES_PER_EMAIL、全站短期挑战
//   AUTH_CHALLENGES_MAX 全部按 auth_challenges 实表计数，不走近似门。
// - 全部阈值来自参数注册表（本文件零字面量）；判定是纯函数，供 pipeline 第 5 步与
//   后续任务卡（P2-02 挑战创建）共用同一语义。
// - 这些条件对已注册与未注册邮箱同等适用，不携带存在性信息：超限返回
//   rate_limited（可公开 retry 提示），与存在性折叠（pipeline 第 6/7 步）分离。

import {
  AUTH_CHALLENGES_MAX,
  AUTH_CHALLENGES_PER_EMAIL,
  EMAIL_AUTH_INTENTS_DAY,
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
