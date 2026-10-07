// ADR-0030 · 直播兑换码适配器：发现入口用 2026-10-07 实测样本，活动与兑换码接口用合成样本
// （字段按官方直播页前端构造，见 fixtures/sources/miyolive/）。全部离线，不访问官方。
import { SOURCE_LIMIT_PROFILE } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import homeGenshin from "../../../../../fixtures/sources/miyolive/home-genshin.json";
import homeHsr from "../../../../../fixtures/sources/miyolive/home-hsr.json";
import homeZzz from "../../../../../fixtures/sources/miyolive/home-zzz.json";
import indexClosed from "../../../../../fixtures/sources/miyolive/index-closed.json";
import codeClosed from "../../../../../fixtures/sources/miyolive/refresh-code-closed.json";
import indexActive from "../../../../../fixtures/sources/miyolive/synthetic-index-active.json";
import codesActive from "../../../../../fixtures/sources/miyolive/synthetic-refresh-code.json";
import { splitBodyBlocks } from "../articles/blocks";
import { guardedSourceFetch, SOURCE_COLLECTOR_USER_AGENT } from "../guarded-fetch";
import { getSourceEntry, isLiveEntry, type MiyoliveSourceEntry } from "../registry";
import {
  discoverLiveActIds,
  extractLiveActIds,
  fetchLiveSnapshot,
  liveOfficialUrl,
  parseCodeList,
  parseLiveIndex,
} from "./miyolive";
import { liveArticleHtml, liveRevealExpression, readLiveArticle } from "./miyolive-article";

const ACT = "ea202610091930001";
const LIVE_URL = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${ACT}&mhy_presentation_style=fullscreen`;

function zzzLive(): MiyoliveSourceEntry {
  const entry = getSourceEntry("zzz-live");
  if (!isLiveEntry(entry)) throw new Error("zzz-live 应为直播兑换码来源");
  return entry;
}

describe("ADR-0030 发现入口：米游社首页里的官方直播页链接", () => {
  it("2026-10-07 实测：三个游戏都没有直播入口；同主机的签到、征集活动页不算", () => {
    for (const sample of [homeGenshin, homeHsr, homeZzz]) {
      expect(sample.synthetic).toBe(false);
      expect(extractLiveActIds(sample.body.data as Record<string, unknown>)).toEqual([]);
    }
    // 实测导航里确有带 act_id 的链接，只是不在官方直播页：不能被当成直播活动。
    expect(JSON.stringify(homeZzz.body)).toContain("act_id=e202406242138391");
    expect(JSON.stringify(homeHsr.body)).toContain("act_id=ea202609031728067124");
  });

  it("直播卡片的链接与 act_id 字段、导航里的应用内链接、轮播里的网页链接都认，按出现顺序去重", () => {
    const data = {
      lives: [
        { title: "前瞻特别节目", app_path: LIVE_URL, act_id: ACT },
        { title: "另一场", act_id: "ea202610100000002" },
      ],
      navigator: [
        {
          name: "前瞻直播",
          app_path: `mihoyobbs://webview?link=${encodeURIComponent(LIVE_URL)}`,
        },
        {
          name: "签到",
          app_path: "https://webstatic.mihoyo.com/bbs/event/signin/index.html?act_id=e1",
        },
        {
          name: "直播列表",
          app_path: "https://webstatic.mihoyo.com/bbs/event/live/live.html?act_id=list1",
        },
        {
          name: "假冒主机",
          app_path: "https://webstatic.example.com/bbs/event/live/index.html?act_id=x9",
        },
      ],
      carousels: {
        position: 10,
        data: [
          {
            cover: "https://example.invalid/c.png",
            app_path:
              "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=ea202610110000003",
          },
          { cover: "https://example.invalid/d.png", app_path: "mihoyobbs://article/78701776" },
        ],
      },
    };
    expect(extractLiveActIds(data)).toEqual([ACT, "ea202610100000002", "ea202610110000003"]);
  });

  it("首页一次请求；官方接口要求的只有诚实 UA，不带 Cookie 与活动 ID 头", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(homeZzz.body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    expect(await discoverLiveActIds(zzzLive(), fetchFn)).toEqual({ actIds: [] });
    expect(calls).toEqual([
      {
        url: "https://bbs-api.miyoushe.com/apihub/api/home/new?gids=8",
        headers: { "user-agent": SOURCE_COLLECTOR_USER_AGENT, accept: "application/json" },
      },
    ]);
  });

  it("首页 403 或信封写着需要登录：按访问控制返回，交给调用方停用并标维护", async () => {
    const forbidden = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    expect(await discoverLiveActIds(zzzLive(), forbidden)).toMatchObject({
      failure: { kind: "restricted", status: 403 },
    });
    const login = (async () =>
      Response.json({
        retcode: -100,
        message: "请登录后重试",
        data: null,
      })) as unknown as typeof fetch;
    expect(await discoverLiveActIds(zzzLive(), login)).toMatchObject({
      failure: { kind: "restricted" },
    });
  });
});

