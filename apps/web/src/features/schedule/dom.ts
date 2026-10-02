import {
  browseTimestamp,
  nodeTime,
  type PublicCache,
  type PublicScheduleNode,
  type TimeValue,
} from "@hoyo/contracts";

/** 所有外部字符串均作为文本节点；不使用 innerHTML。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  for (const child of children) if (child !== null && child !== false) element.append(child);
  return element;
}
export const timestamp = (value: number | null) =>
  value === null ? "未知" : `${browseTimestamp(value)} · UTC+8`;
export function timeNode(time: TimeValue, status: PublicScheduleNode["status"] = "scheduled") {
  const label = nodeTime({ time, status });
  return time.precision === "datetime" && status !== "cancelled" && status !== "retracted"
    ? el("time", { datetime: new Date(time.utc_ms).toISOString() }, label)
    : el("span", {}, label);
}
export function cacheNotice(cache: PublicCache, label = "日程") {
  const offline = !navigator.onLine;
  const stale = Date.now() > cache.freshUntil;
  return offline || stale
    ? el(
        "aside",
        { class: "data-warning", role: "status" },
        `${label}${offline ? " · 离线" : ""}${stale ? " · 陈旧缓存" : ""}：显示已读取的公共副本。实际缓存时间 ${timestamp(cache.generatedAt)}。`,
      )
    : null;
}
export function button(label: string, action: string) {
  return el(
    "button",
    { type: "button", class: "button button--secondary", "data-action": action },
    label,
  );
}
