// A-P3-YEAR · 没写年份的公告日期按参照日期确定性补全年份（ADR-0013，纯函数）。
import { describe, expect, it } from "vitest";
import { YEAR_COMPLETION_CAPTURE_WINDOW, YEAR_COMPLETION_WINDOW } from "./params/registry";
import {
  completeYear,
  earliestExplicitDate,
  parseYearlessDate,
  yearCompletionBasis,
  yearCompletionWindow,
} from "./year-completion";

const tz = "UTC+08:00";

describe("A-P3-YEAR 识别没写年份的日期", () => {
  it("只认整体就是 M月D日（可带时刻与时区注记）的原文", () => {
    expect(parseYearlessDate("10月1日")).toEqual({ month: 10, day: 1, time: null });
    expect(parseYearlessDate(" 10月16日 ")).toEqual({ month: 10, day: 16, time: null });
    expect(parseYearlessDate("10月10日 23:59 (UTC+8)")).toEqual({
      month: 10,
      day: 10,
      time: { hour: 23, minute: 59, second: 0 },
    });
    expect(parseYearlessDate("9月30日10:00（服务器时间）")?.time).toEqual({
      hour: 10,
      minute: 0,
      second: 0,
    });
    expect(parseYearlessDate("2月29日")).toEqual({ month: 2, day: 29, time: null });
    for (const raw of [
      "2026/10/01",
      "10月1日更新",
      "第一期10月1日",
      "9月9日-10月10日",
      "2月30日",
      "13月1日",
      "10月1日 24:00",
      "10月1日 晚",
      "7.1版本更新后",
    ])
      expect(parseYearlessDate(raw)).toBeNull();
  });

  it("参照日期取文本里最早的四位年份日期，两种写法都认，不存在的日子不算", () => {
    expect(
      earliestExplicitDate([
        "2026/09/23 06:00开始，预计5个小时完成。",
        "请旅行者于2026/09/26 06:00前上线收取邮件。",
        "首个版本于2026年9月10日上线",
      ]),
    ).toBe("2026-09-10");
    expect(earliestExplicitDate(["10月1日", "2026/02/30 10:00"])).toBeNull();
    expect(earliestExplicitDate([])).toBeNull();
  });

  it("A-P3-HYPHEN 横线写法（绝区零调频公告）也算参照日期；不存在的日子和多出的数字不算", () => {
    expect(
      earliestExplicitDate([
        "本期代理人与音擎调频活动时间为： 2026-09-30 12:00（服务器时间） ~ 2026-10-20 14:59（服务器时间）",
        "2026/10/03 10:00（服务器时间）",
      ]),
    ).toBe("2026-09-30");
    expect(earliestExplicitDate(["2026-02-30 12:00", "编号 2026-09-301"])).toBeNull();
    expect(earliestExplicitDate(["编号 12026-09-30", "单号 92026/09/30"])).toBeNull();
  });
});

