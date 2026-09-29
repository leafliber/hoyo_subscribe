import { describe, expect, it } from "vitest";
import {
  FEED_MANAGEMENT_ACTIONS,
  feedManagementPermission,
  recentAuthOtpPurpose,
} from "./account-lifecycle";

describe("A-P2-ACCOUNT 纯权限合同", () => {
  it("Feed enable/disable/reset 权限相同且均不要求额外 OTP", () => {
    const permissions = FEED_MANAGEMENT_ACTIONS.map(feedManagementPermission);
    expect(new Set(permissions.map((permission) => JSON.stringify(permission))).size).toBe(1);
    expect(permissions[0]).toMatchObject({
      activeSession: true,
      csrf: true,
      explicitConfirmation: true,
      rateLimit: true,
      recentAuth: false,
    });
  });

  it("最近认证 OTP MAC 用途按操作和地址角色隔离", () => {
    expect(recentAuthOtpPurpose("email_change", "current")).not.toBe(
      recentAuthOtpPurpose("email_change", "new_address"),
    );
    expect(recentAuthOtpPurpose("account_delete", "current")).not.toBe(
      recentAuthOtpPurpose("recovery_code_rotate", "current"),
    );
  });
});
