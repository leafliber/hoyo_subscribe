// P3-03 · 三公告 API 已核验的 UTC+8 完整时间解析；规则和候选证据校验共用。
import { ExactTimeSchema, type ExactTimeValue } from "@hoyo/contracts";

/** docs/evidence/p0/source-params.md §2.4：正文 API timezone=8。 */
export const ANNOUNCEMENT_TIMEZONE = "UTC+08:00";
// P3-24：绝区零调频公告写"2026-09-30 12:00"，与斜线写法同一含义；分隔符前后必须一致。
export const FULL_DATE_TIME_SHAPE = /^(\d{4})([/-])(\d{2})\2(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

export function parseAnnouncementExactTime(raw: string): ExactTimeValue | null {
  const match = FULL_DATE_TIME_SHAPE.exec(raw);
  if (match === null) return null;
  const [, year, , month, day, hour, minute, second] = match;
  const full = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}`;
  const utcMs = Date.parse(`${full}+08:00`);
  if (!Number.isSafeInteger(utcMs)) return null;
  // Date.parse 可能把不存在的日子顺延；往返校验阻止这种"修复"。
  const roundTrip = new Date(utcMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  if (roundTrip !== full) return null;
  return {
    precision: "datetime",
    utc_ms: ExactTimeSchema.parse(utcMs),
    source_timezone: ANNOUNCEMENT_TIMEZONE,
    raw_expression: raw,
    time_basis: "official_explicit",
  };
}

// ADR-0030：兑换码说明里"2026年10月10日 12:00"一类带年份的中文完整时刻，按北京时间解析为官方明确时间。
const CHINESE_DATE_TIME_SHAPE =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function parseChineseExactTime(raw: string): ExactTimeValue | null {
  const match = CHINESE_DATE_TIME_SHAPE.exec(raw);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const pad = (value: string) => value.padStart(2, "0");
  const full = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second ?? "00"}`;
  const utcMs = Date.parse(`${full}+08:00`);
  if (!Number.isSafeInteger(utcMs)) return null;
  const roundTrip = new Date(utcMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  if (roundTrip !== full) return null;
  return {
    precision: "datetime",
    utc_ms: ExactTimeSchema.parse(utcMs),
    source_timezone: ANNOUNCEMENT_TIMEZONE,
    raw_expression: raw,
    time_basis: "official_explicit",
  };
}
