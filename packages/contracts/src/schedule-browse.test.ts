import { describe, expect, it } from "vitest";
import type { ScheduleNode, ScheduleSnapshot } from "./schedule-browse";
import {
  BROWSE_RANGES,
  browseDate,
  browseSearch,
  browseWindow,
  defaultBrowseFilters,
  nodeStatus,
  parseBrowseFilters,
  selectSchedule,
} from "./schedule-browse";
import { DateOnlySchema, ExactTimeSchema } from "./time";

const now = Date.parse("2026-09-22T15:00:00+08:00");
const start = Date.parse("2026-09-22T00:00:00+08:00");
function exact(id: string, ms: number): ScheduleNode {
  return {
    id,
    title: id,
    game: "genshin",
    eventType: "limited_event",
    nodeType: "start",
    status: "scheduled",
    evidence: "synthetic",
    noticePublishedAt: start,
    time: {
      precision: "datetime",
      utc_ms: ExactTimeSchema.parse(ms),
      source_timezone: "UTC+8",
      raw_expression: "synthetic",
      time_basis: "official_explicit",
    },
  };
}
function snapshot(nodes: ScheduleNode[]): ScheduleSnapshot {
  return {
    synthetic: true,
    capturedAt: start,
    publishedAt: start,
    generation: "synthetic",
    nodes,
    sources: [{ game: "genshin", verifiedAt: start, unavailable: false, reviewCount: 0 }],
  };
}
describe("U03 D1′ UTC+8 自然日窗口", () => {
  for (const range of BROWSE_RANGES)
    it(`${range.label}：含今日零点、排除上界，昨天仅在底部`, () => {
      const window = browseWindow(range.id, now);
      expect(window.start).toBe(start);
      expect(browseWindow(range.id, start).start).toBe(start);
      expect(browseWindow(range.id, start + 86_399_999).start).toBe(start);
      expect(window.end).toBe(range.days === null ? null : start + range.days * 86_400_000);
      const end = window.end ?? start + 200 * 86_400_000;
      const view = selectSchedule(
        snapshot([
          exact("yesterday", start - 1),
          exact("start", start),
          exact("last", end - 1),
          exact("end", end),
          exact("past", start - 3 * 86_400_000),
        ]),
        { ...defaultBrowseFilters(), range: range.id },
        now,
      );
      const ids = view.days.flatMap((day) => day.timed.map((node) => node.id));
      expect(ids).toContain("start");
      expect(ids).toContain("last");
      expect(ids.includes("end")).toBe(range.id === "all");
      expect(ids.includes("past")).toBe(range.id === "all");
      expect(ids).not.toContain("yesterday");
      expect(view.yesterday.groups[0].timed[0].id).toBe("yesterday");
    });
  it("跨年与北京时间午夜切换", () => {
    expect(browseDate(Date.parse("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
    expect(browseDate(Date.parse("2026-12-31T15:59:59Z"))).toBe("2026-12-31");
  });
});
it("U03 纯日期不能补 00:00 参加精确排序；未知节点没有排序日期；同时间按身份", () => {
  const date: ScheduleNode = {
    ...exact("date", start),
    time: {
      precision: "date",
      date: DateOnlySchema.parse("2026-09-22"),
      source_timezone: "UTC+8",
      raw_expression: "9月22日",
      time_basis: "official_explicit",
    },
  };
  const unknown: ScheduleNode = {
    ...exact("unknown", start),
    time: {
      precision: "unknown",
      source_timezone: "UTC+8",
      raw_expression: "待公布",
      time_basis: "unresolved",
    },
  };
  const view = selectSchedule(
    snapshot([exact("b", now), date, unknown, exact("a", now)]),
    defaultBrowseFilters(),
    now,
  );
  expect(view.days[0].timed.map((node) => node.id)).toEqual(["a", "b"]);
  expect(view.days[0].dateOnly).toEqual([date]);
  expect(view.pending).toEqual([unknown]);
  expect(date.time).not.toHaveProperty("utc_ms");
});
it("U05 来源故障和审核缺口优先于假空态", () => {
  const data = snapshot([]);
  data.sources[0].unavailable = true;
  expect(selectSchedule(data, defaultBrowseFilters(), now).empty).toBe("source");
  data.sources[0].unavailable = false;
  data.sources[0].reviewCount = 2;
  expect(selectSchedule(data, defaultBrowseFilters(), now).empty).toBe("review");
  data.sources[0].reviewCount = 0;
  expect(selectSchedule(data, defaultBrowseFilters(), now).empty).toBe("range");
  expect(
    selectSchedule(snapshot([exact("a", now)]), { ...defaultBrowseFilters(), nodes: ["end"] }, now)
      .empty,
  ).toBe("filtered");
});
it("U06 URL 仅保留公开筛选白名单，不传账号草稿和能力地址", () => {
  const filters = parseBrowseFilters(
    new URLSearchParams("range=90d&games=hsr&account=synthetic&draft=synthetic&feed=synthetic"),
  );
  expect(browseSearch(filters)).toBe("games=hsr&range=90d");
  expect(parseBrowseFilters(new URLSearchParams("range=invalid&games=invalid")).games).toEqual([]);
});
it("U03 取消、撤回、预计和已到计划时间分别表达", () => {
  const node = exact("a", now);
  expect(nodeStatus(node, now)).toEqual(["已到计划开始时间"]);
  expect(nodeStatus({ ...node, status: "cancelled" }, now)).toEqual(["官方已取消"]);
  expect(nodeStatus({ ...node, status: "retracted" }, now)).toEqual(["本站撤回：此前收录有误"]);
  expect(
    nodeStatus({ ...node, time: { ...node.time, time_basis: "official_estimate" } }, now),
  ).toEqual(["官方预计"]);
});

it("U03 纯日期窗口逐档按原日期过滤，未知日期始终独立", () => {
  for (const range of BROWSE_RANGES) {
    const end = browseWindow(range.id, now).end ?? start + 200 * 86_400_000;
    const dated = (id: string, date: string): ScheduleNode => ({
      ...exact(id, start),
      time: {
        precision: "date",
        date: DateOnlySchema.parse(date),
        source_timezone: "UTC+8",
        raw_expression: date,
        time_basis: "official_explicit",
      },
    });
    const view = selectSchedule(
      snapshot([dated("start", "2026-09-22"), dated("outside", browseDate(end))]),
      { ...defaultBrowseFilters(), range: range.id },
      now,
    );
    expect(view.days.flatMap((day) => day.timed)).toEqual([]);
    expect(view.days.flatMap((day) => day.dateOnly.map((node) => node.id))).toEqual(
      range.id === "all" ? ["start", "outside"] : ["start"],
    );
  }
});
it("U05 部分来源故障保留已发布节点，只标记受影响游戏", () => {
  const data = snapshot([exact("visible", now)]);
  data.sources.push({ game: "hsr", unavailable: true, verifiedAt: start, reviewCount: 0 });
  const view = selectSchedule(data, defaultBrowseFilters(), now);
  expect(view.verifiedAt).toBe(start);
  expect(view.empty).toBeNull();
  expect(view.count).toBe(1);
  expect(view.unavailable.map((source) => source.game)).toEqual(["hsr"]);
  expect(
    selectSchedule(data, { ...defaultBrowseFilters(), games: ["genshin"] }, now).unavailable,
  ).toEqual([]);
});

it("U03 U05 公共节点共用分组规则，窗口来自响应；昨天不计入当前空态", async () => {
  const { selectScheduleCore, nodeAction, nodeTime, isDeadline } = await import(
    "./schedule-browse"
  );
  const make = (id: string, ms: number): import("./public-api").PublicScheduleNode => ({
    ...exact(id, ms),
    eventId: "evt_synthetic",
    noticePublishedAt: null,
    change: null,
  });
  const input = {
    nodes: [make("b", now), make("a", now), make("yesterday", start - 1)],
    recentChanges: [],
    window: browseWindow("3d", now),
    sources: [],
    reviewGaps: [],
  };
  const view = selectScheduleCore(input, defaultBrowseFilters());
  expect(view.days[0].timed.map((node) => node.id)).toEqual(["a", "b"]);
  expect(view.yesterday.groups[0].timed[0].id).toBe("yesterday");
  expect(view.count).toBe(2);
  expect(nodeAction(input.nodes[0])).toBe(nodeAction(exact("b", now)));
  expect(nodeTime(input.nodes[0])).toBe(nodeTime(exact("b", now)));
  expect(isDeadline(input.nodes[0])).toBe(isDeadline(exact("b", now)));
  expect(
    selectScheduleCore({ ...input, nodes: [make("yesterday", start - 1)] }, defaultBrowseFilters())
      .empty,
  ).toBe("range");
  expect(
    selectScheduleCore(
      { ...input, nodes: [], reviewGaps: [{ game: "genshin", count: null }] },
      defaultBrowseFilters(),
    ).review,
  ).toBeNull();
  expect(
    selectScheduleCore(
      { ...input, nodes: [], reviewGaps: [{ game: "genshin", count: null }] },
      defaultBrowseFilters(),
    ).empty,
  ).toBe("review");
  expect(
    selectScheduleCore({ ...input, nodes: [], sources: null }, defaultBrowseFilters()).empty,
  ).toBe("unknown");
});

it("U03 公共节点六档沿用精度、稳定排序、动作与状态规则", async () => {
  const { selectScheduleCore, nodeAction, nodeTime, isDeadline } = await import(
    "./schedule-browse"
  );
  const convert = (node: ScheduleNode): import("./public-api").PublicScheduleNode => ({
    ...node,
    eventId: "evt_synthetic",
    noticePublishedAt: null,
    change: null,
  });
  for (const range of BROWSE_RANGES) {
    const date: ScheduleNode = {
      ...exact("date", start),
      time: {
        precision: "date",
        date: DateOnlySchema.parse("2026-09-22"),
        source_timezone: "UTC+8",
        raw_expression: "9月22日",
        time_basis: "official_explicit",
      },
    };
    const unknown: ScheduleNode = {
      ...exact("unknown", start),
      time: {
        precision: "unknown",
        source_timezone: "UTC+8",
        raw_expression: "待公布",
        time_basis: "unresolved",
      },
    };
    const legacy = [exact("b", now), date, unknown, exact("a", now), exact("yesterday", start - 1)];
    const filters = { ...defaultBrowseFilters(), range: range.id };
    const sample = selectSchedule(snapshot(legacy), filters, now);
    const actual = selectScheduleCore(
      {
        nodes: legacy.map(convert),
        recentChanges: [],
        window: browseWindow(range.id, now),
        sources: [],
        reviewGaps: [],
      },
      filters,
    );
    expect(
      actual.days.map((d) => ({
        date: d.date,
        timed: d.timed.map((n) => n.id),
        dateOnly: d.dateOnly.map((n) => n.id),
      })),
    ).toEqual(
      sample.days.map((d) => ({
        date: d.date,
        timed: d.timed.map((n) => n.id),
        dateOnly: d.dateOnly.map((n) => n.id),
      })),
    );
    expect(actual.pending.map((n) => n.id)).toEqual(sample.pending.map((n) => n.id));
    expect(actual.count).toBe(sample.count);
    for (const node of legacy) {
      expect(nodeAction(convert(node))).toBe(nodeAction(node));
      expect(nodeTime(convert(node))).toBe(nodeTime(node));
      expect(nodeStatus(convert(node), now)).toEqual(nodeStatus(node, now));
      expect(isDeadline(convert(node))).toBe(isDeadline(node));
    }
  }
});

describe("A-F1-POLISH 统一叫活动；截止 24 小时内为高危（ADR-0015）", () => {
  it("限时活动的结束节点叫活动结束，仍与奖励领取截止分开", async () => {
    const { nodeAction } = await import("./schedule-browse");
    expect(nodeAction({ nodeType: "end", eventType: "limited_event" })).toBe("活动结束");
    expect(nodeAction({ nodeType: "start", eventType: "limited_event" })).toBe("活动开始");
    expect(nodeAction({ nodeType: "reward_deadline", eventType: "limited_event" })).toBe(
      "奖励领取截止",
    );
    for (const eventType of ["livestream", "maintenance", "limited_event", "gacha"] as const)
      for (const nodeType of ["start", "end", "reward_deadline", "phase_unlock"] as const)
        expect(nodeAction({ nodeType, eventType })).not.toContain("玩法");
  });

  it("不足 24 小时为高危，不足 72 小时为临近，边界按严格小于", async () => {
    const { deadlineUrgency, DEADLINE_URGENCY_HOURS } = await import("./schedule-browse");
    const hour = 3_600_000;
    expect(DEADLINE_URGENCY_HOURS).toEqual({ critical: 24, soon: 72 });
    expect(deadlineUrgency(now + 30 * 60_000, now)).toBe("critical");
    expect(deadlineUrgency(now + 5.5 * hour, now)).toBe("critical");
    expect(deadlineUrgency(now + 24 * hour - 1, now)).toBe("critical");
    expect(deadlineUrgency(now + 24 * hour, now)).toBe("soon");
    expect(deadlineUrgency(now + 72 * hour - 1, now)).toBe("soon");
    expect(deadlineUrgency(now + 72 * hour, now)).toBe("later");
  });
});

describe("A-F1-BROWSE 从上到下按时间先后、从开始到结束（ADR-0017）", () => {
  const day = 86_400_000;
  function node(
    id: string,
    nodeType: ScheduleNode["nodeType"],
    time: "unknown" | number | string,
  ): ScheduleNode {
    return {
      ...exact(id, start),
      nodeType,
      time:
        time === "unknown"
          ? {
              precision: "unknown",
              source_timezone: "UTC+8",
              raw_expression: "待公布",
              time_basis: "unresolved",
            }
          : typeof time === "string"
            ? {
                precision: "date",
                date: DateOnlySchema.parse(time),
                source_timezone: "UTC+8",
                raw_expression: time,
                time_basis: "official_explicit",
              }
            : exact(id, time).time,
    };
  }
  const toPublic = (item: ScheduleNode): import("./public-api").PublicScheduleNode => ({
    ...item,
    eventId: item.id,
    noticePublishedAt: null,
    change: null,
  });

  it("时间未知的开始排最前、结束类排最后；有日期的按日期与时刻，同一天全天在精确时刻之后", async () => {
    const { compareScheduleNodes } = await import("./schedule-browse");
    const nodes = [
      node("reward", "reward_deadline", "unknown"),
      node("late", "end", now + day),
      node("allday", "end", "2026-09-22"),
      node("phase", "phase_unlock", "unknown"),
      node("begin", "start", "unknown"),
      node("noon", "start", now),
      node("finish", "end", "unknown"),
    ];
    expect([...nodes].sort(compareScheduleNodes).map((item) => item.id)).toEqual([
      "begin",
      "noon",
      "allday",
      "late",
      "phase",
      "finish",
      "reward",
    ]);
  });

  it("同一时刻按开始 → 阶段 → 结束，再按稳定身份；开始时间未知也排在已知的结束之前", async () => {
    const { compareScheduleNodes } = await import("./schedule-browse");
    const same = [
      node("z-end", "end", now),
      node("b-start", "start", now),
      node("a-start", "start", now),
      node("phase", "phase_unlock", now),
    ];
    expect([...same].sort(compareScheduleNodes).map((item) => item.id)).toEqual([
      "a-start",
      "b-start",
      "phase",
      "z-end",
    ]);
    // 详情时间线：开始写着"7.0版本更新后"（未定），结束有明确时刻——开始仍在前。
    const event = [node("finish", "end", now + day), node("open", "start", "unknown")];
    expect([...event].sort(compareScheduleNodes).map((item) => item.id)).toEqual([
      "open",
      "finish",
    ]);
  });

  it("首页的时间待定与近期重要变更同样从开始到结束、从早到晚", async () => {
    const { selectScheduleCore } = await import("./schedule-browse");
    const view = selectScheduleCore(
      {
        nodes: [node("p-end", "end", "unknown"), node("p-start", "start", "unknown")].map(toPublic),
        recentChanges: [node("c-late", "end", now + 2 * day), node("c-soon", "start", now)].map(
          toPublic,
        ),
        window: browseWindow("3d", now),
        sources: [],
        reviewGaps: [],
      },
      defaultBrowseFilters(),
    );
    expect(view.pending.map((item) => item.id)).toEqual(["p-start", "p-end"]);
    expect(view.changes.map((item) => item.id)).toEqual(["c-soon", "c-late"]);
  });
});
