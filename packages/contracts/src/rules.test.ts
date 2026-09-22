import { describe, expect, it } from "vitest";
import { EVENT_TYPES, NODE_TYPES } from "./enums";
import { getReminderRule, REMINDER_RULES, RULE_IDS, RuleIdSchema, ruleEventTypes } from "./rules";

// 附录 A.6 的独立抄本（验证层对照，非运行时第二定义）。
const APPENDIX_A6 = [
  {
    rule_id: "livestream_start_1h",
    event_type: "livestream",
    node_type: "start",
    lead_time_seconds: 3600,
  },
  {
    rule_id: "maintenance_start_1h",
    event_type: "maintenance",
    node_type: "start",
    lead_time_seconds: 3600,
  },
  {
    rule_id: "limited_start_1h",
    event_type: "limited_event",
    node_type: "start",
    lead_time_seconds: 3600,
  },
  {
    rule_id: "limited_end_1d",
    event_type: "limited_event",
    node_type: "end",
    lead_time_seconds: 86400,
  },
  { rule_id: "gacha_start_1h", event_type: "gacha", node_type: "start", lead_time_seconds: 3600 },
  { rule_id: "gacha_end_1d", event_type: "gacha", node_type: "end", lead_time_seconds: 86400 },
  {
    rule_id: "phase_unlock_1h",
    event_type: "limited_event",
    node_type: "phase_unlock",
    lead_time_seconds: 3600,
  },
  {
    rule_id: "reward_deadline_1d",
    event_type: "limited_event",
    node_type: "reward_deadline",
    lead_time_seconds: 86400,
  },
] as const;

describe("A-P1-CONTRACT 提醒规则注册表（主方案附录 A.6、前端 §6.2）", () => {
  it("注册表与附录 A.6 逐条一致，rule_id 唯一", () => {
    expect(REMINDER_RULES).toHaveLength(APPENDIX_A6.length);
    expect(RULE_IDS).toHaveLength(new Set(RULE_IDS).size);
    for (const expected of APPENDIX_A6) {
      const rule = getReminderRule(expected.rule_id);
      expect(rule).toBeDefined();
      expect(rule?.event_type).toBe(expected.event_type);
      expect(rule?.node_type).toBe(expected.node_type);
      expect(rule?.lead_time_seconds).toBe(expected.lead_time_seconds);
    }
  });

  it("每条规则的事件类型、节点类型都在合同枚举内；提前量只允许 1 小时 / 1 天", () => {
    for (const rule of REMINDER_RULES) {
      expect(EVENT_TYPES).toContain(rule.event_type);
      expect(NODE_TYPES).toContain(rule.node_type);
      expect([3600, 86400]).toContain(rule.lead_time_seconds);
    }
  });

  it("用户文案与注册表同源：每条规则都携带非空中文文案（前端 §6.2 映射）", () => {
    for (const rule of REMINDER_RULES) {
      expect(rule.user_copy_zh.length).toBeGreaterThan(0);
    }
    expect(getReminderRule("limited_end_1d")?.user_copy_zh).toBe("限时活动结束前 1 天");
    expect(getReminderRule("reward_deadline_1d")?.user_copy_zh).toBe("奖励领取截止前 1 天");
  });

  it("RuleIdSchema 拒绝任意脚本或自然语言表达式（主方案 §5.3）", () => {
    expect(RuleIdSchema.safeParse("livestream_start_1h").success).toBe(true);
    expect(RuleIdSchema.safeParse("提前十分钟").success).toBe(false);
    expect(RuleIdSchema.safeParse("start-1h").success).toBe(false);
    expect(RuleIdSchema.safeParse("cron(0 0 * * *)").success).toBe(false);
    expect(getReminderRule("made_up_rule")).toBeUndefined();
  });

  it("ruleEventTypes 汇总规则所涉事件类型；未知 id 被跳过（由 schema 层拒绝）", () => {
    expect([...ruleEventTypes(["gacha_start_1h", "gacha_end_1d"])]).toEqual(["gacha"]);
    expect([...ruleEventTypes(["limited_start_1h", "livestream_start_1h"])]).toEqual([
      "limited_event",
      "livestream",
    ]);
    expect(ruleEventTypes([]).size).toBe(0);
    expect(ruleEventTypes(["nope"]).size).toBe(0);
  });
});
