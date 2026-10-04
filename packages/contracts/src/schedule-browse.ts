/** F1-02 / D1′：公开浏览 UI 合同，独立于附录 A 业务注册表和订阅配置。 */

import type { EventStatus, EventType, GameId, NodeType } from "./enums";
import { EVENT_TYPES, NODE_TYPES, SUPPORTED_SCOPE_GAMES } from "./enums";
import type { PublicSourceStatus, PublicStatusResponse } from "./public-api";
import type { TimeValue } from "./time";

export const BROWSE_RANGES = [
  { id: "today", label: "今天", days: 1 },
  { id: "3d", label: "近3天", days: 3 },
  { id: "7d", label: "近7天", days: 7 },
  { id: "30d", label: "近30天", days: 30 },
  { id: "90d", label: "未来90天", days: 90 },
  { id: "all", label: "全部", days: null },
] as const;
export type BrowseRange = (typeof BROWSE_RANGES)[number]["id"];
export const BROWSE_DEFAULT_RANGE: BrowseRange = "3d";
export const BROWSE_TIMEZONE = "北京时间 UTC+8";
// 单位换算，非预算、配额或 Feed 参数。
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UTC8 = 8 * HOUR;
export function browseDate(ms: number): string {
  return new Date(ms + UTC8).toISOString().slice(0, 10);
}
export function browseTimestamp(ms: number): string {
  return new Date(ms + UTC8).toISOString().slice(0, 16).replace("T", " ");
}
export function browseWindow(range: BrowseRange, now: number) {
  const today = Math.floor((now + UTC8) / DAY) * DAY - UTC8;
  const preset = BROWSE_RANGES.find((item) => item.id === range);
  if (!preset) throw new Error("Unknown browse range");
  return {
    start: today,
    end: preset.days === null ? null : today + preset.days * DAY,
    yesterday: today - DAY,
  };
}
export const GAME_NAMES: Record<GameId, string> = {
  genshin: "原神",
  hsr: "崩坏：星穹铁道",
  zzz: "绝区零",
};
export const EVENT_NAMES: Record<EventType, string> = {
  livestream: "前瞻直播",
  maintenance: "维护更新",
  limited_event: "限时活动",
  gacha: "卡池",
};
export const NODE_NAMES: Record<NodeType, string> = {
  start: "开始",
  end: "结束",
  phase_unlock: "阶段解锁",
  reward_deadline: "奖励领取截止",
  expected_end: "预计结束",
  actual_end: "实际结束",
};
export interface BrowseFilters {
  games: GameId[];
  range: BrowseRange;
  ending: boolean;
  events: EventType[];
  nodes: NodeType[];
}
export function defaultBrowseFilters(): BrowseFilters {
  return {
    games: [...SUPPORTED_SCOPE_GAMES],
    range: BROWSE_DEFAULT_RANGE,
    ending: false,
    events: [],
    nodes: [],
  };
}
/** 白名单解析/序列化，只处理公开浏览条件。不得带入任意 URL 参数。 */
export function parseBrowseFilters(params: URLSearchParams): BrowseFilters {
  const selected = <T extends string>(key: string, allowed: readonly T[]) =>
    allowed.filter((value) => (params.get(key) ?? "").split(",").includes(value));
  return {
    games: params.has("games")
      ? selected("games", SUPPORTED_SCOPE_GAMES)
      : [...SUPPORTED_SCOPE_GAMES],
    range:
      BROWSE_RANGES.find((item) => item.id === params.get("range"))?.id ?? BROWSE_DEFAULT_RANGE,
    ending: params.get("ending") === "1",
    events: selected("events", EVENT_TYPES),
    nodes: selected("nodes", NODE_TYPES),
  };
}
export function browseSearch(filters: BrowseFilters): string {
  const params = new URLSearchParams();
  if (filters.games.length !== SUPPORTED_SCOPE_GAMES.length)
    params.set("games", filters.games.join(","));
  if (filters.range !== BROWSE_DEFAULT_RANGE) params.set("range", filters.range);
  if (filters.ending) params.set("ending", "1");
  if (filters.events.length) params.set("events", filters.events.join(","));
  if (filters.nodes.length) params.set("nodes", filters.nodes.join(","));
  return params.toString();
}
export interface ScheduleNode {
  id: string;
  title: string;
  game: GameId;
  eventType: EventType;
  nodeType: NodeType;
  status: EventStatus;
  time: TimeValue;
  /** 原型只接收已发布公开节点，未审核候选不在输入结构内。 */
  evidence: string;
  noticePublishedAt: number;
  change?: { kind: "rescheduled" | "cancelled" | "retracted" | "pending"; explanation: string };
}
export interface ScheduleSnapshot {
  synthetic: true;
  capturedAt: number;
  publishedAt: number;
  generation: string;
  nodes: ScheduleNode[];
  sources: { game: GameId; verifiedAt: number; unavailable: boolean; reviewCount: number }[];
}
export function nodeAction(node: Pick<ScheduleNode, "nodeType" | "eventType">): string {
  if (node.nodeType === "start")
    return {
      livestream: "前瞻开始",
      maintenance: "维护开始",
      limited_event: "活动开始",
      gacha: "卡池开启",
    }[node.eventType];
  if (node.nodeType === "end")
    return {
      livestream: "前瞻结束",
      maintenance: "维护结束",
      // ADR-0015：界面统一叫"活动"；与"奖励领取截止"仍是两个节点。
      limited_event: "活动结束",
      gacha: "卡池结束",
    }[node.eventType];
  return NODE_NAMES[node.nodeType];
}
/** 截止紧迫度的分档（小时；ADR-0015，所有者 2026-10-05：24 小时内即为高危）。 */
export const DEADLINE_URGENCY_HOURS = { critical: 24, soon: 72 } as const;
export type DeadlineUrgency = "critical" | "soon" | "later";
/** 距截止不足 critical 小时为高危，不足 soon 小时为临近，其余一般；已过时间按高危处理（调用方通常已移出）。 */
export function deadlineUrgency(target: number, now: number): DeadlineUrgency {
  const left = target - now;
  return left < DEADLINE_URGENCY_HOURS.critical * HOUR
    ? "critical"
    : left < DEADLINE_URGENCY_HOURS.soon * HOUR
      ? "soon"
      : "later";
}
export function nodeStatus(
  node: Pick<ScheduleNode, "status" | "time" | "nodeType">,
  now: number,
): string[] {
  if (node.status === "cancelled") return ["官方已取消"];
  if (node.status === "retracted") return ["本站撤回：此前收录有误"];
  if (node.status === "postponed" && node.time.precision === "unknown")
    return ["已延期，新时间待公布"];
  const result: string[] = [];
  if (node.time.time_basis === "official_estimate") result.push("官方预计");
  if (node.time.time_basis === "deterministic_derived") result.push("确定性推导");
  if (node.time.time_basis === "unresolved") result.push("时间待核实");
  if (
    node.time.precision === "datetime" &&
    node.nodeType === "start" &&
    node.time.utc_ms <= now &&
    (node.time.time_basis === "official_explicit" ||
      node.time.time_basis === "deterministic_derived")
  )
    result.push("已到计划开始时间");
  return result;
}
export function nodeTime(node: Pick<ScheduleNode, "status" | "time">): string {
  if (node.status === "cancelled" || node.status === "retracted") return "原安排已失效";
  const prefix = node.time.time_basis === "official_estimate" ? "预计 " : "";
  if (node.time.precision === "datetime") return prefix + browseTimestamp(node.time.utc_ms);
  if (node.time.precision === "date") return `${prefix}${node.time.date} · 具体时间未公布`;
  return "时间待公布";
}
export function isDeadline(node: Pick<ScheduleNode, "nodeType" | "eventType">): boolean {
  return (
    node.nodeType === "reward_deadline" ||
    (node.nodeType === "end" && (node.eventType === "limited_event" || node.eventType === "gacha"))
  );
}
export interface ScheduleDay<N = ScheduleNode> {
  date: string;
  timed: N[];
  dateOnly: N[];
}
function nodeDate(node: Pick<ScheduleNode, "time">): string | null {
  if (node.time.precision === "date") return node.time.date;
  if (node.time.precision === "datetime") return browseDate(node.time.utc_ms);
  return null;
}
function identityOrder(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function groupDays<N extends Pick<ScheduleNode, "id" | "time">>(nodes: N[]): ScheduleDay<N>[] {
  const days = new Map<string, ScheduleDay<N>>();
  for (const node of nodes) {
    const date = nodeDate(node);
    if (!date) continue;
    const day = days.get(date) ?? { date, timed: [], dateOnly: [] };
    if (node.time.precision === "date") day.dateOnly.push(node);
    else day.timed.push(node);
    days.set(date, day);
  }
  for (const day of days.values()) {
    day.timed.sort((a, b) => {
      if (a.time.precision !== "datetime" || b.time.precision !== "datetime")
        throw new Error("日期节点不得参与精确排序");
      return a.time.utc_ms - b.time.utc_ms || identityOrder(a, b);
    });
    day.dateOnly.sort(identityOrder);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/** F1-06：只依赖公开节点的浏览字段；不制造 synthetic 快照。 */
export function selectScheduleCore<
  N extends Pick<ScheduleNode, "id" | "game" | "eventType" | "nodeType" | "status" | "time">,
>(
  input: {
    nodes: readonly N[];
    recentChanges: readonly N[];
    window: { start: number; end: number | null; yesterday: number };
    sources: readonly PublicSourceStatus[] | null;
    reviewGaps: PublicStatusResponse["reviewGaps"];
  },
  filters: BrowseFilters,
) {
  const today = browseDate(input.window.start);
  const yesterday = browseDate(input.window.yesterday);
  const end = input.window.end === null ? null : browseDate(input.window.end);
  const selected = input.nodes.filter((node) => filters.games.includes(node.game));
  const matches = (node: N) =>
    (!filters.events.length || filters.events.includes(node.eventType)) &&
    (!filters.nodes.length || filters.nodes.includes(node.nodeType)) &&
    (!filters.ending || isDeadline(node));
  const live = selected.filter(
    (node) => node.status !== "cancelled" && node.status !== "retracted",
  );
  const inWindow = live.filter((node) => {
    const date = nodeDate(node);
    return (
      date !== null &&
      date !== yesterday &&
      (filters.range === "all" || (date >= today && end !== null && date < end))
    );
  });
  const visible = inWindow.filter(matches);
  const pending = live
    .filter((node) => nodeDate(node) === null && matches(node))
    .sort(identityOrder);
  const sources = input.sources?.filter((source) => filters.games.includes(source.game)) ?? null;
  const unavailable =
    sources?.filter(
      (source) =>
        source.verificationState === "unavailable" ||
        source.degradationReasons.includes("maintenance_required"),
    ) ?? [];
  const gaps = input.reviewGaps.filter((gap) => filters.games.includes(gap.game));
  const reviewUnknown = gaps.some((gap) => gap.count === null);
  const review = reviewUnknown ? null : gaps.reduce((total, gap) => total + (gap.count ?? 0), 0);
  const sourcesUnknown =
    sources === null ||
    sources.some(
      (source) =>
        source.verificationState === "unknown" &&
        !source.degradationReasons.includes("maintenance_required"),
    );
  const empty: "range" | "filtered" | "source" | "review" | "unknown" | null = visible.length
    ? null
    : unavailable.length
      ? "source"
      : reviewUnknown || review
        ? "review"
        : sourcesUnknown
          ? "unknown"
          : inWindow.length ||
              !filters.games.length ||
              filters.events.length ||
              filters.nodes.length ||
              filters.ending
            ? "filtered"
            : "range";
  return {
    days: groupDays(visible),
    yesterday: {
      date: yesterday,
      groups: groupDays(live.filter((node) => nodeDate(node) === yesterday && matches(node))),
    },
    pending,
    changes: input.recentChanges.filter((node) => filters.games.includes(node.game)),
    sources,
    unavailable,
    sourcesUnknown,
    review,
    reviewUnknown,
    empty,
    count: visible.length,
  };
}

/** 样例兼容封装；公开页面直接使用接口 window 和 selectScheduleCore。 */
export function selectSchedule(snapshot: ScheduleSnapshot, filters: BrowseFilters, now: number) {
  const sources = snapshot.sources.filter((source) => filters.games.includes(source.game));
  const view = selectScheduleCore(
    {
      nodes: snapshot.nodes,
      recentChanges: snapshot.nodes.filter((node) => node.change).sort(identityOrder),
      window: browseWindow(filters.range, now),
      sources: snapshot.sources.map((source) => ({
        sourceId: source.game,
        game: source.game,
        verifiedAt: source.verifiedAt,
        verificationState: source.unavailable ? "unavailable" : "verified",
        degradationReasons: [],
      })),
      reviewGaps: snapshot.sources.map((source) => ({
        game: source.game,
        count: source.reviewCount,
      })),
    },
    filters,
  );
  return {
    ...view,
    sources,
    verifiedAt: sources.length ? Math.min(...sources.map((source) => source.verifiedAt)) : null,
    unavailable: sources.filter((source) => source.unavailable),
  };
}
