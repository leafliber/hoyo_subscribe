// ADR-0031：个人日历（ICS）里每个条目给人看的文字——标题、描述与链接。真实 Feed 与私人预览共用这一份，
// 字节一致；Worker 只做 RFC 5545 转义与折行。
//
// 以前描述只有事件简介（规则与 AI 草稿路径恒为空）加更正理由，链接是官方取材接口地址（getAnnContent，
// 一段几百 KB 的 JSON），日历里看到的就是一条读不懂的接口链接；开始与结束两条的标题也一模一样。
// 现在：标题写明节点动作；描述写游戏、类型、北京时间、官方原文写法与推导依据、状态或更正、简介；
// 链接指向本站活动详情页（那里有本站保存的官方公告原文）。
import type { EventType, NodeType } from "./enums";
import type { PersonalCalendarNode } from "./personal-calendar";
import { EVENT_NAMES, GAME_NAMES, nodeAction } from "./schedule-browse";
import type { TimeValue } from "./time";
import { versionDerivationBasis } from "./version-time";
import { yearCompletionBasis } from "./year-completion";

// 单位换算，非业务参数。
const UTC8 = 8 * 3_600_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function beijing(ms: number) {
  const date = new Date(ms + UTC8);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: WEEKDAYS[date.getUTCDay()],
    clock: date.toISOString().slice(11, 16),
  };
}

/** "2026年10月13日 周二 17:59（北京时间）" / "2026年9月23日 周三（具体时间未公布）"；未知为"时间待公布"。 */
export function calendarTimeText(time: TimeValue): string {
  const prefix = time.time_basis === "official_estimate" ? "预计 " : "";
  if (time.precision === "datetime") {
    const t = beijing(time.utc_ms);
    return `${prefix}${t.year}年${t.month}月${t.day}日 ${t.weekday} ${t.clock}（北京时间）`;
  }
  if (time.precision === "date") {
    const t = beijing(Date.parse(`${time.date}T00:00:00+08:00`));
    return `${prefix}${t.year}年${t.month}月${t.day}日 ${t.weekday}（具体时间未公布）`;
  }
  return "时间待公布";
}

/** 本站活动详情页（日历条目的链接）。 */
export function eventDetailUrl(siteOrigin: string, eventId: string): string {
  return new URL(`/events/${encodeURIComponent(eventId)}`, siteOrigin).toString();
}

export interface CalendarEntryTitleInput {
  readonly eventTitle: string;
  readonly milestoneTitle: string;
  readonly eventType: EventType;
  readonly nodeType: NodeType;
}

/**
 * 标题里的节点说明：通常是节点动作（卡池开启、活动结束、兑换码发放……）；阶段解锁用节点自己的标题
 * （同一活动可能有好几个阶段），去掉与活动名重复的前缀。
 */
export function calendarEntryLabel(input: CalendarEntryTitleInput): string {
  const action = nodeAction({ nodeType: input.nodeType, eventType: input.eventType });
  if (input.nodeType !== "phase_unlock") return action;
  const title = input.milestoneTitle.trim();
  const own = title.startsWith(input.eventTitle)
    ? title.slice(input.eventTitle.length).trim()
    : title;
  return own === "" ? action : own;
}

/** 日历条目标题"活动名 · 节点说明"；Feed、私人预览与启用前的确认列表共用，看到的就是日历里的标题。 */
export function calendarEntryTitle(input: CalendarEntryTitleInput): string {
  return `${input.eventTitle} · ${calendarEntryLabel(input)}`;
}

function statusLine(item: PersonalCalendarNode): string | null {
  const status = item.node.projection.event.status;
  if (status === "cancelled") return "状态：官方已取消";
  if (status === "retracted") return "状态：本站撤回，此前收录有误";
  if (status === "postponed") return "状态：已延期";
  return null;
}

export interface CalendarEntryText {
  readonly summary: string;
  readonly description: string;
  readonly url: string;
}

/** 一个日历条目给人看的文字；item 来自 personalCalendarNodes（time 已是更正后的显示时间）。 */
export function calendarEntryText(
  item: PersonalCalendarNode,
  siteOrigin: string,
): CalendarEntryText {
  const { event, milestone, event_id: eventId } = item.node.projection;
  const title = {
    eventTitle: event.title,
    milestoneTitle: milestone.title,
    eventType: event.event_type,
    nodeType: milestone.node_type,
  };
  const label = calendarEntryLabel(title);
  const time = item.time;
  const basis =
    time.time_basis === "deterministic_derived"
      ? (versionDerivationBasis(time.raw_expression) ??
        yearCompletionBasis(time.raw_expression, time))
      : null;
  const patch = item.patch ? item.node.patch : null;
  const lines = [
    `${GAME_NAMES[item.node.game]} · ${EVENT_NAMES[event.event_type]} · ${label}`,
    `时间：${calendarTimeText(time)}`,
    `官方原文：${time.raw_expression}`,
    basis === null ? null : `推导依据：${basis}`,
    patch === null
      ? statusLine(item)
      : `更正：${patch.fact_reason}${patch.old_time !== null && patch.old_time.precision !== "unknown" ? `（原时间 ${calendarTimeText(patch.old_time)}）` : ""}`,
    event.summary === null || event.summary.trim() === "" ? null : `说明：${event.summary}`,
    `详情与官方公告原文：${eventDetailUrl(siteOrigin, eventId)}`,
    "时间与安排以官方公告为准。",
  ];
  return {
    summary: calendarEntryTitle(title),
    description: lines.filter((line): line is string => line !== null).join("\n"),
    url: eventDetailUrl(siteOrigin, eventId),
  };
}
