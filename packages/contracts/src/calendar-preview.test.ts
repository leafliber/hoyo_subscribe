import { describe, expect, it } from "vitest";
import {
  CalendarPreviewItemSchema,
  CalendarPreviewNodeSchema,
  calendarPreviewCandidates,
  explainCalendarPreview,
} from "./calendar-preview";
import { EVENT_TYPES, NODE_TYPES } from "./enums";
import { feedWindow, personalCalendarNodes, requiredCalendarSources } from "./personal-calendar";
import { decideCalendarPatch, type PublicSnapshotNode } from "./public-calendar";
import { REMINDER_RULES } from "./rules";
import type { SubscriptionConfig } from "./subscription";
import { TimeValueSchema } from "./time";

const now = Date.parse("2026-10-02T12:00:00Z");
const config: SubscriptionConfig = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: [...EVENT_TYPES], node_types: [...NODE_TYPES], alarms_enabled: true },
  notifications: {
    rule_ids: REMINDER_RULES.map((r) => r.rule_id),
    new_event: false,
    important_change: false,
    cancelled_or_retracted: false,
    late_discovery: false,
  },
};
type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : { -readonly [K in keyof T]: Mutable<T[K]> };
function node(id: string, ms = now): Mutable<PublicSnapshotNode> {
  return {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    source_projection_json: "internal",
    tombstone: false,
    patch: null,
    projection: {
      event_id: "synthetic-event",
      milestone_id: id,
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "synthetic",
        summary: null,
        official_url: null,
        human_locked: true,
      },
      milestone: {
        milestone_key: id,
        node_type: "end",
        title: "synthetic end",
        human_locked: true,
        time: TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: ms,
          source_timezone: "UTC",
          raw_expression: "synthetic time",
          time_basis: "official_explicit",
        }),
      },
    },
  };
}
function fixture() {
  const unknown = node("unknown");
  unknown.projection.milestone.time = TimeValueSchema.parse({
    precision: "unknown",
    source_timezone: "UTC",
    raw_expression: "synthetic TBD",
    time_basis: "unresolved",
  });
  const date = node("date");
  date.projection.milestone.time = TimeValueSchema.parse({
    precision: "date",
    date: "2026-10-02",
    source_timezone: "UTC+8",
    raw_expression: "synthetic day",
    time_basis: "official_explicit",
  });
  const estimate = node("estimate");
  estimate.projection.milestone.time.time_basis = "official_estimate";
  const past = node("past", feedWindow(now).start - 1);
  const expired = node("expired");
  expired.tombstone = true;
  const expiredPatch = node("expired-patch");
  expiredPatch.tombstone = true;
  expiredPatch.patch = {
    ...requireValue(decideCalendarPatch(expiredPatch.projection, null, null, now)),
    retain_until: now,
  };
  const moved = node("moved", feedWindow(now).end + 86400000);
  moved.patch = decideCalendarPatch(node("moved").projection, moved.projection, null, now);
  const cancelled = node("cancelled");
  cancelled.projection.event.status = "cancelled";
  cancelled.patch = decideCalendarPatch(
    node("cancelled").projection,
    cancelled.projection,
    null,
    now,
  );
  const retracted = node("retracted");
  retracted.projection.event.status = "retracted";
  retracted.patch = decideCalendarPatch(
    node("retracted").projection,
    retracted.projection,
    null,
    now,
  );
  const deleted = node("deleted");
  deleted.tombstone = true;
  deleted.patch = decideCalendarPatch(deleted.projection, null, null, now);
  const pending = node("pending");
  pending.projection.event.status = "postponed";
  pending.projection.milestone.time = unknown.projection.milestone.time;
  pending.patch = decideCalendarPatch(node("pending").projection, pending.projection, null, now);
  return [
    node("same", feedWindow(now).start - 1),
    past,
    expired,
    expiredPatch,
    node("same"),
    unknown,
    date,
    estimate,
    moved,
    cancelled,
    retracted,
    deleted,
    pending,
  ];
}
describe("A-P3-PREVIEW contracts 唯一投影", () => {
  it("浏览器候选集合与服务端整代逐项等价：历史、重复、墓碑、未知时间补集", () => {
    const all = fixture(),
      candidates = calendarPreviewCandidates(all, now);
    expect(candidates.map((n) => n.projection.milestone_id)).not.toEqual(
      expect.arrayContaining(["past", "expired", "expired-patch"]),
    );
    expect(candidates.filter((n) => n.projection.milestone_id === "same")).toHaveLength(1);
    expect(candidates.some((n) => n.projection.milestone_id === "unknown")).toBe(true);
    for (const event_types of [config.calendar.event_types, []])
      for (const node_types of [config.calendar.node_types, ["start"] as const])
        for (const alarms_enabled of [true, false])
          for (const games of [config.scope.games, []]) {
            const selection = {
              ...config,
              scope: { ...config.scope, games },
              calendar: { event_types, node_types, alarms_enabled },
            };
            expect(explainCalendarPreview(selection, candidates, now)).toEqual(
              explainCalendarPreview(selection, all, now),
            );
          }
    const encoded = JSON.stringify(candidates);
    for (const field of ["human_locked", "source_projection_json", "public_ical_revision", "uid"])
      expect(encoded).not.toContain(field);
    for (const n of candidates) expect(CalendarPreviewNodeSchema.safeParse(n).success).toBe(true);
  });
  it("条目时间、取消、更正与实际 Feed 投影逐项相同；未知时间只计数不输出", () => {
    const all = fixture();
    const result = explainCalendarPreview(config, all, now);
    const feed = personalCalendarNodes(config, all, now);
    expect(result.omitted).toEqual({ unknownTime: 1, reminderNotExact: 0 });
    for (const item of result.items) {
      expect(CalendarPreviewItemSchema.safeParse(item).success).toBe(true);
      const original = requireValue(
        feed.find((n) => n.node.projection.milestone_id === item.milestoneId),
      );
      expect([item.time, item.cancelled, item.alarm?.leadSeconds ?? [], item.inBaseWindow]).toEqual(
        [original.time, original.cancelled, original.alarm_seconds, original.base],
      );
    }
    expect(result.items.find((n) => n.milestoneId === "moved")).toMatchObject({
      inBaseWindow: false,
      patch: { kind: "rescheduled" },
    });
    for (const id of ["cancelled", "retracted", "deleted", "pending"])
      expect(result.items.find((n) => n.milestoneId === id)).toMatchObject({
        cancelled: true,
        alarm: { leadSeconds: [], blocked: "cancelled" },
      });
    expect(result.items.find((n) => n.milestoneId === "date")?.alarm?.blocked).toBe("date_only");
    expect(result.items.find((n) => n.milestoneId === "estimate")?.alarm?.blocked).toBe(
      "estimated",
    );
  });
  it("hiddenBy 含两类筛选；纯日期/预计关联省略；关闭提醒只保留基础节点", () => {
    for (const hidden of [["event_type"], ["node_type"], ["event_type", "node_type"]]) {
      const selection = {
        ...config,
        calendar: {
          ...config.calendar,
          event_types: hidden.includes("event_type") ? [] : config.calendar.event_types,
          node_types: hidden.includes("node_type") ? [] : config.calendar.node_types,
        },
      };
      const result = explainCalendarPreview(selection, fixture(), now);
      expect(result.omitted).toEqual({ unknownTime: 1, reminderNotExact: 2 });
      expect(result.items[0]?.inclusion).toEqual({
        kind: "reminder_associated",
        hiddenBy: hidden,
        ruleIds: ["limited_end_1d"],
      });
      expect(
        explainCalendarPreview(
          { ...selection, calendar: { ...selection.calendar, alarms_enabled: false } },
          fixture(),
          now,
        ).items,
      ).toEqual([]);
    }
    const off = explainCalendarPreview(
      { ...config, calendar: { ...config.calendar, alarms_enabled: false } },
      fixture(),
      now,
    );
    expect(off.items).toHaveLength(personalCalendarNodes(config, fixture(), now).length);
    expect(off.items.every((n) => n.alarm?.blocked === "alarms_disabled")).toBe(true);
  });
  it("北京时间日期分组：同日 datetime 时间在前、date 在后，再按身份", () => {
    const a = node("a", Date.parse("2026-10-01T16:00:00Z"));
    const b = node("b", now);
    const dated = requireValue(fixture().find((n) => n.projection.milestone_id === "date"));
    expect(
      explainCalendarPreview(config, [dated, b, a], now).items.map((n) => n.milestoneId),
    ).toEqual(["a", "b", "date"]);
  });
  it("来源规则保持旧 Feed 的区服大小写处理与正文通道筛选", () => {
    const sources = [
      { sourceId: "yes", game: "genshin", region: "cn" },
      { sourceId: "upper", game: "genshin", region: "CN" },
      { sourceId: "disabled", game: "genshin", region: "cn", contentChannelDisabled: true },
      { sourceId: "other", game: "hsr", region: "cn" },
    ];
    expect(requiredCalendarSources(config, sources).map((s) => s.sourceId)).toEqual(["yes"]);
  });
});

function requireValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture missing");
  return value;
}

it("A-P3-PREVIEW 未知补集：有效更正优先、恰好到期、未知墓碑及重复代表", () => {
  const unknown = node("same");
  unknown.projection.event.status = "postponed";
  unknown.projection.milestone.time = TimeValueSchema.parse({
    precision: "unknown",
    source_timezone: "UTC",
    raw_expression: "synthetic TBD",
    time_basis: "unresolved",
  });
  const patch = requireValue(
    decideCalendarPatch(node("same").projection, unknown.projection, null, now),
  );
  const pending = { ...unknown, patch: { ...patch, retain_until: now + 1 } };
  const tombstone = {
    ...unknown,
    tombstone: true,
    projection: { ...unknown.projection, milestone_id: "tombstone-unknown" },
  };
  const all = [node("same"), pending, tombstone];
  const before = explainCalendarPreview(config, all, now);
  expect(before.omitted.unknownTime).toBe(0);
  expect(before.items).toHaveLength(1);
  expect(before.items[0]).toMatchObject({ cancelled: true, patch: { kind: "postponed_unknown" } });
  for (const asOf of [now, now + 1]) {
    const candidates = calendarPreviewCandidates(all, asOf);
    expect(explainCalendarPreview(config, candidates, asOf)).toEqual(
      explainCalendarPreview(config, all, asOf),
    );
    expect(candidates).toHaveLength(1);
  }
  expect(explainCalendarPreview(config, all, now + 1)).toMatchObject({
    items: [],
    omitted: { unknownTime: 1 },
    nodeLimit: null,
  });
  // 后出现的代表决定一切，不能先过滤未知或历史再去重。
  const replaced = [unknown, node("same", feedWindow(now).start - 1)];
  expect(calendarPreviewCandidates(replaced, now)).toEqual([]);
  expect(explainCalendarPreview(config, replaced, now).omitted.unknownTime).toBe(0);
});
