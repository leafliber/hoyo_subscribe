/** 展示用时间格式化：统一按北京时间（UTC+8）呈现。只做格式化，不承载业务判断。 */
const ZONE = "Asia/Shanghai";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const monthDayFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: ZONE,
  month: "long",
  day: "numeric",
});
const weekdayFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: ZONE, weekday: "short" });
const fullDateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** 08:00 */
export function clock(ms: number): string {
  return timeFormat.format(ms);
}

/** 10月4日 */
export function monthDay(ms: number): string {
  return monthDayFormat.format(ms);
}

/** 周六 */
export function weekday(ms: number): string {
  return weekdayFormat.format(ms);
}

/** 10月4日 08:00 */
export function dateTime(ms: number): string {
  return `${monthDay(ms)} ${clock(ms)}`;
}

/** 2026年10月4日 08:00 */
export function fullDateTime(ms: number): string {
  return `${fullDateFormat.format(ms)} ${clock(ms)}`;
}

/** 把 "YYYY-MM-DD"（北京日期）解析成当天北京零点的 UTC 毫秒。 */
export function beijingDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

/** 日期分组标题：今天 / 明天 / 昨天 + 10月4日 周六 */
export function dayLabel(date: string, today: string): { relative: string | null; date: string } {
  const ms = beijingDayStart(date);
  const diff = Math.round((ms - beijingDayStart(today)) / DAY);
  const relative =
    diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : diff === -1 ? "昨天" : null;
  return { relative, date: `${monthDay(ms)} ${weekday(ms)}` };
}

/** 2026-10-04 → 10月4日 周六 */
export function dateOnlyLabel(date: string): string {
  const ms = beijingDayStart(date);
  return `${monthDay(ms)} ${weekday(ms)}`;
}

/**
 * 相对时间：3 天后 / 5 小时后 / 12 分钟后 / 刚刚 / 2 小时前。
 * 只作补充，页面始终同时给出绝对时间。
 */
export function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "后" : "前";
  if (abs < MINUTE) return diff >= 0 ? "即将" : "刚刚";
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)} 分钟${suffix}`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} 小时${suffix}`;
  if (abs < 3 * DAY) {
    const days = Math.floor(abs / DAY);
    const hours = Math.floor((abs % DAY) / HOUR);
    return `${days} 天${hours ? ` ${hours} 小时` : ""}${suffix}`;
  }
  return `${Math.floor(abs / DAY)} 天${suffix}`;
}

/** 剩余时长：还剩 2 天 3 小时（已过则返回 null）。 */
export function remaining(ms: number, now: number): string | null {
  const diff = ms - now;
  if (diff <= 0) return null;
  if (diff < HOUR) return `还剩 ${Math.max(1, Math.floor(diff / MINUTE))} 分钟`;
  if (diff < DAY) return `还剩 ${Math.floor(diff / HOUR)} 小时`;
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / HOUR);
  return days < 3 && hours ? `还剩 ${days} 天 ${hours} 小时` : `还剩 ${days} 天`;
}

/** 数值时间戳 → 北京时间完整文本；null 显示为「未知」。 */
export function stamp(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "未知" : fullDateTime(ms);
}
