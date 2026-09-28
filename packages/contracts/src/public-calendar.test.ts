// P3-05 获准跨卡测试：§6.3 更正分类、日期保留与连续改期只在合同层判定。
import { describe, expect, it } from "vitest";
import { CAL_PATCH_MIN_DAYS, CAL_PATCH_TAIL_DAYS } from "./params/registry";
import type { PublicCalendarProjection } from "./public-calendar";
import {
  CALENDAR_PATCH_KIND,
  calendarPatchExtendsWindow,
  decideCalendarPatch,
} from "./public-calendar";
import { TimeValueSchema } from "./time";

const day = 86_400_000;
const at = (value: number) =>
  TimeValueSchema.parse({
    precision: "datetime",
    utc_ms: value,
    source_timezone: "UTC",
    raw_expression: "已公布时间",
    time_basis: "official_explicit",
  });
function projection(time = at(170 * day)): PublicCalendarProjection {
  return {
    event_id: "event",
    milestone_id: "node",
    event: {
      event_type: "limited_event",
      status: "scheduled",
      title: "活动",
      summary: null,
      official_url: null,
      human_locked: false,
    },
    milestone: {
      milestone_key: "start",
      node_type: "start",
      title: "开始",
      time,
      human_locked: false,
    },
  };
}

describe("A-P3-PATCH 合同判定", () => {
  it("连续改期累计旧时间水位，保留截止取两个合同参数的 max", () => {
    const first = decideCalendarPatch(projection(), projection(at(200 * day)), null, day);
    expect(first?.kind).toBe(CALENDAR_PATCH_KIND.RESCHEDULED);
    const second = decideCalendarPatch(
      projection(at(200 * day)),
      projection(at(150 * day)),
      first ?? null,
      2 * day,
    );
    expect(second?.old_time).toEqual(at(200 * day));
    expect(second?.retain_until).toBe(
      Math.max(2 * day + CAL_PATCH_MIN_DAYS * day, (200 + CAL_PATCH_TAIL_DAYS) * day),
    );
  });

  it("取消、撤回、删除、延期未知用旧已发布时间；分类纠正不改时间", () => {
    const old = projection();
    const cancelled = { ...old, event: { ...old.event, status: "cancelled" as const } };
    const retracted = { ...old, event: { ...old.event, status: "retracted" as const } };
    const postponed = {
      ...old,
      event: { ...old.event, status: "postponed" as const },
      milestone: {
        ...old.milestone,
        time: TimeValueSchema.parse({
          precision: "unknown",
          source_timezone: "UTC",
          raw_expression: "延期",
          time_basis: "unresolved",
        }),
      },
    };
    const category = { ...old, event: { ...old.event, event_type: "gacha" as const } };
    expect(decideCalendarPatch(old, cancelled, null, day)?.kind).toBe(
      CALENDAR_PATCH_KIND.CANCELLED,
    );
    expect(decideCalendarPatch(old, retracted, null, day)?.kind).toBe(
      CALENDAR_PATCH_KIND.RETRACTED,
    );
    const cancelledPatch = decideCalendarPatch(old, cancelled, null, day);
    expect(decideCalendarPatch(cancelled, old, cancelledPatch, 2 * day)?.kind).toBe(
      CALENDAR_PATCH_KIND.RESTORED,
    );
    expect(decideCalendarPatch(old, null, null, day)?.kind).toBe(CALENDAR_PATCH_KIND.DELETED);
    expect(decideCalendarPatch(old, postponed, null, day)?.display_time).toEqual(
      old.milestone.time,
    );
    expect(decideCalendarPatch(old, category, null, day)?.kind).toBe(
      CALENDAR_PATCH_KIND.CLASSIFICATION_CORRECTED,
    );
    const standalone = decideCalendarPatch(old, category, null, day);
    expect(standalone && calendarPatchExtendsWindow(standalone)).toBe(false);
    const rescheduled = decideCalendarPatch(old, projection(at(200 * day)), null, day);
    const correctedAfterReschedule = decideCalendarPatch(
      projection(at(200 * day)),
      { ...category, milestone: { ...category.milestone, time: at(200 * day) } },
      rescheduled,
      2 * day,
    );
    expect(correctedAfterReschedule && calendarPatchExtendsWindow(correctedAfterReschedule)).toBe(
      true,
    );
    expect(decideCalendarPatch(old, old, null, day)).toBeNull();
  });
});
