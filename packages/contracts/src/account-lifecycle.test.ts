import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ACTIONS,
  type AccountRecentAuth,
  type AccountSummary,
  AccountSummarySchema,
  deriveAccountActions,
  FEED_MANAGEMENT_ACTIONS,
  feedManagementPermission,
  isSessionExpiryNotice,
  RECENT_AUTH_ACTIONS,
  recentAuthOtpPurpose,
} from "./account-lifecycle";
import {
  RECENT_AUTH_TTL,
  SESSION_ABSOLUTE_TTL,
  SESSION_EXPIRY_NOTICE,
  SESSION_IDLE_TTL,
} from "./params/registry";

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

const now = 1_900_000_000_000;
const facts: AccountSummary = {
  user_id: "synthetic-account",
  server_time: now,
  email: { masked: "s***@example.test", email_version: 1 },
  recovery_code_saved: true,
  recovery_code_generation: 1,
  subscription: { state: "uninitialized" },
  session: {
    state: "active",
    expires_at: now + SESSION_IDLE_TTL * 1_000,
    absolute_expires_at: now + SESSION_ABSOLUTE_TTL * 1_000,
    recovery_code_required: false,
    recovery_login_at: null,
  },
  channels: {
    calendar: { state: "unknown" },
    email: { state: "unknown" },
    push: { state: "unknown" },
  },
  reclaim_grace_until: null,
  recent_auth: { email_change: null, recovery_code_rotate: null, account_delete: null },
};

describe("A-P2-ACCOUNT 事实摘要与浏览器推导", () => {
  it("严格响应 schema 要求全部事实，拒绝动作表、临期结论及证明内容", () => {
    expect(AccountSummarySchema.parse(facts)).toEqual(facts);
    for (const key of Object.keys(facts)) {
      const missing: Record<string, unknown> = { ...facts };
      delete missing[key];
      expect(AccountSummarySchema.safeParse(missing).success).toBe(false);
    }
    for (const extra of ["actions", "proof_id", "target_digest", "secret"]) {
      expect(AccountSummarySchema.safeParse({ ...facts, [extra]: "synthetic" }).success).toBe(
        false,
      );
    }
    expect(
      AccountSummarySchema.safeParse({
        ...facts,
        session: { ...facts.session, expiry_notice: false },
      }).success,
    ).toBe(false);
    expect(
      AccountSummarySchema.safeParse({
        ...facts,
        recent_auth: { ...facts.recent_auth, email_change: undefined },
      }).success,
    ).toBe(false);
  });

  it.each(RECENT_AUTH_ACTIONS)("%s 按校正时刻失效，不依赖本机时钟或摘要读取时刻", (action) => {
    const expiresAt = now + RECENT_AUTH_TTL * 1_000;
    const snapshot = { ...facts, recent_auth: { ...facts.recent_auth, [action]: expiresAt } };
    expect(deriveAccountActions(snapshot, expiresAt - 1)[action]).toEqual({ allowed: true });
    expect(deriveAccountActions(snapshot, expiresAt)[action]).toEqual({
      allowed: false,
      reason: "recent_auth_required",
    });
    expect(deriveAccountActions(snapshot, expiresAt + 1)[action].allowed).toBe(false);
  });

  it.each([false, true])(
    "恢复限制=%s，动作闭合；不受订阅未初始化或恢复码未保存误挡",
    (restricted) => {
      const snapshot = {
        ...facts,
        recovery_code_saved: false,
        session: { ...facts.session, recovery_code_required: restricted },
        recent_auth: Object.fromEntries(
          RECENT_AUTH_ACTIONS.map((a) => [a, now + 1]),
        ) as AccountRecentAuth,
      };
      const actions = deriveAccountActions(snapshot, now);
      expect(Object.keys(actions)).toEqual([...ACCOUNT_ACTIONS]);
      for (const action of ["save_subscription", "email_change", "recovery_code_rotate"] as const) {
        expect(actions[action]).toEqual(
          restricted ? { allowed: false, reason: "recovery_code_unconfirmed" } : { allowed: true },
        );
      }
      expect(actions.export_data).toEqual({ allowed: true });
      expect(actions.account_delete).toEqual({ allowed: true });
    },
  );

  it("恢复登录删除例外使用闭区间，保存新码后不再适用", () => {
    const snapshot = {
      ...facts,
      session: { ...facts.session, recovery_code_required: true, recovery_login_at: now },
    };
    for (const time of [now, now + RECENT_AUTH_TTL * 1_000]) {
      expect(deriveAccountActions(snapshot, time).account_delete).toEqual({ allowed: true });
    }
    for (const time of [now - 1, now + RECENT_AUTH_TTL * 1_000 + 1]) {
      expect(deriveAccountActions(snapshot, time).account_delete).toEqual({
        allowed: false,
        reason: "recent_auth_required",
      });
    }
    expect(
      deriveAccountActions(
        {
          ...snapshot,
          session: {
            ...snapshot.session,
            recovery_code_required: false,
          },
        },
        now,
      ).account_delete.allowed,
    ).toBe(false);
  });

  it("会话临期包含阈值与已到期，参数只取注册表", () => {
    const expiry = now + SESSION_EXPIRY_NOTICE * 1_000;
    expect(isSessionExpiryNotice(expiry + 1, now)).toBe(false);
    expect(isSessionExpiryNotice(expiry, now)).toBe(true);
    expect(isSessionExpiryNotice(expiry - 1, now)).toBe(true);
    expect(isSessionExpiryNotice(now, now)).toBe(true);
    expect(isSessionExpiryNotice(now - 1, now)).toBe(true);
  });
});
