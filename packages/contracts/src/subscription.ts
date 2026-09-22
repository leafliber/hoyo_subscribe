// 云端订阅配置的唯一 Zod schema（主方案 §5.1、§4.4；CONTRACTS_BASELINE.md §3）。
//
// 合同要点：
// - `schema_version` 固定为 3（其他版本直接拒绝）。
// - 数组是有限枚举，解析时**去重并排序**（规范化为确定性形态）；拒绝未知键与任何额外层级
//   （strictObject 贯穿全部嵌套层）。
// - 非空约束只对 `state = initialized` 成立；`uninitialized` 表示用户尚未做过任何选择，
//   放行空 scope / calendar.event_types。state 在订阅行上而不在 JSON 里，因此以
//   `subscriptionConfigSchemaFor(state)` 的方式施加条件约束。
// - `notifications.rule_ids` **允许为空数组**：只要变更消息而不要任何提前提醒是合法配置
//   （§5.3），不得以"规则为空"拒绝保存（AGENTS.md 第 3 节禁止清单）。
// - `email_channels.routine_enabled` 等通道状态不进本 JSON（§5.1/§7.5）。
import { z } from "zod";
import {
  EventTypeSchema,
  GameIdSchema,
  NodeTypeSchema,
  RegionIdSchema,
  type SubscriptionState,
} from "./enums";
import { RuleIdSchema } from "./rules";

/** 配置结构版本（主方案 §5.1 的 schema_version 字面量，属合同定义而非可调参数）。 */
export const SUBSCRIPTION_SCHEMA_VERSION = 3;

/** 数组规范化：去重 + 按码位排序，得到确定性的规范化形态（§5.1"去重排序"）。 */
function canonicalizeEnumArray<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** 订阅配置 JSON 的结构合同（不含 state 条件约束）。 */
export const SubscriptionConfigSchema = z.strictObject({
  schema_version: z.literal(SUBSCRIPTION_SCHEMA_VERSION),
  // 配置行版本，保存成功时递增；首版示例为 1（推断：≥1 的整数，见交付报告）。
  revision: z.int().min(1),
  scope: z.strictObject({
    games: z.array(GameIdSchema).transform(canonicalizeEnumArray),
    regions: z.array(RegionIdSchema).transform(canonicalizeEnumArray),
  }),
  calendar: z.strictObject({
    event_types: z.array(EventTypeSchema).transform(canonicalizeEnumArray),
    node_types: z.array(NodeTypeSchema).transform(canonicalizeEnumArray),
    alarms_enabled: z.boolean(),
  }),
  notifications: z.strictObject({
    rule_ids: z.array(RuleIdSchema).transform(canonicalizeEnumArray),
    // 变更通知四开关。它们不是"提前零分钟"的规则（§5.3），与 rule_ids 无从属关系。
    new_event: z.boolean(),
    important_change: z.boolean(),
    cancelled_or_retracted: z.boolean(),
    late_discovery: z.boolean(),
  }),
});

/** 解析后的订阅配置（数组已完成去重排序）。 */
export type SubscriptionConfig = z.output<typeof SubscriptionConfigSchema>;

// §5.1：scope 与 calendar.event_types 不得为空**只适用于 initialized**。
// calendar.node_types 无非空约束：事件类型可见但一个基础节点都不勾是合法配置，
// 此时日历只剩提醒关联节点（见 calendar-nodes.ts）。
const InitializedSubscriptionConfigSchema = SubscriptionConfigSchema.superRefine((config, ctx) => {
  if (config.scope.games.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "games"],
      message: "initialized 订阅的 scope.games 不得为空（主方案 §5.1）",
    });
  }
  if (config.scope.regions.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["scope", "regions"],
      message: "initialized 订阅的 scope.regions 不得为空（主方案 §5.1）",
    });
  }
  if (config.calendar.event_types.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["calendar", "event_types"],
      message: "initialized 订阅的 calendar.event_types 不得为空（主方案 §5.1）",
    });
  }
});

/** 按订阅行状态取对应 schema：uninitialized 放行空数组，initialized 施加非空约束。 */
export function subscriptionConfigSchemaFor(state: SubscriptionState) {
  return state === "initialized" ? InitializedSubscriptionConfigSchema : SubscriptionConfigSchema;
}

/** 按状态解析订阅配置：结构与 state 条件约束一次完成。 */
export function parseSubscriptionConfig(
  state: SubscriptionState,
  input: unknown,
): z.ZodSafeParseResult<SubscriptionConfig> {
  return subscriptionConfigSchemaFor(state).safeParse(input);
}
