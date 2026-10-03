import { describe, expect, it } from "vitest";
import { recentAuthOtpPurpose } from "./account-lifecycle";
import { LOGIN_TURNSTILE_ACTION, recentAuthTurnstileAction } from "./turnstile";

describe("A-P2-PREAUTH Turnstile 用途绑定", () => {
  it("登录/注册共享 login；最近认证用途与角色分别绑定，不改变 OTP MAC", () => {
    expect(LOGIN_TURNSTILE_ACTION).toBe("login");
    for (const [action, role, expected] of [
      ["email_change", "current", "email_change_current"],
      ["email_change", "new_address", "email_change_new_address"],
      ["recovery_code_rotate", "current", "recovery_code_rotate_current"],
      ["account_delete", "current", "account_delete_current"],
    ] as const) {
      expect(recentAuthTurnstileAction(action, role)).toBe(expected);
      expect(recentAuthTurnstileAction(action, role)).toMatch(/^[a-zA-Z0-9_-]{1,32}$/);
      expect(recentAuthOtpPurpose(action, role)).toBe(`recent_auth:${action}:${role}`);
    }
  });
  it("非换邮箱用途不接受新地址角色", () => {
    for (const action of ["recovery_code_rotate", "account_delete"] as const)
      expect(() => recentAuthTurnstileAction(action, "new_address")).toThrow();
  });
});
