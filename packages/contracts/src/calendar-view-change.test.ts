import { describe, expect, it } from "vitest";
import { changesCalendarView } from "./calendar-view-change";
import type { SubscriptionConfig } from "./subscription";

const base: SubscriptionConfig = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["livestream"], node_types: ["start"], alarms_enabled: false },
  notifications: {
    rule_ids: [],
    new_event: false,
    important_change: false,
    cancelled_or_retracted: false,
    late_discovery: false,
  },
};

describe("A-P2-SUB 日历视图语义", () => {
  it("变更开关与关闭提醒时的规则变动不取 Feed 版本", () => {
    const changed: SubscriptionConfig = {
      ...base,
      notifications: {
        ...base.notifications,
        important_change: true,
        rule_ids: ["livestream_start_1h"],
      },
    };
    expect(changesCalendarView(base, changed)).toBe(false);
  });

  it("scope、基础筛选、日历提醒开关与已启用提醒的规则变动取版本", () => {
    expect(changesCalendarView(base, { ...base, scope: { ...base.scope, games: ["hsr"] } })).toBe(
      true,
    );
    expect(
      changesCalendarView(base, {
        ...base,
        calendar: { ...base.calendar, event_types: ["maintenance"] },
      }),
    ).toBe(true);
    expect(
      changesCalendarView(base, { ...base, calendar: { ...base.calendar, node_types: ["end"] } }),
    ).toBe(true);
    const alarmed = { ...base, calendar: { ...base.calendar, alarms_enabled: true } };
    expect(changesCalendarView(base, alarmed)).toBe(true);
    expect(
      changesCalendarView(alarmed, {
        ...alarmed,
        notifications: { ...alarmed.notifications, rule_ids: ["livestream_start_1h"] },
      }),
    ).toBe(true);
  });

  it("集合顺序、重复项和配置版本不改变 ICS 语义", () => {
    const changed: SubscriptionConfig = {
      ...base,
      revision: 2,
      scope: { ...base.scope, games: ["genshin", "genshin"] },
    };
    expect(changesCalendarView(base, changed)).toBe(false);
  });
});
