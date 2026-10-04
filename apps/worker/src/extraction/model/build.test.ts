// A-P3-DRAFT · 模型中间输出 → 候选形状的确定性转换（真实公告样本 + 固定模型输出，无网络、无推理）。
import { CANDIDATE_TEXT_FIELD_BYTES } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import zzzContent from "../../../../../fixtures/sources/zzz-ann/content-1301.json";
import { parseAnnouncementExactTime } from "../time";
import { buildDraftProposal, clampText, parseModelJson } from "./build";
import { DRAFT_SYSTEM_PROMPT, draftUserPrompt } from "./prompt";
import { readableBlockText } from "./readable";
import {
  type FixtureBody,
  fixtureEntry,
  GACHA_21876_OUTPUT,
  MAINTENANCE_21928_OUTPUT,
  storedFromFixture,
} from "./test-support";

const genshin = genshinContent as unknown as FixtureBody;
const gacha = storedFromFixture("genshin-ann", fixtureEntry(genshin, 21876));
const maintenance = storedFromFixture("genshin-ann", fixtureEntry(genshin, 21928));
const zzz = storedFromFixture("zzz-ann", fixtureEntry(zzzContent as unknown as FixtureBody, 1301));

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "limited_event",
    status: "scheduled",
    title: "「虚境逐影争锋」活动",
    type_quote: { block: 0, quote: "「虚境逐影争锋」活动说明" },
    status_quote: null,
    milestones: [
      { node_type: "start", label: "", block: 2, time_text: "2026/09/16 10:00", estimated: false },
      { node_type: "end", label: "", block: 2, time_text: "2026/10/05 03:59", estimated: false },
    ],
    ...overrides,
  };
}

describe("A-P3-DRAFT 可读正文与提示词", () => {
  it("表格一行一行、单元格以 | 分隔；转义 <t> 时间标签只留时间", () => {
    const table = readableBlockText(gacha.blocks[4]);
    expect(table).toContain("祈愿时间 | 概率提升角色（5星） | 概率提升角色（4星）");
    expect(table).toContain("7.1版本更新后 ~ 2026/10/13 17:59 | 「雪宴之锋·薇斯纳(风)」");
    expect(table).not.toContain("<t");
    expect(table).not.toContain("&lt;");
  });

  it("提示词跳过空块但保留官方块号，并带 /no_think；只含官方正文与固定说明", () => {
    const prompt = draftUserPrompt(gacha);
    expect(prompt).toContain("游戏：原神（国服）");
    expect(prompt).toContain("[blocks/4]\n祈愿时间");
    expect(prompt).not.toContain("[blocks/2]");
    expect(prompt.endsWith("只输出 JSON。/no_think")).toBe(true);
    expect(DRAFT_SYSTEM_PROMPT).toContain("time_text 必须从正文逐字复制");
  });

  it("解析模型 JSON：去掉思考块与代码围栏，坏文本返回 null", () => {
    expect(parseModelJson('\n\n<think>先想想</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('  {"classification":"no_event"} ')).toEqual({
      classification: "no_event",
    });
    expect(parseModelJson("抱歉，我无法回答")).toBeNull();
    expect(parseModelJson('{"a":')).toBeNull();
  });
});

