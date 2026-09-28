// F2-01 界面文案：只给 contracts 已定义的枚举和规则提供显示名称。
// 提醒规则的事件类型、节点类型和提前量仍以 rules.ts 为唯一来源。
import type { EventType, GameId, NodeType } from "./enums";
import { REMINDER_RULES } from "./rules";
import type { SubscriptionConfig } from "./subscription";

export const SUBSCRIPTION_GAME_LABELS = {
  genshin: "原神",
  hsr: "崩坏：星穹铁道",
  zzz: "绝区零",
} as const satisfies Record<GameId, string>;

export const SUBSCRIPTION_EVENT_TYPE_LABELS = {
  livestream: "前瞻",
  maintenance: "维护",
  limited_event: "限时活动",
  gacha: "卡池",
} as const satisfies Record<EventType, string>;

export const SUBSCRIPTION_NODE_TYPE_LABELS = {
  start: "开始",
  end: "结束",
  phase_unlock: "阶段解锁",
  reward_deadline: "奖励领取截止",
  expected_end: "预计结束",
  actual_end: "实际结束",
} as const satisfies Record<NodeType, string>;

/** 文案直接投影现有规则注册表，不复制 rule_id 与提前量的定义。 */
export const SUBSCRIPTION_RULE_COPY = REMINDER_RULES.map((rule) => ({
  rule_id: rule.rule_id,
  label: rule.user_copy_zh,
}));

type ChangeKey = Exclude<keyof SubscriptionConfig["notifications"], "rule_ids">;

/** 四个变更开关的界面名称；key 的完整性由 SubscriptionConfig 类型约束。 */
export const SUBSCRIPTION_CHANGE_COPY = [
  { key: "new_event", label: "新事件公布" },
  { key: "important_change", label: "重要更正" },
  { key: "cancelled_or_retracted", label: "取消或撤回" },
  { key: "late_discovery", label: "晚收录补充提醒" },
] as const satisfies readonly { key: ChangeKey; label: string }[];
