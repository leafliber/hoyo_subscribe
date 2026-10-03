import { describe, expect, it } from "vitest";
import {
  activityTelemetryStale,
  calendarMutationSchema,
  calendarOutputState,
  deriveCalendarActions,
  feedActivityDue,
} from "./calendar-management";
import { FEED_ACTIVITY_WRITE_INTERVAL, RECLAIM_TELEMETRY_STALE_HOURS } from "./params/registry";

describe("A-P3-FEEDAPI D3 草案与合并边界", () => {
  it("四种输出状态不代表客户端已应用", () => {
    expect(calendarOutputState(null, null)).toBe("unknown");
    expect(calendarOutputState(1, null)).toBe("normal");
    expect(calendarOutputState(1, "shrink_guard")).toBe("integrity_blocked");
    expect(calendarOutputState(1, "source_stale")).toBe("unavailable");
  });
  it("合并间隔含等号、遥测过期不含等号且拒绝未来水位", () => {
    const now = 1900000000000;
    const day = FEED_ACTIVITY_WRITE_INTERVAL * 86400000,
      hours = RECLAIM_TELEMETRY_STALE_HOURS * 3600000;
    expect(feedActivityDue(null, now)).toBe(true);
    expect(feedActivityDue(now - day, now)).toBe(true);
    expect(feedActivityDue(now - day + 1, now)).toBe(false);
    expect(activityTelemetryStale(now - hours, now)).toBe(false);
    expect(activityTelemetryStale(now - hours - 1, now)).toBe(true);
    expect(activityTelemetryStale(now + 1, now)).toBe(true);
    expect(activityTelemetryStale(null, now)).toBe(true);
  });
  it("写动作必须显式确认，拒绝用户指定所有者及无效代次", () => {
    for (const input of [
      { confirmed: false, expected_generation: 0 },
      { confirmed: true, expected_generation: -1 },
      { confirmed: true, expected_generation: 0, user_id: "other" },
    ])
      expect(calendarMutationSchema.safeParse(input).success).toBe(false);
  });
});

describe("U20 日历管理准入复用既有权限事实", () => {
  const facts = {
    session: { state: "active", recovery_code_required: false },
    recovery_code_saved: true,
    subscription: { state: "initialized" },
  };
  it("启用、重置不需最近OTP，未保存恢复码仍允许停用", () => {
    expect(deriveCalendarActions(facts)).toEqual({
      enable: { allowed: true },
      disable: { allowed: true },
      reset: { allowed: true },
    });
    const actions = deriveCalendarActions({ ...facts, recovery_code_saved: false });
    expect(actions.enable).toEqual({ allowed: false, reason: "recovery_code_not_saved" });
    expect(actions.reset).toEqual(actions.enable);
    expect(actions.disable.allowed).toBe(true);
  });
  it("受限恢复、pending与未初始化分别给准确原因", () => {
    expect(
      deriveCalendarActions({
        ...facts,
        session: { state: "pending", recovery_code_required: false },
      }).enable,
    ).toEqual({ allowed: false, reason: "pending_activation" });
    expect(
      deriveCalendarActions({
        ...facts,
        session: { state: "active", recovery_code_required: true },
      }).disable,
    ).toEqual({ allowed: false, reason: "recovery_code_unconfirmed" });
    expect(
      deriveCalendarActions({ ...facts, subscription: { state: "uninitialized" } }).enable,
    ).toEqual({ allowed: false, reason: "subscription_uninitialized" });
  });
});
