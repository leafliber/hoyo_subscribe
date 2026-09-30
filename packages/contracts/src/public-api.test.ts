import { describe, expect, it } from "vitest";
import { PUBLIC_CACHE_FRESH } from "./params/registry";
import {
  PublicCapabilitySchema,
  PublicEventsResponseSchema,
  publicCache,
  publicEvidence,
  publicImportantNode,
  publicNode,
  publicNodeInWindow,
  publicSourceStatus,
} from "./public-api";
import type { PublicSnapshotNode } from "./public-calendar";
import { browseWindow } from "./schedule-browse";
import { TimeValueSchema } from "./time";

const now = Date.parse("2026-09-30T12:00:00+08:00");
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

  it("日期不补午夜、未知时间保持待定、all 也从今日起", () => {
    const output = publicNode(node);
    expect(output.time.precision).toBe("date");
    expect(output.time).not.toHaveProperty("utc_ms");
    expect(publicNodeInWindow(node, "today", now)).toBe(true);
    const yesterday = structuredClone(node);
    yesterday.projection.milestone.time = TimeValueSchema.parse({
      ...node.projection.milestone.time,
      date: "2026-09-29",
    });
    expect(publicNodeInWindow(yesterday, "all", now)).toBe(false);
    const unknown = structuredClone(node);
    unknown.projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      raw_expression: "延期另行公布",
      source_timezone: "UTC+8",
      time_basis: "unresolved",
    });
    expect(publicNodeInWindow(unknown, "today", now)).toBe(true);
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
        source_id: "miyoushe",
        verification_state: "maintenance-required-list-only",
      }),
    ).toMatchObject({
      sourceId: "miyoushe",
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
      window: { start: browseWindow("today", now).start, end: null },
      nodes: [publicNode(node)],
      recentChanges: [],
      recentChangesTruncated: false,
      nextCursor: null,
    };
    expect(PublicEventsResponseSchema.safeParse(body).success).toBe(true);
    expect(PublicEventsResponseSchema.safeParse({ ...body, token: "synthetic" }).success).toBe(
      false,
    );
  });
});
