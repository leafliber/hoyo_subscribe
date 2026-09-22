import { describe, expect, it } from "vitest";
import {
  type DateOnly,
  DateOnlySchema,
  DateOnlyValueSchema,
  type ExactTime,
  ExactTimeSchema,
  ExactTimeValueSchema,
  TimeValueSchema,
  UnknownTimeValueSchema,
} from "./time";

describe("A-P1-CONTRACT 时间语义（主方案 §3.3、ENGINEERING.md §5.1）", () => {
  it("ExactTime 只接受安全整数的 UTC 毫秒", () => {
    expect(ExactTimeSchema.safeParse(0).success).toBe(true);
    expect(ExactTimeSchema.safeParse(1750000000000).success).toBe(true);
    // 1970 前的历史回填允许负值
    expect(ExactTimeSchema.safeParse(-86400000).success).toBe(true);
    expect(ExactTimeSchema.safeParse(1.5).success).toBe(false);
    expect(ExactTimeSchema.safeParse(Number.NaN).success).toBe(false);
    expect(ExactTimeSchema.safeParse("1750000000000").success).toBe(false);
    expect(ExactTimeSchema.safeParse(2 ** 53).success).toBe(false);
  });

  it("DateOnly 校验 YYYY-MM-DD 与真实日历日期（含闰年）", () => {
    expect(DateOnlySchema.safeParse("2026-09-22").success).toBe(true);
    expect(DateOnlySchema.safeParse("2024-02-29").success).toBe(true);
    expect(DateOnlySchema.safeParse("2023-02-29").success).toBe(false);
    expect(DateOnlySchema.safeParse("2026-02-30").success).toBe(false);
    expect(DateOnlySchema.safeParse("2026-04-31").success).toBe(false);
    expect(DateOnlySchema.safeParse("2026-9-22").success).toBe(false);
    expect(DateOnlySchema.safeParse("2026-09-2").success).toBe(false);
    expect(DateOnlySchema.safeParse("20260922").success).toBe(false);
    expect(DateOnlySchema.safeParse(20260922).success).toBe(false);
    expect(DateOnlySchema.safeParse("2026-09-22T00:00:00Z").success).toBe(false);
  });

  it("ExactTime 与 DateOnly 类型层面不可互转（编译期断言，由 typecheck 执行）", () => {
    const plainNumber = 1750000000000;
    const plainString = "2026-09-22";
    // @ts-expect-error 普通 number 不能赋给品牌类型 ExactTime
    const asExact: ExactTime = plainNumber;
    // @ts-expect-error 普通 string 不能赋给品牌类型 DateOnly
    const asDate: DateOnly = plainString;
    // @ts-expect-error ExactTime 不能赋给 DateOnly
    const crossed1: DateOnly = asExact;
    // @ts-expect-error DateOnly 不能赋给 ExactTime
    const crossed2: ExactTime = asDate;
    expect([asExact, asDate, crossed1, crossed2]).toHaveLength(4);
  });

  it("纯日期不补午夜：precision=date 的值结构上不存在 utc_ms 字段", () => {
    const parsed = DateOnlyValueSchema.parse({
      precision: "date",
      date: "2026-09-22",
      source_timezone: "Asia/Shanghai",
      raw_expression: "9月22日开启",
      time_basis: "official_explicit",
    });
    expect(parsed.date).toBe("2026-09-22");
    expect("utc_ms" in parsed).toBe(false);
    // 混入午夜毫秒会被 strict 拒绝（未知键）
    expect(
      DateOnlyValueSchema.safeParse({
        precision: "date",
        date: "2026-09-22",
        source_timezone: "Asia/Shanghai",
        raw_expression: "9月22日开启",
        time_basis: "official_explicit",
        utc_ms: 1789996800000,
      }).success,
    ).toBe(false);
  });

  it("precision 决定载荷：datetime 必须带 utc_ms，date 必须带 date", () => {
    const meta = {
      source_timezone: "Asia/Shanghai",
      raw_expression: "2026-09-22 20:00",
      time_basis: "official_explicit",
    } as const;
    expect(
      ExactTimeValueSchema.safeParse({ precision: "datetime", utc_ms: 1789996800000, ...meta })
        .success,
    ).toBe(true);
    expect(ExactTimeValueSchema.safeParse({ precision: "datetime", ...meta }).success).toBe(false);
    expect(
      DateOnlyValueSchema.safeParse({ precision: "date", date: "2026-09-22", ...meta }).success,
    ).toBe(true);
    // datetime 精度却给 date 字段（或反之）会被判别联合拒绝
    expect(
      ExactTimeValueSchema.safeParse({ precision: "datetime", date: "2026-09-22", ...meta })
        .success,
    ).toBe(false);
  });

  it("精度与依据不可丢：任何 precision 都必须携带 time_basis 与原始表达", () => {
    const full = {
      precision: "unknown",
      source_timezone: "Asia/Shanghai",
      raw_expression: "更新后开放",
      time_basis: "unresolved",
    } as const;
    expect(UnknownTimeValueSchema.safeParse(full).success).toBe(true);
    expect(TimeValueSchema.safeParse(full).success).toBe(true);
    for (const key of ["source_timezone", "raw_expression", "time_basis"] as const) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[key];
      expect(TimeValueSchema.safeParse(partial).success).toBe(false);
    }
    // 未知键拒绝
    expect(TimeValueSchema.safeParse({ ...full, guessed_midnight: "2026-09-22" }).success).toBe(
      false,
    );
  });

  it("TimeValue 判别联合按 precision 收敛到对应类型", () => {
    expect(
      TimeValueSchema.parse({
        precision: "unknown",
        source_timezone: "Asia/Shanghai",
        raw_expression: "维护预计五小时",
        time_basis: "official_estimate",
      }),
    ).toMatchObject({ precision: "unknown" });
  });
});
