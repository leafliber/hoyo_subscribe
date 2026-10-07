import { describe, expect, it } from "vitest";
import {
  calendarEntryLabel,
  calendarEntryText,
  calendarEntryTitle,
  calendarTimeText,
  eventDetailUrl,
} from "./calendar-entry";
import type { PersonalCalendarNode } from "./personal-calendar";
import type { PublicSnapshotNode } from "./public-calendar";
import { TimeValueSchema } from "./time";

const ORIGIN = "https://hoyo.example";
const at = (iso: string) => Date.parse(iso);
function item(overrides: {
  eventType?: PublicSnapshotNode["projection"]["event"]["event_type"];
  nodeType?: PublicSnapshotNode["projection"]["milestone"]["node_type"];
  title?: string;
  milestoneTitle?: string;
  status?: PublicSnapshotNode["projection"]["event"]["status"];
  summary?: string | null;
  time?: unknown;
  patch?: PublicSnapshotNode["patch"];
  activePatch?: boolean;
}): PersonalCalendarNode {
  const time = TimeValueSchema.parse(
    overrides.time ?? {
      precision: "datetime",
      utc_ms: at("2026-10-13T09:59:00Z"),
      source_timezone: "UTC+08:00",
      raw_expression: "2026/10/13 17:59",
      time_basis: "official_explicit",
    },
  );
  const node: PublicSnapshotNode = {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    patch: overrides.patch ?? null,
    source_projection_json: null,
    tombstone: false,
    projection: {
      event_id: "evt/合成 1",
      milestone_id: "ms",
      event: {
        event_type: overrides.eventType ?? "gacha",
        status: overrides.status ?? "scheduled",
        title: overrides.title ?? "「涌浪叙歌」祈愿",
        summary: overrides.summary ?? null,
        official_url:
          "https://hk4e-ann-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent",
        human_locked: false,
      },
      milestone: {
        milestone_key: "end",
        node_type: overrides.nodeType ?? "end",
        title: overrides.milestoneTitle ?? "「涌浪叙歌」祈愿",
        time,
        human_locked: false,
      },
    },
  };
  if (time.precision === "unknown") throw new Error("日历条目不会是未知时间");
  return {
    node,
    time,
    cancelled: false,
    alarm_seconds: [],
    base: true,
    patch: overrides.activePatch ?? false,
  };
}

describe("ADR-0031 日历条目给人看的文字", () => {
  it("开始与结束两条的标题不再相同：写节点动作；链接是本站活动详情页，不是官方取材接口", () => {
    const end = calendarEntryText(item({}), ORIGIN);
    const start = calendarEntryText(item({ nodeType: "start" }), ORIGIN);
    expect(end.summary).toBe("「涌浪叙歌」祈愿 · 卡池结束");
    expect(start.summary).toBe("「涌浪叙歌」祈愿 · 卡池开启");
    expect(end.url).toBe("https://hoyo.example/events/evt%2F%E5%90%88%E6%88%90%201");
    expect(end.url).toBe(eventDetailUrl(ORIGIN, "evt/合成 1"));
    expect(end.description).toBe(
      [
        "原神 · 卡池 · 卡池结束",
        "时间：2026年10月13日 周二 17:59（北京时间）",
        "官方原文：2026/10/13 17:59",
        `详情与官方公告原文：${end.url}`,
        "时间与安排以官方公告为准。",
      ].join("\n"),
    );
    expect(end.description).not.toContain("getAnnContent");
  });

  it("确定性推导写明推导依据；只有日期的不编造时刻", () => {
    const text = calendarEntryText(
      item({
        nodeType: "start",
        time: {
          precision: "date",
          date: "2026-09-23",
          source_timezone: "UTC+08:00",
          raw_expression: "7.1版本更新后",
          time_basis: "deterministic_derived",
        },
      }),
      ORIGIN,
    );
    expect(text.description).toContain("时间：2026年9月23日 周三（具体时间未公布）");
    expect(text.description).toContain("官方原文：7.1版本更新后");
    expect(text.description).toContain("推导依据：取 7.1 版本更新开始当天（北京时间）");
  });

  it("官方预计标「预计」；取消、撤回、延期写状态；仍在保留期的更正写理由与原时间", () => {
    expect(
      calendarTimeText(
        TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: at("2026-10-13T09:59:00Z"),
          source_timezone: "UTC+08:00",
          raw_expression: "预计 17:59",
          time_basis: "official_estimate",
        }),
      ),
    ).toBe("预计 2026年10月13日 周二 17:59（北京时间）");
    expect(calendarEntryText(item({ status: "cancelled" }), ORIGIN).description).toContain(
      "状态：官方已取消",
    );
    expect(calendarEntryText(item({ status: "retracted" }), ORIGIN).description).toContain(
      "状态：本站撤回，此前收录有误",
    );
    const old = TimeValueSchema.parse({
      precision: "datetime",
      utc_ms: at("2026-10-10T09:59:00Z"),
      source_timezone: "UTC+08:00",
      raw_expression: "2026/10/10 17:59",
      time_basis: "official_explicit",
    });
    const patched = item({
      activePatch: true,
      patch: {
        kind: "rescheduled",
        fact_reason: "已公布新时间",
        extends_window: false,
        display_time: old,
        old_time: old,
        new_time: old,
        retain_until: at("2027-01-01T00:00:00Z"),
      },
    });
    expect(calendarEntryText(patched, ORIGIN).description).toContain(
      "更正：已公布新时间（原时间 2026年10月10日 周六 17:59（北京时间））",
    );
    // 更正过了保留期（patch 标记为 false）就不再写理由。
    expect(calendarEntryText({ ...patched, patch: false }, ORIGIN).description).not.toContain(
      "更正",
    );
  });

  it("阶段解锁用节点自己的标题（去掉重复的活动名）；兑换码事件的简介进描述", () => {
    expect(
      calendarEntryLabel({
        eventTitle: "「巡游拾光」",
        milestoneTitle: "「巡游拾光」第二阶段开放",
        eventType: "limited_event",
        nodeType: "phase_unlock",
      }),
    ).toBe("第二阶段开放");
    expect(
      calendarEntryTitle({
        eventTitle: "「巡游拾光」",
        milestoneTitle: "「巡游拾光」",
        eventType: "limited_event",
        nodeType: "phase_unlock",
      }),
    ).toBe("「巡游拾光」 · 阶段解锁");
    const code = calendarEntryText(
      item({
        eventType: "redeem_code",
        nodeType: "start",
        title: "合成前瞻特别节目兑换码",
        milestoneTitle: "兑换码发放",
        summary: "兑换码：ABC123、DEF456",
      }),
      ORIGIN,
    );
    expect(code.summary).toBe("合成前瞻特别节目兑换码 · 兑换码发放");
    expect(code.description).toContain("原神 · 兑换码 · 兑换码发放");
    expect(code.description).toContain("说明：兑换码：ABC123、DEF456");
  });
});
