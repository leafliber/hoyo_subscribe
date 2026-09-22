import { describe, expect, it } from "vitest";
import {
  type ChangeNotificationScopeSource,
  changeNotificationScope,
  isWithinChangeNotificationScope,
} from "./notification-scope";

function source(
  overrides: Partial<ChangeNotificationScopeSource> = {},
): ChangeNotificationScopeSource {
  return {
    scope: { games: ["genshin", "hsr"], regions: ["CN"] },
    calendar: { event_types: ["livestream", "maintenance", "limited_event"] },
    notifications: { rule_ids: ["limited_end_1d"] },
    ...overrides,
  };
}

describe("A-P1-CONTRACT 变更通知范围（主方案 §5.3、CONTRACTS_BASELINE §4）", () => {
  it("范围 = scope ∩ (calendar.event_types ∪ rule_ids 所涉事件类型)", () => {
    const resolved = changeNotificationScope(source());
    // limited_event 同时来自 event_types 与规则；gacha 只来自规则
    expect(resolved.event_types.has("limited_event")).toBe(true);
    expect(resolved.event_types.has("gacha")).toBe(false);
    expect([...resolved.event_types].sort()).toEqual([
      "limited_event",
      "livestream",
      "maintenance",
    ]);

    const gachaViaRule = changeNotificationScope(
      source({ notifications: { rule_ids: ["gacha_start_1h", "gacha_end_1d"] } }),
    );
    expect(gachaViaRule.event_types.has("gacha")).toBe(true);

    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "genshin",
        region: "CN",
        event_type: "livestream",
      }),
    ).toBe(true);
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "zzz",
        region: "CN",
        event_type: "livestream",
      }),
    ).toBe(false);
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "genshin",
        region: "CN",
        event_type: "gacha",
      }),
    ).toBe(false);
    expect(
      isWithinChangeNotificationScope(gachaViaRule, {
        game: "genshin",
        region: "CN",
        event_type: "gacha",
      }),
    ).toBe(true);
  });

  it("只选了提醒规则、没把类型放进日历显示的用户不漏取消（并集的意义）", () => {
    const resolved = changeNotificationScope(
      source({
        calendar: { event_types: [] },
        notifications: { rule_ids: ["gacha_end_1d"] },
      }),
    );
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "hsr",
        region: "CN",
        event_type: "gacha",
      }),
    ).toBe(true);
  });

  it("不与 calendar.node_types 相交：节点可见性不参与变更范围（禁止清单：隐式三重筛选）", () => {
    // 该配置面根本不携带 node_types——若实现隐式依赖 node_types，这里就会暴露。
    const resolved = changeNotificationScope(
      source({
        scope: { games: ["genshin"], regions: ["CN"] },
        calendar: { event_types: ["limited_event"] },
        notifications: { rule_ids: [] },
      }),
    );
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "genshin",
        region: "CN",
        event_type: "limited_event",
      }),
    ).toBe(true);
  });

  it("rule_ids 为空是合法输入：范围退化为 scope ∩ calendar.event_types", () => {
    const resolved = changeNotificationScope(source({ notifications: { rule_ids: [] } }));
    expect([...resolved.event_types].sort()).toEqual([
      "limited_event",
      "livestream",
      "maintenance",
    ]);
  });

  it("uninitialized 订阅（空 scope、空类型）得到空范围，不参与任何通知匹配（§4.4）", () => {
    const resolved = changeNotificationScope({
      scope: { games: [], regions: [] },
      calendar: { event_types: [] },
      notifications: { rule_ids: [] },
    });
    expect(resolved.games.size).toBe(0);
    expect(resolved.regions.size).toBe(0);
    expect(resolved.event_types.size).toBe(0);
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "genshin",
        region: "CN",
        event_type: "livestream",
      }),
    ).toBe(false);
  });

  it("region 也受 scope 限制", () => {
    const resolved = changeNotificationScope(
      source({ scope: { games: ["genshin"], regions: [] } }),
    );
    expect(
      isWithinChangeNotificationScope(resolved, {
        game: "genshin",
        region: "CN",
        event_type: "livestream",
      }),
    ).toBe(false);
  });
});
