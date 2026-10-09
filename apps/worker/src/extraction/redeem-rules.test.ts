// ADR-0030 · 直播兑换码规则模板与有效期换算的边界。纯函数，合成正文。
// ADR-0034：正文只写已发放的兑换码；管理员照官方说明登记的截止时间优先于官方说明认出的有效期。
import { CANDIDATE_TEXT_FIELD_BYTES } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { liveArticleHtml, type RevealedLiveCode } from "../sources/adapters/miyolive-article";
import { splitBodyBlocks } from "../sources/articles/blocks";
import type { StoredArticleVersion } from "./article";
import { redeemExpiryInstant, redeemExpiryTime } from "./redeem";
import { extractByRules } from "./rules";

const at = (time: string) => Date.parse(`2026-10-09T${time}+08:00`);
function articleFromHtml(
  html: string,
  overrides: Partial<StoredArticleVersion> = {},
): StoredArticleVersion {
  return {
    articleVersionId: "version",
    articleId: "article",
    sourceId: "zzz-live",
    externalId: "ea202610091930001",
    officialUrl: "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=ea202610091930001",
    game: "zzz",
    region: "CN",
    verificationState: "verified-working",
    completeness: "complete",
    blocks: [{ kind: "title", text: "合成前瞻特别节目" }, ...splitBodyBlocks(html)],
    mediaRefs: [],
    ...overrides,
  };
}
function article(
  codes: readonly RevealedLiveCode[],
  tip: string | null,
  overrides: Partial<StoredArticleVersion> = {},
  manualExpiry: string | null = null,
): StoredArticleVersion {
  return articleFromHtml(liveArticleHtml(codes, tip, manualExpiry), overrides);
}
const code = (value: string, time: string): RevealedLiveCode => ({
  code: value,
  reward: "菲林*100",
  revealAtMs: at(time),
});
/** ADR-0030 时的旧正文写法：码还空着的条目写成"待发放"行（ADR-0034 起不再写，但旧版本照常读回）。 */
const pendingLine = (time: string) =>
  `<p>发放时间：2026/10/09 ${time}｜兑换码：待发放｜奖励：菲林*100</p>`;

