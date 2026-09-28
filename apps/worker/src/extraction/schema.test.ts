import { DateOnlySchema, ExactTimeSchema } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { type StoredArticleVersion, validateCandidateAgainstArticle } from "./article";
import { eventIdentity, milestoneIdentity } from "./identity";
import { type CandidateProposal, parseCandidateProposal } from "./schema";

const article: StoredArticleVersion = {
  articleVersionId: "version-one",
  articleId: "article-one",
  sourceId: "zzz-ann",
  externalId: "synthetic-1",
  officialUrl: "https://announcement-api.mihoyo.com/example",
  game: "zzz",
  region: "CN",
  verificationState: "verified-working",
  completeness: "complete",
  blocks: [
    { kind: "title", text: "「示例」活动说明" },
    {
      kind: "html",
      html: "<p>活动时间：2026/09/23 04:00；奖励截止：2026/09/28 03:59；官方宣布活动取消</p>",
    },
  ],
  mediaRefs: [],
};

function validProposal(): CandidateProposal {
  return {
    classification: "events",
    ambiguities: [],
    events: [
      {
        event_key: "primary",
        event_type: "limited_event",
        status: "scheduled",
        title: "「示例」活动说明",
        summary: null,
        type_evidence: { block_ref: "blocks/0", quote: "活动说明", tag: null },
        status_evidence: null,
        change_relation: null,
        milestones: [
          {
            milestone_key: "start",
            node_type: "start",
            title: "活动开始",
            time: {
              precision: "datetime",
              utc_ms: ExactTimeSchema.parse(Date.parse("2026-09-22T20:00:00Z")),
              source_timezone: "UTC+08:00",
              raw_expression: "2026/09/23 04:00",
              time_basis: "official_explicit",
            },
            time_evidence: { block_ref: "blocks/1", quote: "2026/09/23 04:00", tag: null },
          },
          {
            milestone_key: "reward_deadline",
            node_type: "reward_deadline",
            title: "奖励领取截止",
            time: {
              precision: "datetime",
              utc_ms: ExactTimeSchema.parse(Date.parse("2026-09-27T19:59:00Z")),
              source_timezone: "UTC+08:00",
              raw_expression: "2026/09/28 03:59",
              time_basis: "official_explicit",
            },
            time_evidence: { block_ref: "blocks/1", quote: "2026/09/28 03:59", tag: null },
          },
        ],
      },
    ],
  };
}

