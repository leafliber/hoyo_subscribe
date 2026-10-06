// 没写年份的公告日期按同一公告给出的参照日期确定性补全年份（ADR-0013；主方案 §3.3"确定性推导"）。
//
// 模型照原文摘录"10月1日"（ADR-0010 提示词不补年份），补全只在服务端按本模块完成：
// - 原始表达必须整体就是"M月D日"，可带"HH:MM(:SS)"与"(UTC+8)""（服务器时间）"注记；夹带其他文字的不补。
// - 参照日期由调用方按"正文里最早的四位年份日期 > 所属版本已确认的更新开始 > 公告发布日期"选定。
// - 年份取让日期落在参照日期前 beforeDays 天到后 afterDays 天之内的那一年（YEAR_COMPLETION_WINDOW）。
//   窗口短于一年，至多一个年份符合；没有符合的年份时返回 null，保持"未定时刻"。
// 公告时间一律按北京时间（正文 API timezone=8，P0-02 §2.4；国服"服务器时间"同为 UTC+8）。
// 本模块是纯函数，不读库、不调用模型。
import { YEAR_COMPLETION_WINDOW } from "./params/registry";
import { DateOnlySchema, ExactTimeSchema, type TimeValue } from "./time";

// 单位换算，非预算、配额或 Feed 参数。
const DAY = 86_400_000;
const UTC8 = 8 * 3_600_000;

export interface YearlessDate {
  readonly month: number;
  readonly day: number;
  /** 写了时刻时为北京时间的时、分、秒；只写日期时为 null。 */
  readonly time: { readonly hour: number; readonly minute: number; readonly second: number } | null;
}

/** 参照日期从哪里来；写进推导依据，让审核员知道补出的年份凭什么。 */
export type YearReferenceSource = "article" | "version" | "published";

export interface YearReference {
  /** 北京时间日期 YYYY-MM-DD。 */
  readonly date: string;
  readonly source: YearReferenceSource;
  /** source 为 version 时是所属版本号。 */
  readonly version?: string;
}

const YEARLESS =
  /^(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*[(（](?:UTC\+8|UTC\+08:00|GMT\+8|服务器时间)[)）])?$/;
// 年份前面不能紧挨着数字：长数字串里的"2026-09-30"不是日期（PR #99 审查意见）。
const EXPLICIT_DATE =
  /(?<!\d)(\d{4})(?:\/(\d{1,2})\/(\d{1,2})|年(\d{1,2})月(\d{1,2})日|-(\d{1,2})-(\d{1,2})(?!\d))/g;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 公历上真实存在的日子才算（2 月 30 日、平年 2 月 29 日都不算）。 */
function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const value = new Date(ms).toISOString().slice(0, 10);
  return value === `${year}-${pad(month)}-${pad(day)}` ? value : null;
}

/** 原始表达整体是没写年份的日期（可带时刻与时区注记）才识别；其余返回 null。 */
export function parseYearlessDate(rawExpression: string): YearlessDate | null {
  const match = YEARLESS.exec(rawExpression.trim());
  if (match === null) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  // 2 月 29 日在闰年存在，这里只排除任何年份都不存在的日子。
  if (isoDate(2024, month, day) === null) return null;
  if (match[3] === undefined) return { month, day, time: null };
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = match[5] === undefined ? 0 : Number(match[5]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { month, day, time: { hour, minute, second } };
}

/** 文本里最早的四位年份日期（"2026/09/23""2026年9月23日"或"2026-09-23"），作为补全年份的参照；没有时为 null。 */
export function earliestExplicitDate(texts: readonly string[]): string | null {
  let earliest: string | null = null;
  for (const text of texts)
    for (const match of text.matchAll(EXPLICIT_DATE)) {
      const value = isoDate(
        Number(match[1]),
        Number(match[2] ?? match[4] ?? match[6]),
        Number(match[3] ?? match[5] ?? match[7]),
      );
      if (value !== null && (earliest === null || value < earliest)) earliest = value;
    }
  return earliest;
}

/**
 * 按参照日期补全年份。年份唯一确定时返回 deterministic_derived 的时间：只写日期的仍是日期精度，
 * 写了时刻的按北京时间换成精确时刻；原始表达保留。识别不了或没有符合窗口的年份时返回 null。
 */
export function completeYear(
  rawExpression: string,
  referenceDate: string,
  sourceTimezone: string,
): TimeValue | null {
  const parsed = parseYearlessDate(rawExpression);
  const reference = DateOnlySchema.safeParse(referenceDate);
  if (parsed === null || !reference.success) return null;
  const referenceMs = Date.parse(`${reference.data}T00:00:00Z`);
  const lower = referenceMs - YEAR_COMPLETION_WINDOW.beforeDays * DAY;
  const upper = referenceMs + YEAR_COMPLETION_WINDOW.afterDays * DAY;
  const year = Number(reference.data.slice(0, 4));
  const matches = [year - 1, year, year + 1].flatMap((candidate) => {
    const date = isoDate(candidate, parsed.month, parsed.day);
    if (date === null) return [];
    const ms = Date.parse(`${date}T00:00:00Z`);
    return ms >= lower && ms <= upper ? [date] : [];
  });
  if (matches.length !== 1) return null;
  const [date] = matches;
  if (parsed.time === null)
    return {
      precision: "date",
      date: DateOnlySchema.parse(date),
      source_timezone: sourceTimezone,
      raw_expression: rawExpression,
      time_basis: "deterministic_derived",
    };
  const [y, m, d] = date.split("-").map(Number);
  const { hour, minute, second } = parsed.time;
  return {
    precision: "datetime",
    utc_ms: ExactTimeSchema.parse(Date.UTC(y, m - 1, d, hour, minute, second) - UTC8),
    source_timezone: sourceTimezone,
    raw_expression: rawExpression,
    time_basis: "deterministic_derived",
  };
}

/** 公开详情与管理端展示的推导依据（前端 §4.4）；原文不是没写年份的日期时为 null。 */
export function yearCompletionBasis(rawExpression: string, value: TimeValue): string | null {
  if (parseYearlessDate(rawExpression) === null || value.time_basis !== "deterministic_derived")
    return null;
  const year =
    value.precision === "date"
      ? value.date.slice(0, 4)
      : value.precision === "datetime"
        ? new Date(value.utc_ms + UTC8).toISOString().slice(0, 4)
        : null;
  if (year === null) return null;
  return `原文未写年份，按同一公告里写明的日期（或所属版本已确认的更新时间）补全为 ${year} 年；年份不是官方直接写出的。`;
}
