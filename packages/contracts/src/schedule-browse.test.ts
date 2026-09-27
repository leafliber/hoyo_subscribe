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