describe("ADR-0030 直播兑换码规则模板", () => {
  it("开始=第一个兑换码的发放时刻；说明写了有效期才有结束；简介列出已发放的兑换码", () => {
    const outcome = extractByRules(
      article([code("CODEA", "19:45")], "兑换码有效期至2026/10/10 12:00"),
    );
    expect(outcome.kind).toBe("ready_for_publication");
    if (outcome.kind !== "ready_for_publication") return;
    expect(outcome.templateId).toBe("miyolive-redeem-codes-v1");
    const [event] = outcome.proposal.events;
    expect(event).toMatchObject({
      event_key: "redeem_codes",
      event_type: "redeem_code",
      title: "合成前瞻特别节目兑换码",
      summary: "兑换码：CODEA",
    });
    expect(event?.milestones.map((m) => [m.node_type, m.time])).toEqual([
      [
        "start",
        {
          precision: "datetime",
          utc_ms: at("19:45"),
          source_timezone: "UTC+08:00",
          raw_expression: "2026/10/09 19:45",
          time_basis: "official_explicit",
        },
      ],
      [
        "end",
        {
          precision: "datetime",
          utc_ms: Date.parse("2026-10-10T12:00:00+08:00"),
          source_timezone: "UTC+08:00",
          raw_expression: "2026/10/10 12:00",
          time_basis: "official_explicit",
        },
      ],
    ]);
  });

  it("说明没写有效期、或写法认不出：只有开始节点，不猜结束", () => {
    for (const tip of [null, "兑换码有效期较短，请尽快兑换", "有效期至次日中午"]) {
      const outcome = extractByRules(article([code("CODEA", "19:45")], tip));
      expect(outcome.kind).toBe("ready_for_publication");
      if (outcome.kind === "ready_for_publication")
        expect(outcome.proposal.events[0]?.milestones.map((m) => m.milestone_key)).toEqual([
          "codes_release",
        ]);
    }
  });

  it("ADR-0034：旧正文里只有待发放的条目时不产出事件；待发放在前时开始取第一个已发放的兑换码", () => {
    expect(extractByRules(articleFromHtml(pendingLine("19:45")))).toEqual({
      kind: "review",
      reason: "直播活动还没有已发放的兑换码",
    });
    const mixed = extractByRules(
      articleFromHtml(
        `${pendingLine("19:40")}<p>发放时间：2026/10/09 19:45｜兑换码：CODEA｜奖励：菲林*100</p>`,
      ),
    );
    expect(mixed.kind).toBe("ready_for_publication");
    if (mixed.kind !== "ready_for_publication") return;
    expect(mixed.proposal.events[0]?.milestones[0]?.time).toMatchObject({
      utc_ms: at("19:45"),
      raw_expression: "2026/10/09 19:45",
    });
    expect(mixed.proposal.events[0]?.summary).toBe("兑换码：CODEA");
  });

  it("ADR-0034：管理员登记的截止时间建结束节点，优先于官方说明认出的有效期，证据指向登记那一行", () => {
    const outcome = extractByRules(
      article(
        [code("CODEA", "19:45")],
        "兑换码有效期至2026/10/10 12:00",
        {},
        "2026/10/11 23:59:59",
      ),
    );
    expect(outcome.kind).toBe("ready_for_publication");
    if (outcome.kind !== "ready_for_publication") return;
    const end = outcome.proposal.events[0]?.milestones.find((m) => m.node_type === "end");
    expect(end).toMatchObject({
      milestone_key: "codes_expiry",
      title: "兑换码过期",
      time: {
        precision: "datetime",
        utc_ms: Date.parse("2026-10-11T23:59:59+08:00"),
        raw_expression: "2026/10/11 23:59:59",
        time_basis: "official_explicit",
      },
      // 标题块 0、兑换码 1、官方说明 2、登记 3。
      time_evidence: { block_ref: "blocks/3", quote: "2026/10/11 23:59:59" },
    });
    // 官方没写有效期时同样按登记建结束节点。
    const undated = extractByRules(article([code("CODEA", "19:45")], null, {}, "2026/10/11 12:00"));
    expect(
      undated.kind === "ready_for_publication" &&
        undated.proposal.events[0]?.milestones.map((m) => m.milestone_key),
    ).toEqual(["codes_release", "codes_expiry"]);
  });

  it("ADR-0034：登记行的时间无效时进人工审核，不发布", () => {
    expect(extractByRules(article([code("CODEA", "19:45")], null, {}, "2026/02/30 12:00"))).toEqual(
      { kind: "review", reason: "登记的截止时间无效" },
    );
  });

  it('兑换码很多时简介截在候选文本上限内并写"等"', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      code(`CODE${String(i).padStart(6, "0")}`, "19:45"),
    );
    const outcome = extractByRules(article(many, null));
    expect(outcome.kind).toBe("ready_for_publication");
    if (outcome.kind !== "ready_for_publication") return;
    const summary = outcome.proposal.events[0]?.summary ?? "";
    expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(
      CANDIDATE_TEXT_FIELD_BYTES,
    );
    expect(summary.endsWith(" 等")).toBe(true);
  });

  it("没有兑换码条目、正文不是本站写法、缺口版本：进人工审核，不发布", () => {
    expect(extractByRules(article([], null))).toEqual({
      kind: "review",
      reason: "直播活动还没有已发放的兑换码",
    });
    expect(
      extractByRules(
        article([code("CODEA", "19:45")], null, {
          blocks: [
            { kind: "title", text: "x" },
            { kind: "html", html: "<p>兑换码：CODEA</p>" },
          ],
        }),
      ).kind,
    ).toBe("review");
    expect(
      extractByRules(
        article([code("CODEA", "19:45")], null, { completeness: "gap-body-truncated" }),
      ).kind,
    ).toBe("review");
  });

  it("公告源不走这个模板：同样的正文挂在公告源下按公告规则处理", () => {
    const outcome = extractByRules(
      article([code("CODEA", "19:45")], null, { sourceId: "zzz-ann" }),
    );
    expect(outcome).toEqual({ kind: "review", reason: "未命中已核验规则模板" });
  });
});

describe("ADR-0030 有效期换算", () => {
  it("带年份的中文写法是官方明确时间；没写年份的按正文日期补年份；只写日期的条里截到当天结束", () => {
    expect(redeemExpiryTime("有效期至2026年10月10日 12:00", null)).toMatchObject({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-10T12:00:00+08:00"),
      time_basis: "official_explicit",
    });
    expect(redeemExpiryTime("有效期至2026年2月30日 12:00", null)).toBeNull();
    expect(redeemExpiryTime("有效期至10月10日12:00", "2026-10-09")).toMatchObject({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-10T12:00:00+08:00"),
      time_basis: "deterministic_derived",
    });
    expect(redeemExpiryTime("有效期至10月10日12:00", null)).toBeNull();
    const dateOnly = redeemExpiryTime("有效期至1月2日", "2026-12-30");
    expect(dateOnly).toMatchObject({ precision: "date", date: "2027-01-02" });
    expect(dateOnly && redeemExpiryInstant(dateOnly)).toBe(Date.parse("2027-01-03T00:00:00+08:00"));
  });
});
