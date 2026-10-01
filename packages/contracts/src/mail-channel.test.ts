import { describe, expect, it } from "vitest";
import type { MailDayLedgerSnapshot } from "./budget/pools";
import {
  type EmailChannelEnableFacts,
  emailChannelEnableAvailability,
  emailChannelServiceState,
  emailSeatLeaseExpiresAt,
  emailSeatRenewal,
} from "./mail-channel";
import { MAIL_BASE_DAY, MAIL_URGENT_DAY, MAIL_URGENT_FLOOR } from "./params/registry";

const ready: EmailChannelEnableFacts = {
  session_state: "active",
  recovery_code_required: false,
  recovery_code_saved: true,
  subscription_state: "initialized",
  deliverability: "deliverable",
  enabled: false,
  routine_enabled: false,
  remaining: { seat: 1, routine: 1 },
};
describe("A-P4-CONSENT 共享规则", () => {
  it.each([
    [{ session_state: "pending" }, "pending_activation"],
    [{ recovery_code_required: true }, "recovery_code_unconfirmed"],
    [{ recovery_code_saved: false }, "recovery_code_not_saved"],
    [{ subscription_state: "uninitialized" }, "subscription_uninitialized"],
    [{ deliverability: "suppressed" }, "address_suppressed"],
    [{ deliverability: "unknown" }, "deliverability_unknown"],
    [{ remaining: { seat: 0, routine: 1 } }, "capacity_full"],
    [{ remaining: { seat: "unknown", routine: 1 } }, "capacity_unknown"],
  ] as const)("浏览器受阻事实 %j 对应 %s", (overrides, reason) => {
    expect(emailChannelEnableAvailability({ ...ready, ...overrides }, "seat")).toEqual({
      allowed: false,
      reason,
    });
  });
  it("子名额不足不阻止席位；已有席位不再次占位", () => {
    expect(
      emailChannelEnableAvailability({ ...ready, remaining: { seat: 1, routine: 0 } }, "seat"),
    ).toEqual({ allowed: true });
    expect(emailChannelEnableAvailability(ready, "routine")).toEqual({
      allowed: false,
      reason: "seat_required",
    });
    expect(
      emailChannelEnableAvailability(
        { ...ready, enabled: true, remaining: { seat: 0, routine: 0 } },
        "routine",
      ),
    ).toEqual({ allowed: false, reason: "capacity_full" });
    expect(
      emailChannelEnableAvailability(
        { ...ready, enabled: true, remaining: { seat: 0, routine: 0 } },
        "seat",
      ),
    ).toEqual({ allowed: true });
  });
  it("三种活动取最大值；关闭、旧活动与未来水位不续租", () => {
    const current = {
      enabled: true,
      last_renewed_at: 1,
      lease_expires_at: emailSeatLeaseExpiresAt(1),
    };
    const activity = { last_interactive_at: 2, last_feed_poll_at: 4, last_push_processed_at: 3 };
    expect(emailSeatRenewal(activity, current, 4)).toEqual({
      lease_expires_at: emailSeatLeaseExpiresAt(4),
      reason: "last_feed_poll_at",
    });
    expect(emailSeatRenewal(activity, { ...current, enabled: false }, 4)).toBeNull();
    expect(emailSeatRenewal(activity, { ...current, last_renewed_at: 4 }, 4)).toBeNull();
    expect(emailSeatRenewal(activity, current, 3)).toBeNull();
  });
  it("服务状态复用每日预算规则，暂停与未知不标成正常", () => {
    const ledger: MailDayLedgerSnapshot = {
      periodKey: "synthetic",
      pools: {
        existing_auth: { reserved: 0, settled: 0, uncertain: 0 },
        new_registration: { reserved: 0, settled: 0, uncertain: 0 },
        base_business: { reserved: 0, settled: 0, uncertain: 0 },
        urgent_business: { reserved: 0, settled: 0, uncertain: 0 },
      },
    };
    expect(emailChannelServiceState(true, ledger)).toBe("normal");
    ledger.pools.urgent_business.settled = MAIL_URGENT_DAY - MAIL_URGENT_FLOOR;
    expect(emailChannelServiceState(true, ledger)).toBe("budget_limited");
    ledger.pools.urgent_business.settled = 0;
    ledger.pools.base_business.uncertain = MAIL_BASE_DAY;
    expect(emailChannelServiceState(true, ledger)).toBe("budget_limited");
    expect(emailChannelServiceState(false, ledger)).toBe("sending_paused");
    expect(emailChannelServiceState("unknown", ledger)).toBe("unknown");
    expect(emailChannelServiceState(true, null)).toBe("unknown");
  });
});
