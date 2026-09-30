import { describe, expect, it } from "vitest";
import {
  FEED_FUTURE_DAYS,
  FEED_MAX_STALE,
  FEED_PAST_DAYS,
  FEED_SHRINK_GUARD_MIN,
  FEED_SHRINK_GUARD_RATIO,
} from "./params/registry";
import {
  feedIdentity,
  feedNaturalExitAt,
  feedShrinkBlocked,
  feedSourcesFresh,
  feedWindow,
  personalCalendarNodes,
} from "./personal-calendar";
import { decideCalendarPatch, type PublicSnapshotNode } from "./public-calendar";
import type { SubscriptionConfig } from "./subscription";
import { TimeValueSchema } from "./time";

const day = 86_400_000,
  now = Date.parse("2026-09-30T12:00:00Z");
const config: SubscriptionConfig = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
  notifications: {
    rule_ids: ["limited_end_1d"],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  },
};
type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : { -readonly [K in keyof T]: Mutable<T[K]> };
function node(id = "node", ms = now): Mutable<PublicSnapshotNode> {
  return {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    patch: null,
    tombstone: false,
    source_projection_json: null,
    projection: {
      event_id: "event",
      milestone_id: id,
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "活动",
        summary: null,
        official_url: null,
        human_locked: false,
      },
      milestone: {
        milestone_key: id,
        node_type: "start",
        title: "开始",
        human_locked: false,
        time: TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: ms,
          source_timezone: "UTC",
          raw_expression: "明确",
          time_basis: "official_explicit",
        }),
      },
    },
  };
}
function changed(old: PublicSnapshotNode, current: PublicSnapshotNode): PublicSnapshotNode {
  return {
    ...current,
    public_ical_revision: old.public_ical_revision + 1,
    patch: decideCalendarPatch(old.projection, current.projection, old.patch, now),
  };
}
describe("A-P3-ICS 个人窗口、闹钟与缩水唯一规则", () => {
  it("UTC 日桶边界与 DATE 日期语义", () => {
    const w = feedWindow(now);
    expect(w.start).toBe(Date.parse("2026-09-30T00:00:00Z") - FEED_PAST_DAYS * day);
    expect(w.end).toBe(Date.parse("2026-09-30T00:00:00Z") + (FEED_FUTURE_DAYS + 1) * day);
    expect(
      personalCalendarNodes(
        config,
        [node("a", w.start - 1), node("b", w.start), node("c", w.end - 1), node("d", w.end)],
        now,
      ).map((n) => n.node.projection.milestone_id),
    ).toEqual(["b", "c"]);
    const date = node();
    date.projection.milestone.time = TimeValueSchema.parse({
      precision: "date",
      date: "2026-09-30",
      source_timezone: "UTC+8",
      raw_expression: "当天",
      time_basis: "official_explicit",
    });
    expect(personalCalendarNodes(config, [date], now)[0]?.time.precision).toBe("date");
  });
  it("提醒关联不与基础筛选相交，同 UID 去重且受 scope 约束", () => {
    const end = node();
    end.projection.milestone.node_type = "end";
    const selected = personalCalendarNodes(config, [end, end], now);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.alarm_seconds).toEqual([86400]);
    expect(
      personalCalendarNodes(
        { ...config, calendar: { ...config.calendar, alarms_enabled: false } },
        [end],
        now,
      ),
    ).toHaveLength(0);
    expect(
      personalCalendarNodes({ ...config, scope: { games: ["hsr"], regions: ["CN"] } }, [end], now),
    ).toHaveLength(0);
  });
  it("预计、未知不生成精确闹钟；只有提醒关联的无资格节点不补入", () => {
    const end = node();
    end.projection.milestone.node_type = "end";
    end.projection.milestone.time.time_basis = "official_estimate";
    expect(personalCalendarNodes(config, [end], now)).toHaveLength(0);
    const base = { ...config, calendar: { ...config.calendar, node_types: ["end" as const] } };
    expect(personalCalendarNodes(base, [end], now)[0]?.alarm_seconds).toEqual([]);
    end.projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      source_timezone: "UTC",
      raw_expression: "待定",
      time_basis: "unresolved",
    });
    expect(personalCalendarNodes(base, [end], now)).toHaveLength(0);
  });
  it("跨未来窗口改期显示真实新时刻；更正到期回归窗口", () => {
    const moved = changed(node(), node("node", now + (FEED_FUTURE_DAYS + 20) * day));
    expect(personalCalendarNodes(config, [moved], now)[0]).toMatchObject({
      base: false,
      patch: true,
      cancelled: false,
    });
    if (moved.patch === null) throw new Error("缺少补偿");
    expect(
      personalCalendarNodes(
        config,
        [{ ...moved, patch: { ...moved.patch, retain_until: now } }],
        now,
      ),
    ).toHaveLength(0);
  });
  it("未知延期沿用旧时刻 CANCELLED；恢复同 UID、更高 SEQUENCE", () => {
    const old = node(),
      postponed = node();
    postponed.projection.event.status = "postponed";
    postponed.projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      source_timezone: "UTC",
      raw_expression: "延期",
      time_basis: "unresolved",
    });
    const patch = changed(old, postponed);
    expect(personalCalendarNodes(config, [patch], now)[0]).toMatchObject({
      cancelled: true,
      time: old.projection.milestone.time,
      alarm_seconds: [],
    });
    const restored = changed(patch, node());
    const a = feedIdentity("namespace", "node", patch.public_ical_revision, 0),
      b = feedIdentity("namespace", "node", restored.public_ical_revision, 0);
    expect(a.uid).toBe(b.uid);
    expect(b.sequence).toBeGreaterThan(a.sequence);
    expect(personalCalendarNodes(config, [restored], now)[0]?.cancelled).toBe(false);
  });
  it("来源成功水位边界，空/未来/缺失不能被组装续命", () => {
    expect(feedSourcesFresh([now - FEED_MAX_STALE * 1000], now)).toBe(true);
    for (const marks of [[], [null], [now + 1], [now - FEED_MAX_STALE * 1000 - 1]])
      expect(feedSourcesFresh(marks, now)).toBe(false);
  });
  it("10→0 不是小日历；无证据变化仍拦截，用户改筛选豁免", () => {
    const previous = Array.from({ length: 10 }, (_, i) => node(String(i)));
    const input = {
      baseline: { count: 10, view_revision: 0, generation: 1, served_at: now },
      view_revision: 0,
      config,
      current: [],
      previous,
      now,
    };
    expect(feedShrinkBlocked(input)).toBe(true);
    expect(feedShrinkBlocked({ ...input, previous: null })).toBe(true);
    expect(feedShrinkBlocked({ ...input, view_revision: 1 })).toBe(false);
    expect(
      feedShrinkBlocked({
        ...input,
        baseline: { ...input.baseline, count: FEED_SHRINK_GUARD_MIN - 1 },
      }),
    ).toBe(false);
    expect(feedShrinkBlocked({ ...input, current: previous.slice(0, 6) })).toBe(false);
    expect(feedShrinkBlocked({ ...input, current: previous.slice(0, 5) })).toBe(true);
  });
  it("逐缺席项窗口/分类纠正证据；部分解释不放过其他缺失", () => {
    const previous = Array.from({ length: 10 }, (_, i) => node(String(i)));
    const input = {
      baseline: { count: 10, view_revision: 0, generation: 1, served_at: now },
      view_revision: 0,
      config,
      current: previous,
      previous,
      now: now + (FEED_PAST_DAYS + 1) * day,
    };
    expect(feedShrinkBlocked(input)).toBe(false);
    const current = previous.map((old) =>
      changed(old, {
        ...old,
        projection: { ...old.projection, event: { ...old.projection.event, event_type: "gacha" } },
      }),
    );
    expect(feedShrinkBlocked({ ...input, current, now })).toBe(false);
    expect(feedShrinkBlocked({ ...input, current: current.slice(0, 9), now })).toBe(true);
  });
  it("自然退出上界取 UTC 窗口与更正保留期较晚者，覆盖 DATE、越界补偿与空集合", () => {
    const base = node();
    const expected = feedWindow(now).start + (2 * FEED_PAST_DAYS + 1) * day;
    expect(feedNaturalExitAt(personalCalendarNodes(config, [base], now), now)).toBe(expected);
    const date = node();
    date.projection.milestone.time = TimeValueSchema.parse({
      precision: "date",
      date: "2026-09-30",
      source_timezone: "UTC+8",
      raw_expression: "当日",
      time_basis: "official_explicit",
    });
    expect(feedNaturalExitAt(personalCalendarNodes(config, [date], now), now)).toBe(expected);
    const deleted = {
      ...base,
      tombstone: true,
      patch: decideCalendarPatch(base.projection, null, null, now),
    };
    expect(deleted.patch?.retain_until).toBeGreaterThan(expected);
    expect(feedNaturalExitAt(personalCalendarNodes(config, [deleted], now), now)).toBe(
      deleted.patch?.retain_until,
    );
    const moved = changed(base, node("node", now + (FEED_FUTURE_DAYS + 20) * day));
    const exit = feedNaturalExitAt(personalCalendarNodes(config, [moved], now), now);
    expect(exit).toBe(expected + (FEED_FUTURE_DAYS + 20) * day);
    expect(personalCalendarNodes(config, [moved], exit - 1)).toHaveLength(1);
    expect(personalCalendarNodes(config, [moved], exit)).toHaveLength(0);
    expect(feedNaturalExitAt([], now)).toBe(now);
  });
  it("重算差额按最坏未解释计，恰好比例可过，超过只在自然退出上界兜底", () => {
    const values = Array.from({ length: 10 }, (_, i) => ({
      ...node(String(i)),
      public_changed_at: now,
    }));
    const exit = feedNaturalExitAt(personalCalendarNodes(config, values, now), now);
    const input = {
      baseline: {
        count: 10,
        view_revision: 0,
        generation: 1,
        served_at: now,
        natural_exit_at: exit,
      },
      view_revision: 0,
      config,
      previous: null,
      now: exit,
      current: values.slice(10 * FEED_SHRINK_GUARD_RATIO),
    };
    // 6 个可重算项全部有自然退出证据，4 个差额恰好达到比例；无需标量也通过。
    expect(
      feedShrinkBlocked({ ...input, baseline: { ...input.baseline, natural_exit_at: null } }),
    ).toBe(false);
    const missingFive = { ...input, current: values.slice(5) };
    expect(
      feedShrinkBlocked({ ...missingFive, baseline: { ...input.baseline, natural_exit_at: null } }),
    ).toBe(true);
    expect(
      feedShrinkBlocked({
        ...missingFive,
        baseline: { ...input.baseline, natural_exit_at: exit + 1 },
      }),
    ).toBe(true);
    expect(feedShrinkBlocked(missingFive)).toBe(false);
    expect(feedShrinkBlocked({ ...missingFive, now: exit + day })).toBe(false);
  });
  it("标量不能覆盖重算超额或已知缺席项的反证；新公共修订不冒充旧证据", () => {
    const previous = Array.from({ length: 10 }, (_, i) => node(String(i)));
    const input = {
      baseline: {
        count: 10,
        view_revision: 0,
        generation: 1,
        served_at: now,
        natural_exit_at: now,
      },
      view_revision: 0,
      config,
      previous,
      current: [],
      now,
    };
    expect(feedShrinkBlocked(input)).toBe(true);
    expect(
      feedShrinkBlocked({
        ...input,
        previous: [...previous, node("extra")],
        now: now + (FEED_PAST_DAYS + 1) * day,
      }),
    ).toBe(true);
    const after = now + (FEED_PAST_DAYS + 1) * day;
    const changed = previous.map((n) => ({ ...n, public_changed_at: after }));
    expect(
      feedShrinkBlocked({
        ...input,
        previous: null,
        current: changed,
        now: after,
        baseline: { ...input.baseline, natural_exit_at: null },
      }),
    ).toBe(true);
  });
});
