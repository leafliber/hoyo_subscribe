// 时间语义的唯一合同（主方案 §3.3、§5.1；ENGINEERING.md §5.1）。
//
// 硬约束：
// 1. ExactTime（UTC 毫秒整数）与 DateOnly（YYYY-MM-DD）在类型层面不可互转——本模块
//    **故意不提供任何二者之间的转换函数**，只有日期不补成精确午夜。
// 2. 每个时间值同时携带 source_timezone、raw_expression、time_basis、precision，
//    解析后任何一个都不可丢（A-P1-CONTRACT：精度与依据不可丢）。
// 3. 只有 official_explicit / deterministic_derived 且 precision=datetime 的值可用于提醒；
//    该资格判断由消费方组合本模块类型完成，不在此处隐式放宽或收紧。
import { z } from "zod";
import { TimeBasisSchema } from "./enums";

/**
 * 精确时间：UTC 毫秒整数（品牌类型，普通 number 不能直接赋值）。
 * epoch 起算，允许负值（1970 前的历史回填），必须是安全整数。
 */
export const ExactTimeSchema = z.int().brand<"ExactTime">();
export type ExactTime = z.output<typeof ExactTimeSchema>;

/**
 * 纯日期：`YYYY-MM-DD`（品牌类型，普通 string 不能直接赋值）。
 * 校验真实日历日期（含闰年），月份与日期两位补零。
 */
export const DateOnlySchema = z.iso.date().brand<"DateOnly">();
export type DateOnly = z.output<typeof DateOnlySchema>;

/** 捕获时记录的源时区（IANA 名称或固定偏移表达），非空字符串。 */
export const SourceTimezoneSchema = z.string().min(1);
export type SourceTimezone = string;

/** 官方原文里的原始时间表达（保留证据，不做清洗），非空字符串。 */
export const RawExpressionSchema = z.string().min(1);
export type RawExpression = string;

/** precision=datetime 的时间值：载荷是 UTC 毫秒整数。 */
export const ExactTimeValueSchema = z.strictObject({
  precision: z.literal("datetime"),
  utc_ms: ExactTimeSchema,
  source_timezone: SourceTimezoneSchema,
  raw_expression: RawExpressionSchema,
  time_basis: TimeBasisSchema,
});
export type ExactTimeValue = z.output<typeof ExactTimeValueSchema>;

/** precision=date 的时间值：载荷是 YYYY-MM-DD。结构上不存在 utc_ms 字段。 */
export const DateOnlyValueSchema = z.strictObject({
  precision: z.literal("date"),
  date: DateOnlySchema,
  source_timezone: SourceTimezoneSchema,
  raw_expression: RawExpressionSchema,
  time_basis: TimeBasisSchema,
});
export type DateOnlyValue = z.output<typeof DateOnlyValueSchema>;

/**
 * precision=unknown 的时间值：没有可用的时刻或日期载荷（"更新后开放"、矛盾日期进入审核等）。
 * 依据与原始表达仍然保留，不得因为"未知"而丢掉证据。
 */
export const UnknownTimeValueSchema = z.strictObject({
  precision: z.literal("unknown"),
  source_timezone: SourceTimezoneSchema,
  raw_expression: RawExpressionSchema,
  time_basis: TimeBasisSchema,
});
export type UnknownTimeValue = z.output<typeof UnknownTimeValueSchema>;

/** 一个时间值的完整合同：precision 决定载荷形状，元数据四件套齐备。 */
export const TimeValueSchema = z.discriminatedUnion("precision", [
  ExactTimeValueSchema,
  DateOnlyValueSchema,
  UnknownTimeValueSchema,
]);
export type TimeValue = z.output<typeof TimeValueSchema>;