describe("A-P3-EXTRACT 候选 Schema 与证据纯函数", () => {
  it("人工和未来模型共用严格形状，未知来源身份字段及嵌套未知字段均拒绝", () => {
    const valid = validProposal();
    expect(parseCandidateProposal(valid).success).toBe(true);
    for (const modified of [
      { ...valid, source_id: "forged" },
      { ...valid, article_version: "forged" },
      { ...valid, events: [{ ...valid.events[0], game: "hsr" }] },
      {
        ...valid,
        events: [
          {
            ...valid.events[0],
            milestones: [
              {
                ...valid.events[0].milestones[0],
                time: { ...valid.events[0].milestones[0].time, invented: 1 },
              },
            ],
          },
        ],
      },
    ]) {
      const result = parseCandidateProposal(modified);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.issues.some((issue) => issue.message.includes("未知字段"))).toBe(true);
    }
  });

  it("限制类型、枚举、长度、数组、空值及重复稳定键", () => {
    const valid = validProposal();
    const event = valid.events[0];
    const milestone = event.milestones[0];
    for (const modified of [
      { ...valid, classification: "guess" },
      { ...valid, events: [{ ...event, event_type: "quest" }] },
      { ...valid, events: [{ ...event, status: "removed" }] },
      { ...valid, events: [{ ...event, title: "" }] },
      { ...valid, events: [{ ...event, summary: 42 }] },
      { ...valid, events: [{ ...event, milestones: null }] },
      { ...valid, events: [{ ...event, milestones: [] }] },
      { ...valid, events: [{ ...event, milestones: [{ ...milestone, node_type: "opening" }] }] },
      { ...valid, events: [{ ...event, milestones: [{ ...milestone, time_evidence: null }] }] },
      { ...valid, events: [{ ...event, milestone_key: "2026_09_23" }] },
      { ...valid, events: [event, event] },
      { ...valid, ambiguities: ["x".repeat(9000)] },
    ])
      expect(parseCandidateProposal(modified).success).toBe(false);
  });

  it("日期精度保留 date 载荷；奖励截止与玩法结束可以分开且键不含日期", () => {
    const valid = validProposal();
    const event = valid.events[0];
    const dateNode = {
      milestone_key: "end",
      node_type: "end",
      title: "玩法结束",
      time: {
        precision: "date",
        date: DateOnlySchema.parse("2026-09-29"),
        source_timezone: "UTC+08:00",
        raw_expression: "2026-09-29",
        time_basis: "official_explicit",
      },
      time_evidence: { block_ref: "blocks/1", quote: "2026-09-29", tag: null },
    };
    const parsed = parseCandidateProposal({
      ...valid,
      events: [{ ...event, milestones: [...event.milestones, dateNode] }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events[0].milestones.map((item) => item.milestone_key)).toEqual([
        "start",
        "reward_deadline",
        "end",
      ]);
      expect(parsed.data.events[0].milestones[2].time).toEqual(dateNode.time);
      expect("utc_ms" in parsed.data.events[0].milestones[2].time).toBe(false);
    }
  });

  it("缺口不能断言无事件，也不能产出取消；取消需要完整官方正文的取消引文", () => {
    const gap = { ...article, completeness: "gap-body-truncated" as const };
    const noEvent = { classification: "no_event", events: [], ambiguities: [] };
    expect(validateCandidateAgainstArticle(noEvent, gap).success).toBe(false);
    expect(validateCandidateAgainstArticle(noEvent, article).success).toBe(true);
    const valid = validProposal();
    const cancelled = {
      ...valid,
      events: [
        {
          ...valid.events[0],
          status: "cancelled",
          status_evidence: { block_ref: "blocks/1", quote: "官方宣布活动取消", tag: null },
        },
      ],
    };
    expect(validateCandidateAgainstArticle(cancelled, gap).success).toBe(false);
    expect(validateCandidateAgainstArticle(cancelled, article).success).toBe(true);
    expect(
      validateCandidateAgainstArticle(
        {
          ...cancelled,
          events: [
            {
              ...cancelled.events[0],
              status_evidence: { block_ref: "blocks/1", quote: "活动时间", tag: null },
            },
          ],
        },
        article,
      ).success,
    ).toBe(false);
  });

  it("每个时间核对原文块与 t 标签；不存在的引用和伪造时间失败", () => {
    const valid = validProposal();
    expect(validateCandidateAgainstArticle(valid, article).success).toBe(true);
    const event = valid.events[0];
    const milestone = event.milestones[0];
    for (const evidence of [
      { block_ref: "blocks/9", quote: "2026/09/23 04:00", tag: null },
      { block_ref: "blocks/1", quote: "2026/09/23 04:00", tag: "t_gl" },
      { block_ref: "blocks/1", quote: "2026/09/23 05:00", tag: null },
    ]) {
      const changed = {
        ...valid,
        events: [{ ...event, milestones: [{ ...milestone, time_evidence: evidence }] }],
      };
      expect(validateCandidateAgainstArticle(changed, article).success).toBe(false);
    }
  });

  it("UTC 值须与原文一致；人工也不能把纯日期或更新后开放填成午夜", () => {
    const valid = validProposal();
    const event = valid.events[0];
    const start = event.milestones[0];
    const wrongUtc = {
      ...valid,
      events: [
        {
          ...event,
          milestones: [
            { ...start, time: { ...start.time, utc_ms: Date.parse("2026-09-22T20:01:00Z") } },
          ],
        },
      ],
    };
    expect(validateCandidateAgainstArticle(wrongUtc, article).success).toBe(false);
    const dateAsMidnight = {
      ...valid,
      events: [
        {
          ...event,
          milestones: [
            {
              ...start,
              time: {
                ...start.time,
                raw_expression: "2026/09/23",
                utc_ms: Date.parse("2026-09-22T16:00:00Z"),
              },
              time_evidence: { block_ref: "blocks/1", quote: "2026/09/23", tag: null },
            },
          ],
        },
      ],
    };
    expect(validateCandidateAgainstArticle(dateAsMidnight, article).success).toBe(false);
    const relativeArticle = {
      ...article,
      blocks: [...article.blocks, { kind: "text" as const, text: "版本更新后开放" }],
    };
    const relative = {
      ...valid,
      events: [
        {
          ...event,
          milestones: [
            {
              ...start,
              time: { ...start.time, raw_expression: "版本更新后开放" },
              time_evidence: { block_ref: "blocks/2", quote: "版本更新后开放", tag: null },
            },
          ],
        },
      ],
    };
    expect(validateCandidateAgainstArticle(relative, relativeArticle).success).toBe(false);
  });

  it("改期只改变时间；Event 与 Milestone 身份保持稳定", async () => {
    const first = await eventIdentity("zzz-ann", "1303", "primary");
    const start = await milestoneIdentity(first, "start");
    const changedTime = {
      ...validProposal().events[0].milestones[0],
      time: {
        ...validProposal().events[0].milestones[0].time,
        raw_expression: "2026/10/01 04:00",
      },
    };
    expect(changedTime.time.raw_expression).not.toBe(
      validProposal().events[0].milestones[0].time.raw_expression,
    );
    expect(await eventIdentity("zzz-ann", "1303", "primary")).toBe(first);
    expect(await milestoneIdentity(first, "start")).toBe(start);
    expect(await milestoneIdentity(first, "reward_deadline")).not.toBe(start);
  });
});
