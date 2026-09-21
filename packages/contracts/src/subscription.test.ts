import { describe, expect, it } from "vitest";
import type { SubscriptionConfig } from "./subscription";
import { parseSubscriptionConfig, subscriptionConfigSchemaFor } from "./subscription";

// 主方案 §5.1 的结构示例（初值见附录 A.1，此处只验证结构合同）。
const VALID_CONFIG = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin", "hsr"], regions: ["CN"] },
  calendar: {
    event_types: ["livestream", "maintenance", "limited_event"],
    node_types: ["start", "end", "reward_deadline"],
    alarms_enabled: true,
  },
  notifications: {
    rule_ids: ["livestream_start_1h", "limited_end_1d"],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  },
} as const;

const EMPTY_CONFIG = {
  schema_version: 3,
  revision: 1,
  scope: { games: [], regions: [] },
  calendar: { event_types: [], node_types: [], alarms_enabled: false },
  notifications: {
    rule_ids: [],
    new_event: false,
    important_change: false,
    cancelled_or_retracted: false,
    late_discovery: false,
  },
} as const;

describe("A-P1-CONTRACT 订阅配置 schema_version 3（主方案 §5.1、§4.4）", () => {
  it("解析 §5.1 结构示例；数组去重并排序为规范化形态", () => {
    const result = parseSubscriptionConfig("initialized", VALID_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope.games).toEqual(["genshin", "hsr"]);
      expect(result.data.notifications.rule_ids).toEqual(["limited_end_1d", "livestream_start_1h"]);
    }
    const messy = {
      ...VALID_CONFIG,
      scope: { games: ["zzz", "genshin", "zzz"], regions: ["CN", "CN"] },
      calendar: {
        ...VALID_CONFIG.calendar,
        event_types: ["gacha", "livestream", "gacha"],
      },
    };
    const normalized = parseSubscriptionConfig("initialized", messy);
    expect(normalized.success).toBe(true);
    if (normalized.success) {
      expect(normalized.data.scope.games).toEqual(["genshin", "zzz"]);
      expect(normalized.data.scope.regions).toEqual(["CN"]);
      expect(normalized.data.calendar.event_types).toEqual(["gacha", "livestream"]);
    }
  });

  it("拒绝未知键与额外层级（strictObject 贯穿全部嵌套）", () => {
    const unknowns: unknown[] = [
      { ...VALID_CONFIG, extra_top: 1 },
      { ...VALID_CONFIG, scope: { ...VALID_CONFIG.scope, extra: 1 } },
      { ...VALID_CONFIG, calendar: { ...VALID_CONFIG.calendar, extra: 1 } },
      { ...VALID_CONFIG, notifications: { ...VALID_CONFIG.notifications, extra: 1 } },
      { ...VALID_CONFIG, email_channels: { enabled: true } },
    ];
    for (const input of unknowns) {
      expect(parseSubscriptionConfig("initialized", input).success).toBe(false);
      expect(parseSubscriptionConfig("uninitialized", input).success).toBe(false);
    }
  });

  it("schema_version 只接受字面量 3；未知枚举值被拒绝", () => {
    expect(
      parseSubscriptionConfig("initialized", { ...VALID_CONFIG, schema_version: 2 }).success,
    ).toBe(false);
    expect(
      parseSubscriptionConfig("initialized", { ...VALID_CONFIG, schema_version: "3" }).success,
    ).toBe(false);
    expect(
      parseSubscriptionConfig("initialized", {
        ...VALID_CONFIG,
        scope: { games: ["pokecoin"], regions: ["CN"] },
      }).success,
    ).toBe(false);
    expect(
      parseSubscriptionConfig("initialized", {
        ...VALID_CONFIG,
        calendar: { ...VALID_CONFIG.calendar, event_types: ["concert"] },
      }).success,
    ).toBe(false);
    expect(
      parseSubscriptionConfig("initialized", {
        ...VALID_CONFIG,
        notifications: { ...VALID_CONFIG.notifications, rule_ids: ["任意规则"] },
      }).success,
    ).toBe(false);
  });

  it("rule_ids 允许为空数组：只要变更消息不要提前提醒是合法配置（§5.3）", () => {
    const noRules = {
      ...VALID_CONFIG,
      notifications: {
        rule_ids: [],
        new_event: true,
        important_change: true,
        cancelled_or_retracted: true,
        late_discovery: true,
      },
    };
    for (const state of ["uninitialized", "initialized"] as const) {
      const result = parseSubscriptionConfig(state, noRules);
      expect(result.success).toBe(true);
    }
  });

  it("uninitialized 放行空 scope 与空 calendar.event_types（§4.4：不写入任何默认值）", () => {
    const result = parseSubscriptionConfig("uninitialized", EMPTY_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      const config: SubscriptionConfig = result.data;
      expect(config.scope.games).toEqual([]);
      expect(config.calendar.event_types).toEqual([]);
    }
  });

  it("initialized 时空 scope / 空 calendar.event_types 被拒绝并指明字段", () => {
    const result = parseSubscriptionConfig("initialized", EMPTY_CONFIG);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("scope.games");
      expect(paths).toContain("scope.regions");
      expect(paths).toContain("calendar.event_types");
      // node_types 无非空约束（§5.1 只约束 scope 与 event_types）
      expect(paths).not.toContain("calendar.node_types");
    }
  });

  it("subscriptionConfigSchemaFor 按状态返回同一结构合同", () => {
    expect(subscriptionConfigSchemaFor("uninitialized").safeParse(VALID_CONFIG).success).toBe(true);
    expect(subscriptionConfigSchemaFor("initialized").safeParse(VALID_CONFIG).success).toBe(true);
  });

  it("revision 必须是 ≥1 的整数", () => {
    expect(parseSubscriptionConfig("initialized", { ...VALID_CONFIG, revision: 0 }).success).toBe(
      false,
    );
    expect(parseSubscriptionConfig("initialized", { ...VALID_CONFIG, revision: 1.5 }).success).toBe(
      false,
    );
    expect(parseSubscriptionConfig("initialized", { ...VALID_CONFIG, revision: "1" }).success).toBe(
      false,
    );
  });
});
