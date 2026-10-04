import type { PublicCache, PublicScheduleNode, TimeValue } from "@hoyo/contracts";
import { callout, el } from "../../lib/dom";
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

/** 离线或副本过期时如实标注实际读取时间。 */
export function cacheNotice(cache: PublicCache, label = "日程") {
  const offline = !navigator.onLine;
  const stale = Date.now() > cache.freshUntil;
  if (!offline && !stale) return null;
  return callout(
    "warning",
    `${label}${offline ? " · 离线" : ""}${stale ? " · 陈旧缓存" : ""}：正在显示已读取的公共副本，实际缓存时间 ${stamp(cache.generatedAt)}。`,
    { className: "data-warning", role: "status" },
  );
}
