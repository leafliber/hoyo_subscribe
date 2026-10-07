import { z } from "zod";
import { SessionStatusSchema, SubscriptionStateSchema } from "./enums";
import { RECENT_AUTH_TTL, SESSION_EXPIRY_NOTICE } from "./params/registry";

// P2-07：危险操作的用途、证明角色与 D3 §1.2 动作原因在此唯一登记。
// `deleting` 是 §9.6 的终止状态；P5-02 可在同一来源追加回收状态。
export const ACCOUNT_DELETING_STATUS = "deleting" as const;

export const RECENT_AUTH_ACTIONS = [
  "email_change",
  "recovery_code_rotate",
  "account_delete",
] as const;
export type RecentAuthAction = (typeof RECENT_AUTH_ACTIONS)[number];

export const RECENT_AUTH_ROLES = ["current", "new_address"] as const;
export type RecentAuthRole = (typeof RECENT_AUTH_ROLES)[number];

export function isRecentAuthAction(value: string): value is RecentAuthAction {
  return (RECENT_AUTH_ACTIONS as readonly string[]).includes(value);
}

export function isRecentAuthRole(value: string): value is RecentAuthRole {
  return (RECENT_AUTH_ROLES as readonly string[]).includes(value);
}

/** OTP MAC 的用途字段也隔离动作和邮箱角色，既有 login/signup MAC 不受影响。 */
export function recentAuthOtpPurpose(action: RecentAuthAction, role: RecentAuthRole): string {
  return `recent_auth:${action}:${role}`;
}

export const ACCOUNT_ACTIONS = [
  "save_subscription",
  "export_data",
  "email_change",
  "recovery_code_rotate",
  "account_delete",
] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

export const ACTION_BLOCK_REASONS = [
  "pending_activation",
  "recovery_code_unconfirmed",
  "subscription_uninitialized",
  "recent_auth_required",
  "capacity_full",
  "quota_paused",
  "feature_closed",
] as const;
export type ActionBlockReason = (typeof ACTION_BLOCK_REASONS)[number];

export type ActionAvailability = { allowed: true } | { allowed: false; reason: ActionBlockReason };

/** §4.7：Feed 三个管理动作等权，不升级为用途限定 OTP；P3-07 负责实际限速。 */
export const FEED_MANAGEMENT_ACTIONS = ["enable", "disable", "reset"] as const;
export type FeedManagementAction = (typeof FEED_MANAGEMENT_ACTIONS)[number];

export function feedManagementPermission(_action: FeedManagementAction): {
  readonly activeSession: true;
  readonly csrf: true;
  readonly explicitConfirmation: true;
  readonly rateLimit: true;
  readonly recentAuth: false;
} {
  return {
    activeSession: true,
    csrf: true,
    explicitConfirmation: true,
    rateLimit: true,
    recentAuth: false,
  };
}

/** D3 §1.2/§2.10：只给当前会话可用证明的到期时间，不含证明或目标摘要。 */
export const AccountRecentAuthSchema = z.strictObject({
  email_change: z.int().nullable(),
  recovery_code_rotate: z.int().nullable(),
  account_delete: z.int().nullable(),
});
export type AccountRecentAuth = z.infer<typeof AccountRecentAuthSchema>;

/** GET /api/v2/me；仅已认证的 active 会话可读取。缺失事实不默认为成功。 */
export const AccountSummarySchema = z.strictObject({
  user_id: z.string().min(1),
  server_time: z.int(),
  // Signup persists the first binding at version 0; subsequent address changes increment it.
  email: z.strictObject({ masked: z.string(), email_version: z.int().nonnegative() }),
  recovery_code_saved: z.boolean(),
  recovery_code_generation: z.int().positive().nullable(),
  subscription: z.strictObject({ state: SubscriptionStateSchema }),
  session: z.strictObject({
    state: SessionStatusSchema,
    expires_at: z.int(),
    absolute_expires_at: z.int(),
    recovery_code_required: z.boolean(),
    recovery_login_at: z.int().nullable(),
  }),
  channels: z.strictObject({
    calendar: z.strictObject({ state: z.literal("unknown") }),
    email: z.union([
      z.strictObject({ state: z.literal("unknown") }),
      z.strictObject({ state: z.enum(["enabled", "disabled"]), routine_enabled: z.boolean() }),
    ]),
    // P6（ADR-0025）：Push 一行只给计数事实；读取失败仍是 unknown。
    push: z.union([
      z.strictObject({ state: z.literal("unknown") }),
      z.strictObject({
        state: z.enum(["none", "active", "inactive"]),
        pending: z.int().nonnegative(),
        active: z.int().nonnegative(),
        paused: z.int().nonnegative(),
        gone: z.int().nonnegative(),
      }),
    ]),
  }),
  reclaim_grace_until: z.int().nullable(),
  recent_auth: AccountRecentAuthSchema,
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/**
 * D3 §1.2：浏览器以 server_time 校正后的时刻调用；只是展示提示，写接口仍实时校验。
 * 只用于成功读取的 active 摘要，不代表会话授权、目标选择或日额度承诺。
 * 恢复登录的删除例外只适用于新码尚未确认的会话，边界沿用写接口的闭区间。
 */
export function deriveAccountActions(
  facts: AccountSummary,
  now: number,
): Record<AccountAction, ActionAvailability> {
  const allowed: ActionAvailability = { allowed: true };
  const unavailable: ActionAvailability = { allowed: false, reason: "recent_auth_required" };
  const restricted: ActionAvailability = { allowed: false, reason: "recovery_code_unconfirmed" };
  const hasProof = (action: RecentAuthAction) => {
    const expiresAt = facts.recent_auth[action];
    return expiresAt !== null && expiresAt > now;
  };
  const recoveryLoginAt = facts.session.recovery_login_at;
  const recoveryLoginRecent =
    recoveryLoginAt !== null &&
    recoveryLoginAt <= now &&
    recoveryLoginAt >= now - RECENT_AUTH_TTL * 1_000;
  return {
    save_subscription: facts.session.recovery_code_required ? restricted : allowed,
    export_data: allowed,
    email_change: facts.session.recovery_code_required
      ? restricted
      : hasProof("email_change")
        ? allowed
        : unavailable,
    recovery_code_rotate: facts.session.recovery_code_required
      ? restricted
      : hasProof("recovery_code_rotate")
        ? allowed
        : unavailable,
    account_delete:
      hasProof("account_delete") || (facts.session.recovery_code_required && recoveryLoginRecent)
        ? allowed
        : unavailable,
  };
}

/** SESSION_EXPIRY_NOTICE 来自注册表；毫秒边界及已到期行为与原摘要一致。 */
export function isSessionExpiryNotice(expiresAt: number, now: number): boolean {
  return expiresAt - now <= SESSION_EXPIRY_NOTICE * 1_000;
}
