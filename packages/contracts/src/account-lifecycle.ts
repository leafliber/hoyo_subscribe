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
  "recovery_code_not_saved",
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
