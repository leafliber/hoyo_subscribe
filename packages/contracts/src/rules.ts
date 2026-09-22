// 固定提醒规则注册表——唯一定义源（主方案附录 A.6；用户文案来自前端设计 v1.0 §6.2）。
//
// 合同要点（主方案 §5.3）：
// - rule_id 及其语义只列于附录 A，不接受任意脚本或自然语言表达式。
// - 规则标识一旦发布**不得改成另一种提前量**；新增语义用新 ID。
// - "前 1 天"沿用固定提前量（86,400 秒），不改成前一日零点。
// - 用户文案是注册表上的**映射**，不是第二份业务定义：前端只读取，不得反推规则。

import { z } from "zod";
import type { EventType, NodeType } from "./enums";

/** 固定提前量（秒）。这两个数值是 A.6 注册表的定义性数据，不是可调参数。 */
export type RuleLeadTimeSeconds = 3600 | 86400;

/** 一条提醒规则：事件类型 × 节点类型 × 固定提前量，附前端 §6.2 的用户文案。 */
export interface ReminderRule {
  readonly rule_id: string;
  readonly event_type: EventType;
  readonly node_type: NodeType;
  readonly lead_time_seconds: RuleLeadTimeSeconds;
  /** 用户文案（前端 v1.0 §6.2 的映射表，与注册表同源导出）。 */
  readonly user_copy_zh: string;
}

// 附录 A.6 全表。行序与附录一致；`as const satisfies` 保留字面量类型供 RuleId 推导。
export const REMINDER_RULES = [
  {
    rule_id: "livestream_start_1h",
    event_type: "livestream",
    node_type: "start",
    lead_time_seconds: 3600,
    user_copy_zh: "前瞻开始前 1 小时",
  },
  {
    rule_id: "maintenance_start_1h",
    event_type: "maintenance",
    node_type: "start",
    lead_time_seconds: 3600,
    user_copy_zh: "维护开始前 1 小时",
  },
  {
    rule_id: "limited_start_1h",
    event_type: "limited_event",
    node_type: "start",
    lead_time_seconds: 3600,
    user_copy_zh: "限时活动开始前 1 小时",
  },
  {
    rule_id: "limited_end_1d",
    event_type: "limited_event",
    node_type: "end",
    lead_time_seconds: 86400,
    user_copy_zh: "限时活动结束前 1 天",
  },
  {
    rule_id: "gacha_start_1h",
    event_type: "gacha",
    node_type: "start",
    lead_time_seconds: 3600,
    user_copy_zh: "卡池开始前 1 小时",
  },
  {
    rule_id: "gacha_end_1d",
    event_type: "gacha",
    node_type: "end",
    lead_time_seconds: 86400,
    user_copy_zh: "卡池结束前 1 天",
  },
  {
    rule_id: "phase_unlock_1h",
    event_type: "limited_event",
    node_type: "phase_unlock",
    lead_time_seconds: 3600,
    user_copy_zh: "活动阶段解锁前 1 小时",
  },
  {
    rule_id: "reward_deadline_1d",
    event_type: "limited_event",
    node_type: "reward_deadline",
    lead_time_seconds: 86400,
    user_copy_zh: "奖励领取截止前 1 天",
  },
] as const satisfies readonly ReminderRule[];

/** 全部合法 rule_id 的 TS 联合类型（从注册表推导，保证不出现第二份清单）。 */
export type RuleId = (typeof REMINDER_RULES)[number]["rule_id"];

export const RULE_IDS: readonly RuleId[] = REMINDER_RULES.map((rule) => rule.rule_id);

export const RuleIdSchema = z.enum(RULE_IDS);

/** 按 rule_id 查注册表；不存在返回 undefined（消费方据此拒绝，不得静默忽略）。 */
export function getReminderRule(rule_id: string): ReminderRule | undefined {
  return REMINDER_RULES.find((rule) => rule.rule_id === rule_id);
}

/** 一组 rule_id 所涉及的事件类型集合（变更通知范围与日历有效节点公式的共用部分）。 */
export function ruleEventTypes(rule_ids: readonly string[]): ReadonlySet<EventType> {
  const types = new Set<EventType>();
  for (const id of rule_ids) {
    const rule = getReminderRule(id);
    if (rule !== undefined) {
      types.add(rule.event_type);
    }
  }
  return types;
}
