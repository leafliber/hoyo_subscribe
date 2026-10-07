// ADR-0030 · 兑换码有效期：从官方说明里认出写法（contracts redeemExpiryExpression），按已有规则换算。
// 带年份的完整时刻是官方明确时间；没写年份的按同一正文里最早写明年份的日期补全年份（ADR-0013，参照为
// 正文日期），只写日期的保持日期精度。规则模板（日历的结束节点）与采集（「有效兑换码」条）共用本函数，
// 两处结果一致。
import {
  completeYear,
  redeemExpiryExpression,
  type TimeValue,
  yearCompletionWindow,
} from "@hoyo/contracts";
import { ANNOUNCEMENT_TIMEZONE, parseAnnouncementExactTime, parseChineseExactTime } from "./time";

export function redeemExpiryTime(tip: string, referenceDate: string | null): TimeValue | null {
  const raw = redeemExpiryExpression(tip);
  if (raw === null) return null;
  return (
    parseAnnouncementExactTime(raw) ??
    parseChineseExactTime(raw) ??
    (referenceDate === null
      ? null
      : completeYear(raw, referenceDate, ANNOUNCEMENT_TIMEZONE, yearCompletionWindow("article")))
  );
}

/** 「有效兑换码」条的截止时刻：精确时刻原样；只写了日期的取该日北京时间结束（次日 0 点）。 */
export function redeemExpiryInstant(time: TimeValue): number | null {
  if (time.precision === "datetime") return time.utc_ms;
  if (time.precision === "date") return Date.parse(`${time.date}T00:00:00+08:00`) + 86_400_000;
  return null;
}