describe("A-P3-DRAFT 确定性构建", () => {
  it("真实卡池输出：版本更新后保留原文为未知精度，结束时刻按官方 UTC+8 解析并识别 t_lc", () => {
    const result = buildDraftProposal(gacha, parseModelJson(GACHA_21876_OUTPUT));
    expect(result.status).toBe("ready");
    expect(result.notes).toEqual([]);
    const [primary] = result.proposal.events;
    expect(result.proposal.classification).toBe("events");
    expect(primary).toMatchObject({
      event_key: "primary",
      event_type: "gacha",
      status: "scheduled",
      title: "「煦风欢舞时」祈愿",
      change_relation: null,
      summary: null,
      type_evidence: { block_ref: "blocks/0", tag: null },
    });
    expect(primary.milestones.map((m) => [m.milestone_key, m.node_type, m.title])).toEqual([
      ["start", "start", "「煦风欢舞时」祈愿开始"],
      ["end", "end", "「煦风欢舞时」祈愿结束"],
    ]);
    expect(primary.milestones[0].time).toEqual({
      precision: "unknown",
      source_timezone: "UTC+08:00",
      raw_expression: "7.1版本更新后",
      time_basis: "unresolved",
    });
    expect(primary.milestones[1].time).toEqual(parseAnnouncementExactTime("2026/10/13 17:59"));
    expect(primary.milestones[1].time_evidence).toEqual({
      block_ref: "blocks/4",
      quote: "2026/10/13 17:59",
      tag: "t_lc",
    });
  });

  it("真实维护输出：原文没有的推算时刻被丢弃并留说明，其余节点照常可用", () => {
    const result = buildDraftProposal(maintenance, parseModelJson(MAINTENANCE_21928_OUTPUT));
    expect(result.status).toBe("ready");
    expect(result.notes).toEqual([
      "事件 1：原文中找不到「2026/09/23 11:00」，已丢弃这个结束节点。",
    ]);
    expect(result.proposal.events[0].milestones.map((m) => m.node_type)).toEqual([
      "start",
      "reward_deadline",
    ]);
    expect(JSON.stringify(result.proposal)).not.toContain("11:00");
  });

  it("块号写错但全文只有一处时按原文更正；多处出现时不猜", () => {
    const corrected = buildDraftProposal(zzz, {
      classification: "events",
      ambiguities: [],
      events: [
        event({
          milestones: [
            {
              node_type: "start",
              label: "",
              block: 9,
              time_text: "2026/09/16 10:00",
              estimated: false,
            },
          ],
        }),
      ],
    });
    expect(corrected.status).toBe("ready");
    expect(corrected.notes).toEqual([
      "事件 1：「2026/09/16 10:00」实际在 blocks/2，已按原文更正块号。",
    ]);
    expect(corrected.proposal.events[0].milestones[0].time_evidence.block_ref).toBe("blocks/2");
    const ambiguous = buildDraftProposal(maintenance, {
      classification: "events",
      ambiguities: [],
      events: [
        {
          ...event({ event_type: "maintenance", title: "维护" }),
          milestones: [
            {
              node_type: "start",
              label: "",
              block: 99,
              time_text: "2026/09/23 06:00",
              estimated: false,
            },
          ],
        },
      ],
    });
    expect(ambiguous.proposal.events).toEqual([]);
    expect(ambiguous.proposal.classification).toBe("uncertain");
  });

  it("区间、无效节点类型、四类以外的事件类型都被丢弃；预计时刻只记官方估计", () => {
    const result = buildDraftProposal(zzz, {
      classification: "events",
      ambiguities: [],
      events: [
        event({
          milestones: [
            {
              node_type: "start",
              label: "",
              block: 2,
              time_text: "2026/09/16 10:00（服务器时间） ~ 2026/10/05 03:59",
              estimated: false,
            },
            {
              node_type: "deadline",
              label: "",
              block: 2,
              time_text: "2026/10/05 03:59",
              estimated: false,
            },
            {
              node_type: "end",
              label: "",
              block: 2,
              time_text: "2026/10/05 03:59",
              estimated: true,
            },
          ],
        }),
        event({ event_type: "shop", title: "商店" }),
      ],
    });
    expect(result.notes).toEqual([
      "事件 1：「2026/09/16 10:00（服务器时间） ~ 2026/10/05 03:59」含多个时刻，不是单一时间点，已丢弃。",
      "事件 1：丢弃节点类型无效的时间「2026/10/05 03:59」。",
      "事件 2：事件类型「shop」不在四类日程内，已丢弃整个事件。",
    ]);
    expect(result.proposal.events).toHaveLength(1);
    expect(result.proposal.events[0].milestones[0].time).toMatchObject({
      precision: "datetime",
      time_basis: "official_estimate",
    });
  });

  it("模型给的跨公告关系与撤回状态不会进入草稿；取消缺原句时降为待人工确认的歧义", () => {
    const result = buildDraftProposal(zzz, {
      classification: "events",
      ambiguities: [],
      events: [
        event({ change_relation: { target_event_id: "x", reason: "y" }, status: "retracted" }),
        event({
          title: "已取消的活动",
          status: "cancelled",
          status_quote: { block: 0, quote: "取消" },
        }),
      ],
    });
    expect(result.proposal.events.map((e) => [e.event_key, e.status, e.change_relation])).toEqual([
      ["primary", "scheduled", null],
      ["event_b", "scheduled", null],
    ]);
    expect(result.proposal.classification).toBe("uncertain");
    expect(result.proposal.ambiguities).toEqual([
      "模型认为「已取消的活动」已取消，但原文核对不到对应原句，请人工核对。",
    ]);
    expect(result.status).toBe("ready");
  });

  it("分类与内容矛盾时一律落到 uncertain；无日程只在确实没有事件时成立", () => {
    expect(
      buildDraftProposal(zzz, { classification: "no_event", ambiguities: [], events: [] }).proposal,
    ).toEqual({ classification: "no_event", events: [], ambiguities: [] });
    const mixed = buildDraftProposal(zzz, {
      classification: "no_event",
      ambiguities: [],
      events: [event()],
    });
    expect(mixed.proposal.classification).toBe("uncertain");
    const nothing = buildDraftProposal(zzz, {
      classification: "events",
      ambiguities: [],
      events: [
        event({ milestones: [{ node_type: "end", block: 2, time_text: "2099/01/01 00:00" }] }),
      ],
    });
    expect(nothing.proposal).toMatchObject({
      classification: "uncertain",
      events: [],
      ambiguities: ["模型给出的时间都无法在原文中核对到。"],
    });
    expect(buildDraftProposal(zzz, "不是对象").proposal.classification).toBe("uncertain");
    expect(
      buildDraftProposal(zzz, { classification: "maybe", events: [event()] }).proposal.ambiguities,
    ).toContain("模型输出的分类无效。");
  });

  it("标题与说明按候选字段预算截断；类型引文核对不到时退回官方标题块", () => {
    const longTitle = "超长标题".repeat(200);
    const result = buildDraftProposal(zzz, {
      classification: "events",
      ambiguities: [],
      events: [event({ title: longTitle, type_quote: { block: 0, quote: "原文没有的引文" } })],
    });
    const [only] = result.proposal.events;
    expect(new TextEncoder().encode(JSON.stringify(only.title)).byteLength).toBeLessThanOrEqual(
      CANDIDATE_TEXT_FIELD_BYTES,
    );
    expect(only.title.endsWith("…")).toBe(true);
    expect(only.type_evidence).toEqual({
      block_ref: "blocks/0",
      quote: "「虚境逐影争锋」活动说明",
      tag: null,
    });
    expect(clampText("  a \n b  ")).toBe("a b");
    expect(result.status).toBe("ready");
  });
});
