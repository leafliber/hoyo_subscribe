import { describe, expect, it } from "vitest";
import {
  type CalendarCandidateNode,
  type CalendarProjectionSource,
  effectiveCalendarNodes,
} from "./calendar-nodes";

function config(overrides: Partial<CalendarProjectionSource> = {}): CalendarProjectionSource {
  return {
    scope: { games: ["genshin", "hsr"], regions: ["CN"] },
    calendar: {
      event_types: ["livestream", "maintenance", "limited_event"],
      node_types: ["start", "end", "reward_deadline"],
      alarms_enabled: true,
    },
    notifications: { rule_ids: ["livestream_start_1h", "limited_end_1d"] },
    ...overrides,
  };
}

interface TestNode extends CalendarCandidateNode {
  readonly id: string;
}

function node(
  id: string,
  event_type: CalendarCandidateNode["event_type"],
  node_type: CalendarCandidateNode["node_type"],
  game: CalendarCandidateNode["game"] = "genshin",
): TestNode {
  return { id, game, region: "CN", event_type, node_type };
}

describe("A-P1-CONTRACT 日历有效节点（主方案 §5.2、前端 §6.5 同一投影语义）", () => {
  it("基础可见节点全部入选，原因记 base；不在任何选择里的节点被排除", () => {
    const candidates = [
      node("ls-start", "livestream", "start"), // 基础可见（也在规则里）
      node("lim-start", "limited_event", "start"), // 基础可见
      node("lim-end", "limited_event", "end"), // 基础可见
      node("maint-start", "maintenance", "start"), // 基础可见
      node("gacha-end", "gacha", "end"), // 未选类型、未选规则 → 排除
    ];
    const result = effectiveCalendarNodes(config(), candidates);
    expect(result.map((entry) => entry.node.id)).toEqual([
      "ls-start",
      "lim-start",
      "lim-end",
      "maint-start",
    ]);
    for (const entry of result) {
      expect(entry.reason).toEqual({ kind: "base" });
    }
  });

  it("U07：隐藏结束节点（node_types 不含 end）但选了结束提醒 → 以提醒关联节点出现", () => {
    const candidates = [node("lim-end", "limited_event", "end")];
    const result = effectiveCalendarNodes(
      config({
        calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
      }),
      candidates,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toEqual({
      kind: "reminder_associated",
      rule_ids: ["limited_end_1d"],
    });
    expect(result[0]?.node.id).toBe("lim-end");
  });

  it("U08：隐藏整个事件类型（event_types 不含 gacha）但选了该类型提醒 → 以提醒关联节点出现", () => {
    const candidates = [node("gacha-start", "gacha", "start"), node("gacha-end", "gacha", "end")];
    const result = effectiveCalendarNodes(
      config({
        calendar: { event_types: ["livestream"], node_types: ["start"], alarms_enabled: true },
        notifications: { rule_ids: ["gacha_start_1h", "gacha_end_1d"] },
      }),
      candidates,
    );
    expect(result.map((entry) => entry.node.id)).toEqual(["gacha-start", "gacha-end"]);
    expect(result[0]?.reason).toEqual({
      kind: "reminder_associated",
      rule_ids: ["gacha_start_1h"],
    });
    expect(result[1]?.reason).toEqual({ kind: "reminder_associated", rule_ids: ["gacha_end_1d"] });
  });

  it("提醒资格不与 node_types 隐式相交：node_types 为空数组时规则节点仍然入选", () => {
    const candidates = [node("lim-end", "limited_event", "end")];
    const result = effectiveCalendarNodes(
      config({
        calendar: { event_types: ["limited_event"], node_types: [], alarms_enabled: true },
      }),
      candidates,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.reason.kind).toBe("reminder_associated");
  });

  it("关闭日历提醒只保留基础可见节点（前端 §6.3：不移除基础显示）", () => {
    const candidates = [
      node("lim-end", "limited_event", "end"),
      node("gacha-start", "gacha", "start"),
      node("lim-start", "limited_event", "start"),
    ];
    const result = effectiveCalendarNodes(
      config({
        calendar: {
          event_types: ["livestream", "maintenance", "limited_event"],
          node_types: ["start", "end", "reward_deadline"],
          alarms_enabled: false,
        },
        notifications: { rule_ids: ["gacha_start_1h", "limited_end_1d"] },
      }),
      candidates,
    );
    // lim-end 基础可见（node_types 含 end）→ 保留；gacha-start 只能经规则引入 → 排除。
    expect(result.map((entry) => entry.node.id)).toEqual(["lim-end", "lim-start"]);
    expect(result[0]?.reason).toEqual({ kind: "base" });
  });

  it("scope 外的游戏/区域整条排除：规则选了也不引入（§5.2 均受 scope 约束）", () => {
    const candidates = [
      node("zzz-gacha", "gacha", "start", "zzz"),
      node("hsr-lim", "limited_event", "end", "hsr"),
      node("genshin-lim", "limited_event", "end", "genshin"),
    ];
    const result = effectiveCalendarNodes(
      config({ scope: { games: ["genshin"], regions: ["CN"] } }),
      candidates,
    );
    expect(result.map((entry) => entry.node.id)).toEqual(["genshin-lim"]);
  });

  it("rule_ids 为空：只有基础可见节点，无提醒关联", () => {
    const candidates = [node("lim-end", "limited_event", "end")];
    const result = effectiveCalendarNodes(
      config({
        calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
        notifications: { rule_ids: [] },
      }),
      candidates,
    );
    expect(result).toHaveLength(0);
  });

  it("同一节点既基础可见又被规则需要时只输出一次，原因记 base", () => {
    const candidates = [node("ls-start", "livestream", "start")];
    const result = effectiveCalendarNodes(config(), candidates);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toEqual({ kind: "base" });
  });
});
