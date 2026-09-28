/** 隔离 synthetic 数据。所有名称、时间、来源状态仅为交互验收样例，不代表官方安排。 */

import type {
  EventStatus,
  EventType,
  GameId,
  ScheduleNode,
  ScheduleSnapshot,
  TimeValue,
} from "@hoyo/contracts";
import {
  browseDate,
  browseWindow,
  DateOnlySchema,
  ExactTimeSchema,
  SUPPORTED_SCOPE_GAMES,
} from "@hoyo/contracts";
export const DEMO_SCENARIOS = [
  ["normal", "日程列表"],
  ["quiet", "平静期"],
  ["source", "来源异常"],
  ["review", "待审核缺口"],
  ["stale", "陈旧缓存"],
  ["load", "加载失败"],
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number][0];

/** F1-03 详情也只使用隔离样例；节点沿用 F1-02 的公开样例快照。 */
export interface DemoEvent {
  id: string;
  title: string;
  game: GameId;
  eventType: EventType;
  status: EventStatus;
  milestones: ScheduleNode[];
  importantNodeId: string;
  change?: ScheduleNode["change"];
  historicalTime?: TimeValue;
  official: {
    url: string;
    publisher: string;
    noticeText: string;
    publishedAt: number;
    updatedAt: number;
  };
}

export function demoEventIds(now: number): string[] {
  return ["sample", ...demoSnapshot(now, "normal").nodes.map((node) => node.id)];
}

