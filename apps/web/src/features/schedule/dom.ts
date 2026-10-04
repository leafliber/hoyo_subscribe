import type { PublicCache, PublicScheduleNode, TimeValue } from "@hoyo/contracts";
import { callout, el, icon } from "../../lib/dom";
import { clock, dateOnlyLabel, monthDay, stamp, weekday } from "../../lib/format";

export { el };

/** 节点时间的完整文字：精确时间带日期与星期；纯日期不伪造时刻；未知不编造日期。 */
export function timeText(time: TimeValue, status: PublicScheduleNode["status"] = "scheduled") {
  if (status === "cancelled" || status === "retracted") return "原安排已失效";
  const prefix = time.time_basis === "official_estimate" ? "预计 " : "";
  if (time.precision === "datetime")
    return `${prefix}${monthDay(time.utc_ms)} ${weekday(time.utc_ms)} ${clock(time.utc_ms)}`;
  if (time.precision === "date") return `${prefix}${dateOnlyLabel(time.date)} · 具体时间未公布`;
  return "时间待公布";
}

export function timeNode(time: TimeValue, status: PublicScheduleNode["status"] = "scheduled") {
  const label = timeText(time, status);
  return time.precision === "datetime" && status !== "cancelled" && status !== "retracted"
    ? el("time", { datetime: new Date(time.utc_ms).toISOString() }, label)
    : el("span", {}, label);
}

/**
 * 离线或副本超过新鲜期（PUBLIC_CACHE_FRESH，ADR-0015 为 1 小时）时，标出信息获取时间并给刷新按钮。
 * 按钮沿用页面已有的 data-action="refresh"，由所在页面重新读取（跳过浏览器缓存）。
 */
export function cacheNotice(cache: PublicCache) {
  const offline = !navigator.onLine;
  const stale = Date.now() > cache.freshUntil;
  if (!offline && !stale) return null;
  return callout(
    "warning",
    [
      el(
        "p",
        { class: "cache-notice-text" },
        `${offline ? "当前离线" : "内容可能已过时"}，信息获取时间 ${stamp(cache.generatedAt)}`,
      ),
      el(
        "button",
        { type: "button", class: "button button--secondary button--sm", "data-action": "refresh" },
        icon("refresh"),
        "刷新",
      ),
    ],
    { className: "data-warning cache-notice", role: "status" },
  );
}
