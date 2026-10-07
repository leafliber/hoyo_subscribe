import { describe, expect, it } from "vitest";
import { PUBLIC_CACHE_FRESH } from "./params/registry";
import {
  isPublicChange,
  PublicCapabilitySchema,
  PublicEventsResponseSchema,
  publicCache,
  publicEvidence,
  publicImportantNode,
  publicNode,
  publicNodeInWindow,
  publicSourceStatus,
} from "./public-api";
import {
  decideCalendarPatch,
  type PatchDecision,
  type PublicSnapshotNode,
} from "./public-calendar";
import { BROWSE_RANGES, browseDate, browseWindow } from "./schedule-browse";
import { TimeValueSchema } from "./time";

const now = Date.parse("2026-09-30T12:00:00+08:00");
function must<T>(value: T | null): T {
  if (value === null) throw new Error("missing test fixture");
  return value;
}
type Mutable<T> = T extends string | number | boolean | null
  ? T
  : { -readonly [P in keyof T]: Mutable<T[P]> };
const node: Mutable<PublicSnapshotNode> = {
  game: "genshin",
  region: "CN",
  public_ical_revision: 1,
  patch: null,
  source_projection_json: null,
  tombstone: false,
  projection: {
    event_id: "event",
    milestone_id: "node",
    event: {
      event_type: "limited_event",
      status: "scheduled",
      title: "公开活动",
      summary: null,
      official_url: null,
      human_locked: false,
    },
    milestone: {
      milestone_key: "end",
      node_type: "end",
      title: "结束",
      human_locked: false,
      time: TimeValueSchema.parse({
        precision: "date",
        date: "2026-09-30",
        source_timezone: "UTC+8",
        raw_expression: "当日结束，时刻待公布",
        time_basis: "official_explicit",
      }),
    },
  },
};
describe("A-P3-PUBLIC 公共读唯一纯函数", () => {
  it("公开证据只取逐字段匹配的已批准片段，状态与时间不匹配时拒绝", () => {
    const proposal = {
      events: [
        {
          title: node.projection.event.title,
          event_type: "limited_event",
          status: "scheduled",
          status_evidence: { quote: "官方公开状态依据" },
          milestones: [
            {
              milestone_key: "end",
              node_type: "end",
              time: node.projection.milestone.time,
              time_evidence: { quote: "已核验的时间证据片段" },
            },
          ],
        },
      ],
    };
    expect(publicEvidence(node, proposal)).toEqual({
      node: "已核验的时间证据片段",
      change: "官方公开状态依据",
    });
    expect(publicEvidence(node, { events: [{ ...proposal.events[0], milestones: [] }] })).toEqual({
      node: node.projection.milestone.time.raw_expression,
      change: "官方公开状态依据",
    });
    expect(publicEvidence(node, { events: [] })).toBeNull();
    expect(
      publicEvidence(node, { events: [{ ...proposal.events[0], status: "cancelled" }] }),
    ).toBeNull();
  });

  it("证据时间不匹配本代时不采用该片段", () => {
    const proposal = {
      events: [
        {
          title: node.projection.event.title,
          event_type: node.projection.event.event_type,
          status: node.projection.event.status,
          status_evidence: null,
          milestones: [
            {
              ...node.projection.milestone,
              time: { ...node.projection.milestone.time, date: "2026-10-01" },
              time_evidence: { quote: "其他日期的片段" },
            },
          ],
        },
      ],
    };
    expect(publicEvidence(node, proposal)).toBeNull();
    expect(publicNode(node, null, publicEvidence(node, proposal)).evidence).toBe(
      node.projection.milestone.time.raw_expression,
    );
  });

  it("日期不补午夜、未知时间保持待定、all 附带昨天", () => {
    const output = publicNode(node);
    expect(output.time.precision).toBe("date");
    expect(output.time).not.toHaveProperty("utc_ms");
    expect(publicNodeInWindow(node, "today", now)).toBe(true);
    const yesterday = structuredClone(node);
    yesterday.projection.milestone.time = TimeValueSchema.parse({
      ...node.projection.milestone.time,
      date: "2026-09-29",
    });
    expect(publicNodeInWindow(yesterday, "all", now)).toBe(true);
    const unknown = structuredClone(node);
    unknown.projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      raw_expression: "延期另行公布",
      source_timezone: "UTC+8",
      time_basis: "unresolved",
    });
    expect(publicNodeInWindow(unknown, "today", now)).toBe(true);
  });
  it.each(BROWSE_RANGES)("P3-16 $id 附带 UTC+8 昨天，保留原窗口与未知时间边界", ({ id }) => {
    const window = browseWindow(id, now);
    const sample = structuredClone(node);
    for (const [utc_ms, expected] of [
      [window.yesterday - 1, false],
      [window.yesterday, true],
      [window.start - 1, true],
      [window.start, true],
      ...(window.end === null
        ? []
        : [
            [window.end - 1, true],
            [window.end, false],
          ]),
    ] as [number, boolean][]) {
      sample.projection.milestone.time = TimeValueSchema.parse({
        precision: "datetime",
        utc_ms,
        source_timezone: "UTC+8",
        raw_expression: "合成边界时刻",
        time_basis: "official_explicit",
      });
      expect(publicNodeInWindow(sample, id, now), String(utc_ms)).toBe(expected);
    }
    for (const [date, expected] of [
      ["2026-09-28", false],
      ["2026-09-29", true],
      ["2026-09-30", true],
      ...(window.end === null ? [] : [[browseDate(window.end), false]]),
    ] as [string, boolean][]) {
      sample.projection.milestone.time = TimeValueSchema.parse({
        ...node.projection.milestone.time,
        date,
      });
      expect(publicNodeInWindow(sample, id, now), date).toBe(expected);
    }
    sample.projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      source_timezone: "UTC+8",
      raw_expression: "时间待定",
      time_basis: "unresolved",
    });
    expect(publicNodeInWindow(sample, id, now)).toBe(true);
    sample.tombstone = true;
    expect(publicNodeInWindow(sample, id, now)).toBe(false);
    sample.projection.milestone.time = TimeValueSchema.parse({
      ...node.projection.milestone.time,
      date: "2026-09-29",
    });
    expect(publicNodeInWindow(sample, id, now)).toBe(false);
  });
  it("改期/取消/撤回/待定保留历史，删除不冒充官方取消", () => {
    for (const kind of [
      "rescheduled",
      "cancelled",
      "retracted",
      "postponed_unknown",
      "deleted",
    ] as const) {
      const changed = structuredClone(node);
      changed.patch = {
        kind,
        fact_reason: kind,
        display_time: node.projection.milestone.time,
        old_time: node.projection.milestone.time,
        new_time: null,
        retain_until: now + 1,
        extends_window: true,
      };
      const input = { ...changed, tombstone: kind === "deleted" };
      expect(publicNode(input).change?.historicalTime).toEqual(node.projection.milestone.time);
      expect(publicNode(input).change?.kind).toBe(kind === "postponed_unknown" ? "pending" : kind);
      if (kind === "deleted") {
        expect(publicNode(input).status).toBe("retracted");
        expect(publicNodeInWindow(input, "all", now)).toBe(false);
      }
    }
  });
  it("ADR-0028 待定第一次得到时间不算改期；有旧时间的改期、延期后公布新时间照常公开", () => {
    const at = (time: Record<string, unknown>) => {
      const projection = structuredClone(node.projection);
      projection.milestone.time = TimeValueSchema.parse({
        source_timezone: "UTC+8",
        time_basis: "deterministic_derived",
        ...time,
      });
      return projection;
    };
    const unknown = at({ precision: "unknown", raw_expression: "10月09日 19:30" });
    const derived = at({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-09T19:30:00+08:00"),
      raw_expression: "10月09日 19:30",
    });
    const moved = at({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-10T19:30:00+08:00"),
      raw_expression: "10月10日 19:30",
    });
    const show = (patch: PatchDecision | null) =>
      publicNode({ ...structuredClone(node), patch }).change;

    const firstTime = must(decideCalendarPatch(unknown, derived, null, now));
    expect(firstTime).toMatchObject({ kind: "rescheduled", old_time: null });
    expect(isPublicChange(firstTime)).toBe(false);
    expect(show(firstTime)).toBeNull();

    const real = must(decideCalendarPatch(derived, moved, null, now));
    expect(isPublicChange(real)).toBe(true);
    expect(show(real)?.historicalTime).toEqual(derived.milestone.time);

    // 延期待定后公布新时间：当前旧时间未知，但累计水位保留了曾公开的原时间。
    const postponedProjection = structuredClone(unknown);
    postponedProjection.event.status = "postponed";
    const postponed = must(decideCalendarPatch(derived, postponedProjection, null, now));
    expect(postponed.kind).toBe("postponed_unknown");
    const announced = must(decideCalendarPatch(postponedProjection, moved, postponed, now));
    expect(announced).toMatchObject({ kind: "rescheduled", old_time: derived.milestone.time });
    expect(show(announced)?.kind).toBe("rescheduled");

    // 其余种类即使没有旧时间也照常公开。
    for (const kind of ["restored", "classification_corrected"] as const)
      expect(isPublicChange({ ...firstTime, kind })).toBe(true);
  });
  it("响应副本从生成时起新鲜，旧代次和无代次不把源站响应标陈旧", () => {
    for (const publication of [null, { generation: 1, publishedAt: now - 86400000 }]) {
      expect(publicCache(publication, now)).toEqual({
        generatedAt: now,
        freshUntil: now + PUBLIC_CACHE_FRESH * 1000,
        stale: false,
      });
    }
  });
  it("逐来源映射，不把 list-only 合成整个游戏不可用", () => {
    const source = {
      source_id: "official",
      last_success_at: now,
      verification_state: "verified-working",
    };
    expect(publicSourceStatus("genshin", source)).toMatchObject({
      sourceId: "official",
      verificationState: "verified",
      verifiedAt: now,
      degradationReasons: [],
    });
    expect(
      publicSourceStatus("genshin", {
        ...source,
        source_id: "list-only",
        verification_state: "maintenance-required-list-only",
      }),
    ).toMatchObject({
      sourceId: "list-only",
      verificationState: "verified",
      degradationReasons: ["content_unavailable"],
    });
    expect(
      publicSourceStatus("genshin", { ...source, verification_state: "maintenance-required" })
        .verificationState,
    ).toBe("unavailable");
    expect(
      publicSourceStatus("genshin", { ...source, last_success_at: null }).verificationState,
    ).toBe("unknown");
    expect(
      publicSourceStatus("genshin", {
        ...source,
        last_success_at: null,
        verification_state: "maintenance-required",
      }).verificationState,
    ).toBe("unknown");
    expect(
      publicSourceStatus("genshin", { ...source, verification_state: "unverified" })
        .verificationState,
    ).toBe("unknown");
    expect(
      publicSourceStatus("genshin", {
        ...source,
        last_success_at: null,
        verification_state: "maintenance-required-list-only",
      }),
    ).toMatchObject({
      verificationState: "unknown",
      degradationReasons: ["content_unavailable", "not_verified"],
    });
  });
  it("能力合同接受 open / closed / unknown 三态", () => {
    for (const value of ["open", "closed", "unknown"])
      expect(PublicCapabilitySchema.parse(value)).toBe(value);
    expect(PublicCapabilitySchema.safeParse(true).success).toBe(false);
  });
  it("无确切当前安排不虚构重要节点，响应严格拒绝秘密字段", () => {
    expect(publicImportantNode([{ ...publicNode(node), status: "cancelled" }], now)).toBeNull();
    const body = {
      publication: { generation: 1, publishedAt: now },
      cache: publicCache({ generation: 1, publishedAt: now }, now),
      window: browseWindow("today", now),
      nodes: [publicNode(node)],
      recentChanges: [],
      recentChangesTruncated: false,
      nextCursor: null,
    };
    expect(PublicEventsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.window.yesterday).toBe(Date.parse("2026-09-29T00:00:00+08:00"));
    expect(
      PublicEventsResponseSchema.safeParse({
        ...body,
        window: { start: body.window.start, end: body.window.end },
      }).success,
    ).toBe(false);
    expect(PublicEventsResponseSchema.safeParse({ ...body, token: "synthetic" }).success).toBe(
      false,
    );
  });
});