export function demoEvent(now: number, id: string): DemoEvent | null {
  const snapshot = demoSnapshot(now, "normal");
  const node = snapshot.nodes.find((item) => item.id === (id === "sample" ? "later" : id));
  if (!node) return null;
  const { start } = browseWindow("today", now);
  const hour = 3_600_000;
  const milestones: ScheduleNode[] =
    id === "morning"
      ? [
          node,
          {
            ...node,
            id: "morning-end",
            nodeType: "end",
            time: {
              precision: "datetime",
              utc_ms: ExactTimeSchema.parse(start + 18 * hour),
              source_timezone: "UTC+8",
              raw_expression: "样例公告：当日18:00玩法结束",
              time_basis: "official_explicit",
            },
            evidence:
              'synthetic 证据片段：玩法于18:00结束。<img src=x onerror="window.__evidenceExecuted=1">',
          },
          {
            ...node,
            id: "morning-reward",
            nodeType: "reward_deadline",
            time: {
              precision: "datetime",
              utc_ms: ExactTimeSchema.parse(start + 36 * hour),
              source_timezone: "UTC+8",
              raw_expression: "样例公告：次日12:00奖励领取截止",
              time_basis: "official_explicit",
            },
            evidence: "synthetic 证据片段：玩法结束后仍可领取奖励，至次日12:00。",
          },
        ]
      : [node];
  const historicalTime: TimeValue | undefined =
    id === "rescheduled"
      ? {
          precision: "datetime",
          utc_ms: ExactTimeSchema.parse(start + 10 * hour),
          source_timezone: "UTC+8",
          raw_expression: "样例原定当日10:00",
          time_basis: "official_explicit",
        }
      : undefined;
  const noticeText =
    id === "morning"
      ? 'synthetic 公告原文样例：当日18:00玩法结束，次日12:00奖励领取截止。<img src=x onerror="window.__evidenceExecuted=1">'
      : id === "reward"
        ? "synthetic 公告原文样例：仅公布奖励领取截止，未公布玩法结束时间。"
        : id === "retract"
          ? "synthetic 原始公告样例：旧版维护安排。"
          : `synthetic 公告原文样例：${node.change?.explanation ?? node.time.raw_expression}`;
  return {
    id,
    title: node.title,
    game: node.game,
    eventType: node.eventType,
    status: node.status,
    milestones,
    importantNodeId: id === "morning" ? "morning-end" : node.id,
    change: node.change,
    historicalTime,
    official: {
      // 示例域名仅用于展示外链位置；与虚构日程不构成真实官方来源对应关系。
      url: "https://example.com/",
      publisher: "synthetic 演示公告",
      noticeText,
      publishedAt: node.noticePublishedAt,
      updatedAt: snapshot.publishedAt,
    },
  };
}
export function demoSnapshot(now: number, scenario: DemoScenario): ScheduleSnapshot {
  const { start, yesterday } = browseWindow("today", now);
  const hour = 3_600_000;
  const day = 24 * hour;
  const node = (
    id: string,
    title: string,
    offset: number,
    overrides: Partial<ScheduleNode> = {},
  ): ScheduleNode => ({
    id,
    title,
    game: "genshin",
    eventType: "limited_event",
    nodeType: "end",
    status: "scheduled",
    time: {
      precision: "datetime",
      utc_ms: ExactTimeSchema.parse(start + offset * hour),
      source_timezone: "UTC+8",
      raw_expression: "样例公告：按所列北京时间安排",
      time_basis: "official_explicit",
    },
    evidence: "synthetic 样例依据：演示公告中的已核验时间。",
    noticePublishedAt: yesterday + 10 * hour,
    ...overrides,
  });
  const nodes = [
    node("morning", "巡游拾光 · 城市探索挑战", 8, { nodeType: "start" }),
    node("reward", "星间漫游 · 旅程纪念奖励", 12, { game: "hsr", nodeType: "reward_deadline" }),
    node("end", "街角奇遇记 · 第三期委托", 18, { game: "zzz" }),
    node("phase", "巡游拾光 · 新的旅途", 34, { nodeType: "phase_unlock" }),
    node("long", "在群星与旅途的交汇处，收集每一段值得珍藏的回忆——特别限时活动与挑战任务", 44, {
      game: "hsr",
    }),
    node("derived", "流光回响 · 限定跃迁", 60, {
      game: "hsr",
      eventType: "gacha",
      time: {
        precision: "datetime",
        utc_ms: ExactTimeSchema.parse(start + 60 * hour),
        time_basis: "deterministic_derived",
        source_timezone: "UTC+8",
        raw_expression: "样例：第三日12时；由公告起始日确定推导",
      },
      evidence: "synthetic 推导依据：公告明确的起始日 + 第三日12时。",
    }),
    node("date", "漫游手记 · 领取纪念礼物", 0, {
      nodeType: "reward_deadline",
      time: {
        precision: "date",
        date: DateOnlySchema.parse(browseDate(start + day)),
        time_basis: "official_explicit",
        source_timezone: "UTC+8",
        raw_expression: "样例：明日，未公布具体时刻",
      },
    }),
    node("estimate", "新版本维护 · 预计完成", 59, {
      game: "zzz",
      eventType: "maintenance",
      nodeType: "expected_end",
      time: {
        precision: "datetime",
        utc_ms: ExactTimeSchema.parse(start + 59 * hour),
        time_basis: "official_estimate",
        source_timezone: "UTC+8",
        raw_expression: "样例：预计11时完成维护",
      },
      evidence: "synthetic 样例依据：维护公告的预计完成时间，不代表实际开服。",
    }),
    node("later", "下一站旅程 · 前瞻特别节目", 6 * 24 + 19, {
      eventType: "livestream",
      nodeType: "start",
    }),
    node("month", "新故事 · 阶段二", 15 * 24 + 10, { nodeType: "phase_unlock" }),
    node("old", "街区巡游 · 限时奖励", -4, { game: "zzz", nodeType: "reward_deadline" }),
    node("rescheduled", "巡游拾光 · 新的旅途", 34, {
      nodeType: "phase_unlock",
      change: {
        kind: "rescheduled",
        explanation: "样例改期：原定今日10:00（历史），调整至明日10:00。",
      },
    }),
    node("cancel", "特别放送 · 线下见面会", 19, {
      game: "hsr",
      eventType: "livestream",
      nodeType: "start",
      status: "cancelled",
      change: { kind: "cancelled", explanation: "样例公开依据：主办方公告取消本次安排。" },
    }),
    node("retract", "旧版维护安排", 20, {
      game: "zzz",
      eventType: "maintenance",
      nodeType: "start",
      status: "retracted",
      change: { kind: "retracted", explanation: "样例公开纠错：误将旧版本公告收录为当前安排。" },
    }),
    node("pending", "下一段旅程 · 特别节目", 0, {
      eventType: "livestream",
      nodeType: "start",
      status: "postponed",
      time: {
        precision: "unknown",
        source_timezone: "UTC+8",
        raw_expression: "样例：延期，时间另行公布",
        time_basis: "unresolved",
      },
      change: { kind: "pending", explanation: "样例公开依据：节目延期，新时间将另行公布。" },
    }),
  ];
  return {
    synthetic: true,
    capturedAt: yesterday + 20 * hour,
    publishedAt: yesterday + 19 * hour,
    generation: `synthetic-${browseDate(start)}`,
    nodes: ["quiet", "source", "review"].includes(scenario)
      ? nodes.filter((item) => item.id === "later" || item.id === "old")
      : nodes.filter((item) => item.id !== "phase"),
    sources: SUPPORTED_SCOPE_GAMES.map((game) => ({
      game,
      verifiedAt: yesterday + 18 * hour,
      unavailable: scenario === "source",
      reviewCount: scenario === "review" && game === "genshin" ? 2 : 0,
    })),
  };
}
