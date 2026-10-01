import { describe, expect, it } from "vitest";
import {
  activityTelemetryStale,
  calendarMutationSchema,
  calendarOutputState,
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