describe("ADR-0030 直播活动与兑换码接口", () => {
  it("实测：不存在或已结束的活动两接口都回 -500012，按 closed 处理", () => {
    expect(indexClosed.synthetic).toBe(false);
    expect(parseLiveIndex(JSON.stringify(indexClosed.body))).toEqual({ status: "closed" });
    expect(parseCodeList(JSON.stringify(codeClosed.body))).toEqual({ status: "closed" });
  });

  it("合成：活动标题、code_ver 与页面模板里的兑换码说明", () => {
    expect(indexActive.synthetic).toBe(true);
    expect(parseLiveIndex(JSON.stringify(indexActive.body))).toEqual({
      status: "open",
      title: "《绝区零》3.3版本「重返天空的旅程」前瞻特别节目",
      codeVer: "a1b2c3d4",
      tip: "兑换码有效期至10月10日12:00，请绳匠们尽快兑换~",
    });
  });

  it("合成：兑换码按发放时刻排序；未发放的为 null；奖励说明去掉标签并解码", () => {
    expect(codesActive.synthetic).toBe(true);
    expect(parseCodeList(JSON.stringify(codesActive.body))).toEqual({
      status: "open",
      codes: [
        { code: "ZZZ33SYNTHA1", reward: "菲林*100，高级资质认证*2", revealAtMs: 1_791_546_300_000 },
        { code: "ZZZ33SYNTHB2", reward: "菲林*100，&邦布插件*1", revealAtMs: 1_791_547_500_000 },
        { code: null, reward: "菲林*100，丁尼*30000", revealAtMs: 1_791_548_700_000 },
      ],
    });
  });

  it("形状不符整份失败，不猜：缺 to_get_time、兑换码含非法字符、缺 live", () => {
    const envelope = (data: unknown) => JSON.stringify({ retcode: 0, message: "OK", data });
    expect(parseCodeList(envelope({ code_list: [{ code: "A", title: "x" }] }))).toMatchObject({
      failure: { kind: "malformed-body" },
    });
    expect(
      parseCodeList(envelope({ code_list: [{ code: "<b>", title: "x", to_get_time: "1" }] })),
    ).toMatchObject({ failure: { kind: "malformed-body" } });
    expect(parseLiveIndex(envelope({ template: "{}" }))).toMatchObject({
      failure: { kind: "malformed-body" },
    });
  });

  it("一个活动两次请求：请求头只多 x-rpc-act_id；兑换码接口的 time 按 20 秒取整，同官方页面", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: init?.headers as Record<string, string> });
      const body = url.includes("refreshCode") ? codesActive.body : indexActive.body;
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const now = Date.parse("2026-10-09T20:10:07+08:00");
    const result = await fetchLiveSnapshot(zzzLive(), ACT, now, fetchFn);
    expect(result).toMatchObject({ live: { actId: ACT, status: "open", codes: { length: 3 } } });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api-takumi.mihoyo.com/event/miyolive/index",
      `https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode?version=a1b2c3d4&time=${1_791_547_800}`,
    ]);
    for (const call of calls)
      expect(call.headers).toEqual({
        "x-rpc-act_id": ACT,
        "user-agent": SOURCE_COLLECTOR_USER_AGENT,
        accept: "application/json",
      });
  });

  it("还没配置兑换码（code_ver 为空）时只请求活动信息", async () => {
    let calls = 0;
    const body = structuredClone(indexActive.body);
    body.data.live.code_ver = "";
    const fetchFn = (async () => {
      calls++;
      return Response.json(body);
    }) as unknown as typeof fetch;
    const result = await fetchLiveSnapshot(zzzLive(), ACT, Date.now(), fetchFn);
    expect(result).toMatchObject({ live: { status: "open", codes: [] } });
    expect(calls).toBe(1);
  });

  it("受限 fetch 只放行 x-rpc-act_id 这一个额外请求头，取值必须是活动 ID 的形状", async () => {
    const limits = {
      allowedHosts: ["api-takumi.mihoyo.com"],
      timeoutMs: 1000,
      maxResponseBytes: SOURCE_LIMIT_PROFILE.responseCapsBytes["zzz-live"],
    };
    const never = (async () => {
      throw new Error("不应发出请求");
    }) as unknown as typeof fetch;
    for (const extraHeaders of [
      { cookie: "a=b" },
      { "x-rpc-act_id": "a b" },
      { referer: "x" },
    ] as Record<string, string>[])
      expect(
        await guardedSourceFetch(
          "https://api-takumi.mihoyo.com/event/miyolive/index",
          { ...limits, extraHeaders },
          never,
        ),
      ).toMatchObject({ kind: "guard-rejected", code: "header_not_allowed" });
  });

  it("官方直播页只作展示链接：带活动 ID，主机不在请求白名单", () => {
    expect(liveOfficialUrl(zzzLive(), ACT)).toBe(
      `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${ACT}`,
    );
    expect(zzzLive().approvedHosts).not.toContain("webstatic.mihoyo.com");
  });
});

