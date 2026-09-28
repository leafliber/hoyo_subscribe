import { describe, expect, it } from "vitest";
import {
  classifyPublicationChange,
  type PublicEventFacts,
  type PublicMilestoneFacts,
} from "./publishing";
import { DateOnlySchema, ExactTimeSchema } from "./time";

const event: PublicEventFacts = {
  event_type: "limited_event",
  status: "scheduled",
  title: "活动",
  summary: "简介",
  official_url: "https://example.invalid/official",
  human_locked: false,
};
const exact: PublicMilestoneFacts = {
  milestone_key: "start",
  node_type: "start",
  title: "开启",
  time: {
    precision: "datetime",
    utc_ms: ExactTimeSchema.parse(1000),
    source_timezone: "UTC+08:00",
    raw_expression: "官方时刻",
    time_basis: "official_explicit",
  },
  human_locked: false,
};
const date: PublicMilestoneFacts = {
  ...exact,
  time: {
    precision: "date",
    date: DateOnlySchema.parse("2026-10-01"),
    source_timezone: "UTC+08:00",
    raw_expression: "10 月 1 日",
    time_basis: "official_explicit",
  },
};

describe("A-P3-PUBLISH 三类版本判定表", () => {
  it("新事件三类版本各取得初值", () => {
    expect(classifyPublicationChange(null, event, [], [exact])).toEqual({
      event_revision: true,
      schedule_revision: true,
      milestones: { start: { changed: true, schedule_changed: true, public_ical_changed: true } },
    });
  });

  it.each(["title", "summary", "official_url"] as const)(
    "%s 文案变化只增事件和公共 ICS",
    (field) => {
      const result = classifyPublicationChange(
        event,
        { ...event, [field]: "新文案" },
        [exact],
        [exact],
      );
      expect(result.event_revision).toBe(true);
      expect(result.schedule_revision).toBe(false);
      expect(result.milestones.start.public_ical_changed).toBe(true);
    },
  );

  it("改精确时刻增三类版本，保留稳定节点键", () => {
    const moved = {
      ...exact,
      time: { ...exact.time, utc_ms: ExactTimeSchema.parse(2000) },
    } as PublicMilestoneFacts;
    const result = classifyPublicationChange(event, event, [exact], [moved]);
    expect(result.event_revision).toBe(true);
    expect(result.schedule_revision).toBe(true);
    expect(result.milestones.start.public_ical_changed).toBe(true);
  });

  it("纯日期改期仍保持 date 精度，并推进计划与 ICS", () => {
    const moved = {
      ...date,
      time: { ...date.time, date: DateOnlySchema.parse("2026-10-02") },
    } as PublicMilestoneFacts;
    const result = classifyPublicationChange(event, event, [date], [moved]);
    expect(result.schedule_revision).toBe(true);
    expect(result.milestones.start.public_ical_changed).toBe(true);
    expect(moved.time.precision).toBe("date");
  });

  it("节点标题、原文、源时区改变只增事件和 ICS", () => {
    for (const changed of [
      { ...exact, title: "新节点标题" },
      { ...exact, time: { ...exact.time, raw_expression: "新原文" } },
      { ...exact, time: { ...exact.time, source_timezone: "Asia/Shanghai" } },
    ] as PublicMilestoneFacts[]) {
      const result = classifyPublicationChange(event, event, [exact], [changed]);
      expect(result.event_revision).toBe(true);
      expect(result.schedule_revision).toBe(false);
      expect(result.milestones.start.public_ical_changed).toBe(true);
    }
  });

  it("状态取消、事件类型和节点类型改变提醒语义", () => {
    for (const result of [
      classifyPublicationChange(event, { ...event, status: "cancelled" }, [exact], [exact]),
      classifyPublicationChange(event, { ...event, event_type: "gacha" }, [exact], [exact]),
      classifyPublicationChange(event, event, [exact], [{ ...exact, node_type: "end" }]),
    ]) {
      expect(result.schedule_revision).toBe(true);
      expect(result.milestones.start.public_ical_changed).toBe(true);
    }
  });

  it("延期但未更动时刻只改公共表现；新增节点改变计划", () => {
    const postponed = classifyPublicationChange(
      event,
      { ...event, status: "postponed" },
      [exact],
      [exact],
    );
    expect(postponed.event_revision).toBe(true);
    expect(postponed.schedule_revision).toBe(false);
    expect(postponed.milestones.start.public_ical_changed).toBe(true);
    const end = { ...exact, milestone_key: "end", node_type: "end" } as PublicMilestoneFacts;
    const added = classifyPublicationChange(event, event, [exact], [exact, end]);
    expect(added.schedule_revision).toBe(true);
    expect(added.milestones.end.public_ical_changed).toBe(true);
    expect(added.milestones.start.public_ical_changed).toBe(false);
  });

  it("精度改变、节点人工锁分别遵守版本表", () => {
    const precision = classifyPublicationChange(event, event, [exact], [date]);
    expect(precision.schedule_revision).toBe(true);
    expect(precision.milestones.start.public_ical_changed).toBe(true);
    const lock = classifyPublicationChange(
      event,
      event,
      [exact],
      [{ ...exact, human_locked: true }],
    );
    expect(lock.event_revision).toBe(true);
    expect(lock.schedule_revision).toBe(false);
    expect(lock.milestones.start.public_ical_changed).toBe(false);
  });

  it("依据变动仅在 VALARM 资格变化时推进计划", () => {
    const estimated = {
      ...exact,
      time: { ...exact.time, time_basis: "official_estimate" },
    } as PublicMilestoneFacts;
    const result = classifyPublicationChange(event, event, [exact], [estimated]);
    expect(result.schedule_revision).toBe(true);
    expect(result.milestones.start.public_ical_changed).toBe(true);
  });

  it("人锁只增事件修订；无变化不取号", () => {
    const locked = classifyPublicationChange(
      event,
      { ...event, human_locked: true },
      [exact],
      [exact],
    );
    expect(locked.event_revision).toBe(true);
    expect(locked.schedule_revision).toBe(false);
    expect(locked.milestones.start.public_ical_changed).toBe(false);
    const same = classifyPublicationChange(event, event, [exact], [exact]);
    expect(same.event_revision).toBe(false);
    expect(same.schedule_revision).toBe(false);
    expect(same.milestones.start.public_ical_changed).toBe(false);
  });
});
