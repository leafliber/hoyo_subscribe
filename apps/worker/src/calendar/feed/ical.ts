// P3-06 · RFC 5545 格式层；投影、窗口、闹钟资格由 contracts 决定。
import type { TimeValue } from "@hoyo/contracts";

export interface IcalEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly modifiedAt: number;
  readonly time: Exclude<TimeValue, { precision: "unknown" }>;
  readonly summary: string;
  readonly description: string;
  readonly url: string | null;
  readonly cancelled: boolean;
  readonly alarmSeconds: readonly number[];
}
const encoder = new TextEncoder();

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}
/** RFC 5545 §3.1：每物理行至多 75 octets，续行空格也占一字节。 */
export function foldLine(value: string): string {
  let line = "";
  let bytes = 0;
  const lines: string[] = [];
  for (const char of value) {
    const width = encoder.encode(char).length;
    if (bytes + width > 75) {
      lines.push(line);
      line = " ";
      bytes = 1;
    }
    line += char;
    bytes += width;
  }
  lines.push(line);
  return lines.join("\r\n");
}
function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
export function serializeCalendar(events: readonly IcalEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HoYo Calendar//Personal Feed//ZH",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    if (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence >= 2 ** 31 - 1)
      throw new Error("SEQUENCE 需要迁移");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `SEQUENCE:${event.sequence}`,
      `DTSTAMP:${utc(event.modifiedAt)}`,
      `LAST-MODIFIED:${utc(event.modifiedAt)}`,
      event.time.precision === "datetime"
        ? `DTSTART:${utc(event.time.utc_ms)}`
        : `DTSTART;VALUE=DATE:${event.time.date.replace(/-/g, "")}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      "TRANSP:TRANSPARENT",
    );
    // 一个节点没有事实结束时刻，不合成 DTEND。DATE 无 DTEND 按 RFC §3.6.1 持续一天（非包含结束）。
    if (event.url !== null) {
      const url = new URL(event.url);
      if (!["https:", "http:"].includes(url.protocol) || /[\r\n]/.test(event.url))
        throw new Error("官方 URL 无效");
      lines.push(`URL:${url.href}`);
    }
    if (event.cancelled) lines.push("STATUS:CANCELLED");
    for (const seconds of event.alarmSeconds) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `TRIGGER:-PT${seconds}S`,
        `DESCRIPTION:${escapeText(event.summary)}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