describe("ADR-0030 正文写法：本站按官方字段逐行写成，读回时严格匹配", () => {
  it("时间写成公告已核验的斜线写法（北京时间），秒不为 0 时带秒；奖励与说明转义", () => {
    expect(liveRevealExpression(Date.parse("2026-10-09T19:45:00+08:00"))).toBe("2026/10/09 19:45");
    expect(liveRevealExpression(Date.parse("2026-10-09T19:45:30+08:00"))).toBe(
      "2026/10/09 19:45:30",
    );
    const html = liveArticleHtml(
      [
        {
          code: "ZZZ33SYNTHA1",
          reward: "菲林*100 <限定>",
          revealAtMs: Date.parse("2026-10-09T19:45:00+08:00"),
        },
        { code: null, reward: "丁尼*30000", revealAtMs: Date.parse("2026-10-09T20:25:00+08:00") },
      ],
      "兑换码有效期至10月10日12:00 & 请尽快",
    );
    expect(html).toBe(
      "<p>发放时间：2026/10/09 19:45｜兑换码：ZZZ33SYNTHA1｜奖励：菲林*100 &lt;限定&gt;</p>" +
        "<p>发放时间：2026/10/09 20:25｜兑换码：待发放｜奖励：丁尼*30000</p>" +
        "<p>兑换码说明：兑换码有效期至10月10日12:00 &amp; 请尽快</p>",
    );
    const article = readLiveArticle([
      { kind: "title", text: "合成直播" },
      ...splitBodyBlocks(html),
    ]);
    expect(article).toEqual({
      title: "合成直播",
      codes: [
        {
          blockIndex: 1,
          revealExpression: "2026/10/09 19:45",
          code: "ZZZ33SYNTHA1",
          reward: "菲林*100 <限定>",
        },
        { blockIndex: 2, revealExpression: "2026/10/09 20:25", code: null, reward: "丁尼*30000" },
      ],
      tip: { blockIndex: 3, text: "兑换码有效期至10月10日12:00 & 请尽快" },
    });
  });
});
