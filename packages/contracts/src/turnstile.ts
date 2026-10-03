import type { RecentAuthAction, RecentAuthRole } from "./account-lifecycle";

/** 登录和新注册共用公开入口；不得按账号是否存在改变 action。 */
export const LOGIN_TURNSTILE_ACTION = "login";

const RECENT_AUTH_TURNSTILE_ACTIONS = {
  email_change: { current: "email_change_current", new_address: "email_change_new_address" },
  recovery_code_rotate: { current: "recovery_code_rotate_current" },
  account_delete: { current: "account_delete_current" },
} as const;

export type TurnstileAction =
  | typeof LOGIN_TURNSTILE_ACTION
  | (typeof RECENT_AUTH_TURNSTILE_ACTIONS)[RecentAuthAction]["current"]
  | typeof RECENT_AUTH_TURNSTILE_ACTIONS.email_change.new_address;

/** 用于已验证的最近认证用途/角色；独立于含冒号的 OTP MAC 用途。 */
export function recentAuthTurnstileAction(
  action: RecentAuthAction,
  role: RecentAuthRole,
): TurnstileAction {
  if (role === "new_address") {
    if (action !== "email_change") throw new Error("invalid_turnstile_purpose");
    return RECENT_AUTH_TURNSTILE_ACTIONS.email_change.new_address;
  }
  return RECENT_AUTH_TURNSTILE_ACTIONS[action].current;
}
