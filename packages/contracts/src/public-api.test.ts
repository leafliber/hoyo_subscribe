import { describe, expect, it } from "vitest";
import { PUBLIC_CACHE_FRESH } from "./params/registry";
import {
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
  it("数据新鲜期按发布时间，不因重读续命；截止时刻即陈旧", () => {
    const publication = { generation: 1, publishedAt: now };
    const at = now + PUBLIC_CACHE_FRESH * 1000;
    expect(publicCache(publication, at - 1).stale).toBe(false);
    expect(publicCache(publication, at)).toEqual({ generatedAt: at, freshUntil: at, stale: true });
    expect(publicCache(null, now).stale).toBe(true);
  });
  it("缺来源不声称正常，按游戏聚合保留已核验水位", () => {
    expect(publicSourceStatus("genshin", [], 2)).toMatchObject({
      verificationState: "unknown",
      verifiedAt: null,
      reviewCount: 2,
    });
    expect(
      publicSourceStatus(
        "hsr",
        [
          { last_success_at: now, verification_state: "verified-working" },
          { last_success_at: now - 1, verification_state: "maintenance-required" },
        ],
        0,
      ),
    ).toMatchObject({ verificationState: "unavailable", verifiedAt: now - 1 });
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