describe("A-P3-YEAR 补全年份", () => {
  it("年份取落在参照日期前后窗口内的那一年；只写日期的保持日期精度，写了时刻的按北京时间换算", () => {
    expect(completeYear("10月1日", "2026-09-23", tz)).toEqual({
      precision: "date",
      date: "2026-10-01",
      source_timezone: tz,
      raw_expression: "10月1日",
      time_basis: "deterministic_derived",
    });
    expect(completeYear("10月10日 23:59 (UTC+8)", "2026-09-09", tz)).toEqual({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-10T15:59:00Z"),
      source_timezone: tz,
      raw_expression: "10月10日 23:59 (UTC+8)",
      time_basis: "deterministic_derived",
    });
  });

  it("跨年按窗口落到相邻年份；窗口边界含当天，超出窗口保持未定", () => {
    // 12 月的公告写"1月5日"是次年；1 月的公告写"12月28日"是上一年（在前 30 天内）。
    expect(completeYear("1月5日", "2026-12-20", tz)).toMatchObject({ date: "2027-01-05" });
    expect(completeYear("12月28日", "2027-01-10", tz)).toMatchObject({ date: "2026-12-28" });
    const before = YEAR_COMPLETION_WINDOW.beforeDays;
    const after = YEAR_COMPLETION_WINDOW.afterDays;
    expect(before + after).toBeLessThan(365);
    // 参照 2026-09-23：前 30 天是 08-24，后 330 天是 2027-08-19。
    expect(completeYear("8月24日", "2026-09-23", tz)).toMatchObject({ date: "2026-08-24" });
    expect(completeYear("8月19日", "2026-09-23", tz)).toMatchObject({ date: "2027-08-19" });
    expect(completeYear("8月20日", "2026-09-23", tz)).toBeNull();
    expect(completeYear("8月23日", "2026-09-23", tz)).toBeNull();
  });

  it("2 月 29 日只在闰年存在；识别不了的原文或参照日期无效时不补", () => {
    expect(completeYear("2月29日", "2027-12-01", tz)).toMatchObject({ date: "2028-02-29" });
    expect(completeYear("2月29日", "2026-01-15", tz)).toBeNull();
    expect(completeYear("10月1日更新", "2026-09-23", tz)).toBeNull();
    expect(completeYear("10月1日", "2026-13-01", tz)).toBeNull();
  });

  it("A-P3-YEAR-CAPTURE 参照为首次采集日期时用更窄的窗口（ADR-0027）", () => {
    expect(yearCompletionWindow("captured")).toBe(YEAR_COMPLETION_CAPTURE_WINDOW);
    for (const source of ["article", "version", "published"] as const)
      expect(yearCompletionWindow(source)).toBe(YEAR_COMPLETION_WINDOW);
    const capture = yearCompletionWindow("captured");
    // 2026-10-07 线上的两个绝区零节点：前瞻公告 10-06 首次采集，假日相册公告 10-04 首次采集。
    expect(completeYear("10月09日 19:30", "2026-10-06", tz, capture)).toEqual({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-09T11:30:00Z"),
      source_timezone: tz,
      raw_expression: "10月09日 19:30",
      time_basis: "deterministic_derived",
    });
    expect(completeYear("9月9日", "2026-10-04", tz, capture)).toMatchObject({
      precision: "date",
      date: "2026-09-09",
    });
    expect(completeYear("10月10日 23:59 (UTC+8)", "2026-10-04", tz, capture)).toMatchObject({
      utc_ms: Date.parse("2026-10-10T15:59:00Z"),
    });
    // 参照 2026-10-04：前 30 天是 09-04，后 90 天是 2027-01-02；边界含当天。
    expect(completeYear("9月4日", "2026-10-04", tz, capture)).toMatchObject({ date: "2026-09-04" });
    expect(completeYear("9月3日", "2026-10-04", tz, capture)).toBeNull();
    expect(completeYear("1月2日", "2026-10-04", tz, capture)).toMatchObject({ date: "2027-01-02" });
    expect(completeYear("1月3日", "2026-10-04", tz, capture)).toBeNull();
    // 首次采集晚于真实发布：一个多月前的日期用默认窗口会被补到下一年，窄窗口保持未定。
    expect(completeYear("8月1日", "2026-10-04", tz)).toMatchObject({ date: "2027-08-01" });
    expect(completeYear("8月1日", "2026-10-04", tz, capture)).toBeNull();
  });

  it("推导依据写明年份是补出来的；不是补年份的节点没有依据文本", () => {
    const value = completeYear("10月1日", "2026-09-23", tz);
    if (value === null) throw new Error("应补出年份");
    expect(yearCompletionBasis("10月1日", value)).toContain("补全为 2026 年");
    expect(yearCompletionBasis("10月1日", value)).toContain("不是官方直接写出的");
    // ADR-0027：公开节点不保存参照来源，依据文本要涵盖首次采集日期。
    expect(yearCompletionBasis("10月1日", value)).toContain("本站首次采集这篇公告的日期");
    expect(
      yearCompletionBasis("2026/10/01", { ...value, raw_expression: "2026/10/01" }),
    ).toBeNull();
  });
});
