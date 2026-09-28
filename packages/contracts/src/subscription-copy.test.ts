import { describe, expect, it } from "vitest";
import { EVENT_TYPES, NODE_TYPES, SUPPORTED_SCOPE_GAMES } from "./enums";
import { CHANGE_DEFAULTS, DEFAULT_RULE_IDS } from "./params/registry";
import { REMINDER_RULES } from "./rules";
import {
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SUBSCRIPTION_RULE_COPY,
} from "./subscription-copy";

describe("F2-01 订阅界面文案", () => {
  it("规则文案与唯一定义源一一对应，推荐项仍由 DEFAULT_RULE_IDS 决定", () => {
    expect(SUBSCRIPTION_RULE_COPY).toEqual(
      REMINDER_RULES.map((rule) => ({ rule_id: rule.rule_id, label: rule.user_copy_zh })),
    );
    const recommendedIds = new Set<string>(DEFAULT_RULE_IDS);
    expect(SUBSCRIPTION_RULE_COPY.filter((rule) => recommendedIds.has(rule.rule_id))).toHaveLength(
      DEFAULT_RULE_IDS.length,
    );
  });

  it("游戏、事件、节点与变更开关的全部合同取值都有文案", () => {
    expect(Object.keys(SUBSCRIPTION_GAME_LABELS).sort()).toEqual([...SUPPORTED_SCOPE_GAMES].sort());
    expect(Object.keys(SUBSCRIPTION_EVENT_TYPE_LABELS).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(SUBSCRIPTION_NODE_TYPE_LABELS).sort()).toEqual([...NODE_TYPES].sort());
    expect(SUBSCRIPTION_CHANGE_COPY.map((item) => item.key).sort()).toEqual(
      Object.keys(CHANGE_DEFAULTS).sort(),
    );
  });
});
