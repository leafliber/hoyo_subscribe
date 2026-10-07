// ADR-0030 · 直播兑换码规则模板与有效期换算的边界。纯函数，合成正文。
import { CANDIDATE_TEXT_FIELD_BYTES } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import type { LiveCodeEntry } from "../sources/adapters/miyolive";
import { liveArticleHtml } from "../sources/adapters/miyolive-article";
import { splitBodyBlocks } from "../sources/articles/blocks";
import type { StoredArticleVersion } from "./article";
import { redeemExpiryInstant, redeemExpiryTime } from "./redeem";
import { extractByRules } from "./rules";

const at = (time: string) => Date.parse(`2026-10-09T${time}+08:00`);
function article(
  codes: readonly LiveCodeEntry[],
  tip: string | null,
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
    blocks: [
      { kind: "title", text: "合成前瞻特别节目" },
      ...splitBodyBlocks(liveArticleHtml(codes, tip)),
    ],
    mediaRefs: [],
    ...overrides,
  };
}
const code = (value: string | null, time: string): LiveCodeEntry => ({
  code: value,
  reward: "菲林*100",
  revealAtMs: at(time),
});

describe("ADR-0030 直播兑换码规则模板", () => {
  it("开始=第一个兑换码的发放时刻；说明写了有效期才有结束；简介列出已发放的兑换码", () => {
    const outcome = extractByRules(
      article([code("CODEA", "19:45"), code(null, "20:05")], "兑换码有效期至2026/10/10 12:00"),
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

  it('还没发放任何兑换码时简介为空；兑换码很多时简介截在候选文本上限内并写"等"', () => {
    const pending = extractByRules(article([code(null, "19:45")], null));
    expect(
      pending.kind === "ready_for_publication" && pending.proposal.events[0]?.summary,
    ).toBeNull();
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
    expect(extractByRules(article([], null)).kind).toBe("review");
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
