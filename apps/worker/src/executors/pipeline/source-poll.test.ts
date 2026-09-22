// 来源轮询批次与调度判定（任务卡 P3-01，验收 ID A-P3-FETCH）。
// 样本来自 P0-02 真实抓取，fetch 替身回放；时间常量全部由 contracts 参数推导。

import { SOURCE_HOT_POLL, SOURCE_POLL, SOURCE_RECHECK_INTERVAL } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import genshinList from "../../../../../fixtures/sources/genshin-ann/list-page-1.json";
import newsType1Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type1-page1.json";
import newsType1Page2 from "../../../../../fixtures/sources/miyoushe-news/news-list-type1-page2.json";
import newsType2Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type2-page1.json";
import newsType3Page1 from "../../../../../fixtures/sources/miyoushe-news/news-list-type3-page1.json";
import type { AnnouncementSourceEntry, MiyousheNewsSourceEntry } from "../../sources/registry";
import { getSourceEntry } from "../../sources/registry";
import type { MiyousheWatermark } from "../../sources/snapshot-diff";
import type { SourceItemStub } from "../../sources/types";
import {
  INITIAL_SOURCE_POLL_STATE,
  isPollDue,
  isRecheckDue,
  nextPollDueAtMs,
  pollIntervalSeconds,
  runAnnouncementPollBatch,
  runMiyoushePollBatch,
  type SourcePollState,
  selectRecheckCandidates,
} from "./source-poll";

const genshin = getSourceEntry("genshin-ann") as AnnouncementSourceEntry;
const miyoushe = getSourceEntry("miyoushe-news") as MiyousheNewsSourceEntry;

/** 样本抓取时刻（真实时间轴锚点，非编造）。 */
const CAPTURED_AT_MS = Date.parse("2026-09-21T17:41:54Z");

type AnnListBody = {
  data: { list: Array<{ type_label?: string; list: Array<Record<string, unknown>> }> };
};

function annListBody(): AnnListBody {
  return structuredClone((genshinList as { body: AnnListBody }).body);
}

function annContentBody(): unknown {
  return (genshinContent as { body: unknown }).body;
}

/** 公告源 fetch 替身：getAnnList → listBody；getAnnContent → contentBody（可注 403）。 */
function annFetch(
  listBody: unknown,
  options: { listStatus?: number; contentStatus?: number } = {},
): {
  fetchFn: typeof fetch;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(String(input));
    const isList = url.pathname.endsWith("getAnnList");
    const status = isList ? (options.listStatus ?? 200) : (options.contentStatus ?? 200);
    if (status !== 200) {
      return new Response(JSON.stringify({ message: "forbidden" }), {
        status,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(JSON.stringify(isList ? listBody : annContentBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

/** 对全量列表样本做受控变异：新增（可小于最大 ann_id）、消失、改题。 */
function mutateAnnList(
  body: AnnListBody,
  mutation: { addId?: number; removeId?: number; changeId?: number; newTitle?: string },
): AnnListBody {
  const groups = body.data.list.map((group) => {
    let items = group.list.filter((item) => String(item.ann_id) !== String(mutation.removeId));
    items = items.map((item) =>
      String(item.ann_id) === String(mutation.changeId)
        ? { ...item, title: mutation.newTitle }
        : item,
    );
    return { ...group, list: items };
  });
  if (mutation.addId !== undefined) {
    const template = groups[0].list[0];
    groups[0].list = [
      { ...template, ann_id: mutation.addId, title: `新增历史位公告 ${mutation.addId}` },
      ...groups[0].list,
    ];
  }
  return { ...body, data: { ...body.data, list: groups } };
}

describe("A-P3-FETCH 调度判定：间隔来自 contracts，经来源注册表引用", () => {
  it("常规/热点间隔与到期判定", () => {
    expect(pollIntervalSeconds(genshin, "normal")).toBe(SOURCE_POLL);
    expect(pollIntervalSeconds(genshin, "hot")).toBe(SOURCE_HOT_POLL);
    const state: SourcePollState = { ...INITIAL_SOURCE_POLL_STATE, lastPollCompletedAtMs: 0 };
    expect(isPollDue(genshin, state, SOURCE_POLL * 1000 - 1, "normal")).toBe(false);
    expect(isPollDue(genshin, state, SOURCE_POLL * 1000, "normal")).toBe(true);
    expect(isPollDue(genshin, state, SOURCE_HOT_POLL * 1000, "hot")).toBe(true);
    expect(isPollDue(genshin, INITIAL_SOURCE_POLL_STATE, 0, "normal")).toBe(true);
    expect(nextPollDueAtMs(genshin, state, "normal")).toBe(SOURCE_POLL * 1000);
    expect(nextPollDueAtMs(genshin, INITIAL_SOURCE_POLL_STATE, "normal")).toBeNull();
  });

  it("复查到期：SOURCE_RECHECK_INTERVAL；米游社未登记复查 → 永不到期", () => {
    const state: SourcePollState = { ...INITIAL_SOURCE_POLL_STATE, lastRecheckCompletedAtMs: 0 };
    expect(isRecheckDue(genshin, INITIAL_SOURCE_POLL_STATE, 0)).toBe(true);
    expect(isRecheckDue(genshin, state, SOURCE_RECHECK_INTERVAL * 1000 - 1)).toBe(false);
    expect(isRecheckDue(genshin, state, SOURCE_RECHECK_INTERVAL * 1000)).toBe(true);
    expect(isRecheckDue(miyoushe, INITIAL_SOURCE_POLL_STATE, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("复查候选筛选：展示时间（UTC+8）在窗口内；解析失败保守纳入", () => {
    const stub = (externalId: string, listStartTime: string | null): SourceItemStub =>
      ({
        sourceId: "genshin-ann",
        externalId,
        title: "t",
        subtitle: null,
        typeLabel: null,
        tagLabel: null,
        listStartTime,
        listEndTime: null,
        bannerUrl: null,
        coverUrl: null,
        imageUrls: [],
        publisherUid: null,
        hasContent: null,
        publishedAtMs: null,
      }) as SourceItemStub;
    const nowMs = Date.parse("2026-09-21T17:41:54Z");
    // now − 7 天 = 2026-09-14T17:41:54Z，对应墙钟 2026-09-15 01:41:54 +08:00：
    // 恰在窗口边界者纳入（<= 口径），早 1 秒者排除。
    const candidates = selectRecheckCandidates(
      genshin,
      [
        stub("recent", "2026-09-21 11:10:00"),
        stub("edge-in", "2026-09-15 01:41:54"),
        stub("edge-out", "2026-09-15 01:41:53"),
        stub("garbage", "不是时间"),
        stub("missing", null),
      ],
      nowMs,
    );
    expect(candidates).toContain("recent");
    expect(candidates).toContain("edge-in");
    expect(candidates).toContain("garbage");
    expect(candidates).toContain("missing");
    expect(candidates).not.toContain("edge-out");
  });
});

describe("A-P3-FETCH 公告源批次：全量快照 + ann_id 差分", () => {
  it("首轮：全量 41 条全部记为新增，水位推进，复查候选按窗口筛选", async () => {
    const { fetchFn, requests } = annFetch(annListBody());
    const report = await runAnnouncementPollBatch(
      genshin,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      { fetchFn },
    );
    expect(report.status).toBe("ok");
    expect(report.complete).toBe(true);
    expect(report.diff?.added).toHaveLength(41);
    expect(report.diff?.removed).toEqual([]);
    expect(report.diff?.changed).toEqual([]);
    expect(report.nextState.watermark?.model).toBe("full-snapshot");
    expect(report.nextState.lastPollCompletedAtMs).toBe(CAPTURED_AT_MS);
    expect(report.recheckCandidates).toContain("21928"); // start_time 2026-09-21，窗口内
    expect(report.recheckCandidates).not.toContain("21904"); // start_time 2026-09-01，窗口外
    // 每批恰好两次请求：列表 + 全量正文（各自都是全量端点）。
    expect(requests).toHaveLength(2);
  });

  it("★ 重叠窗口：第二轮对历史条目的新增/消失/变化全部可见（不按最大 ID 推进水位）", async () => {
    const first = annFetch(annListBody());
    const firstReport = await runAnnouncementPollBatch(
      genshin,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      {
        fetchFn: first.fetchFn,
      },
    );
    expect(firstReport.status).toBe("ok");

    // 变异后的第二份全量：新增 ann_id=21800（小于历史最大 21928）、消失 21862、改题 21904。
    const second = annFetch(
      mutateAnnList(annListBody(), {
        addId: 21800,
        removeId: 21862,
        changeId: 21904,
        newTitle: "改题后的公告",
      }),
    );
    const secondReport = await runAnnouncementPollBatch(
      genshin,
      firstReport.nextState,
      CAPTURED_AT_MS + 1000,
      {
        fetchFn: second.fetchFn,
      },
    );
    expect(secondReport.status).toBe("ok");
    expect(secondReport.diff?.added).toEqual(["21800"]);
    expect(secondReport.diff?.removed).toEqual(["21862"]);
    expect(secondReport.diff?.changed.map((change) => change.externalId)).toEqual(["21904"]);
    expect(secondReport.nextState.watermark?.model).toBe("full-snapshot");
  });

  it("内容变化不依赖标题：仅正文变化的条目也能进入 changed（正文 hash 参与指纹）", async () => {
    const first = annFetch(annListBody());
    const firstReport = await runAnnouncementPollBatch(
      genshin,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      {
        fetchFn: first.fetchFn,
      },
    );
    // 第二轮正文集合改动一个条目（列表不动）。
    const contentBody = annContentBody() as { data: { list: Array<Record<string, unknown>> } };
    const mutatedContent = {
      ...contentBody,
      data: {
        ...contentBody.data,
        list: contentBody.data.list.map((entry) =>
          String(entry.ann_id) === "21904"
            ? { ...entry, content: `${entry.content}<p>追加段落</p>` }
            : entry,
        ),
      },
    };
    const listOnly = annListBody();
    const second = annFetch(listOnly);
    // 用改过的正文集合替换 content 路由
    const patchedFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("getAnnContent")) {
        return new Response(JSON.stringify(mutatedContent), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return (second.fetchFn as unknown as (i: RequestInfo | URL) => Promise<Response>)(input);
    }) as typeof fetch;
    const secondReport = await runAnnouncementPollBatch(
      genshin,
      firstReport.nextState,
      CAPTURED_AT_MS + 1000,
      {
        fetchFn: patchedFetch,
      },
    );
    expect(secondReport.status).toBe("ok");
    expect(secondReport.diff?.changed.map((change) => change.externalId)).toEqual(["21904"]);
    expect(secondReport.diff?.added).toEqual([]);
    expect(secondReport.diff?.removed).toEqual([]);
  });

  it("HTTP 200 但 retcode=-1003：complete=false、incomplete、水位不推进", async () => {
    const { fetchFn } = annFetch({ retcode: -1003, message: "提交参数有误", data: null });
    const state: SourcePollState = {
      ...INITIAL_SOURCE_POLL_STATE,
      lastPollCompletedAtMs: 123,
    };
    const report = await runAnnouncementPollBatch(genshin, state, CAPTURED_AT_MS, { fetchFn });
    expect(report.status).toBe("incomplete");
    expect(report.complete).toBe(false);
    expect(report.failure).toMatchObject({ kind: "business-rejected", retcode: -1003 });
    expect(report.nextState).toBe(state);
  });

  it("列表 403 访问控制：maintenance-required、恰好一次请求、不重试不换路径", async () => {
    const { fetchFn, requests } = annFetch(annListBody(), { listStatus: 403 });
    const report = await runAnnouncementPollBatch(
      genshin,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      { fetchFn },
    );
    expect(report.status).toBe("maintenance-required");
    expect(report.failure).toMatchObject({ kind: "restricted", status: 403 });
    expect(requests).toHaveLength(1);
    expect(report.nextState).toBe(INITIAL_SOURCE_POLL_STATE);
  });

  it("正文 403 访问控制：同样停用并标维护，列表成功也不做半套差分（水位不动）", async () => {
    const { fetchFn, requests } = annFetch(annListBody(), { contentStatus: 403 });
    const report = await runAnnouncementPollBatch(
      genshin,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      { fetchFn },
    );
    expect(report.status).toBe("maintenance-required");
    expect(report.diff).toBeNull();
    expect(report.nextState).toBe(INITIAL_SOURCE_POLL_STATE);
    expect(requests).toHaveLength(2);
  });
});

describe("A-P3-FETCH 米游社批次：三类型游标与标题级差分", () => {
  function miyousheFetch(routes: Array<{ type: string; body: unknown; status?: number }>): {
    fetchFn: typeof fetch;
    requests: string[];
  } {
    const requests: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(String(input));
      const route = routes.find((candidate) => candidate.type === url.searchParams.get("type"));
      if (route === undefined || route.status !== undefined) {
        const status = route?.status ?? 404;
        return new Response(JSON.stringify({ message: "blocked" }), {
          status,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(JSON.stringify(route.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fetchFn, requests };
  }

  const typePages = [
    { type: "1", body: (newsType1Page1 as { body: unknown }).body },
    { type: "2", body: (newsType2Page1 as { body: unknown }).body },
    { type: "3", body: (newsType3Page1 as { body: unknown }).body },
  ];

  it("首批：三类型各一页（每批上限），全部记为新增，游标保存", async () => {
    const { fetchFn, requests } = miyousheFetch(typePages);
    const report = await runMiyoushePollBatch(miyoushe, INITIAL_SOURCE_POLL_STATE, CAPTURED_AT_MS, {
      fetchFn,
    });
    expect(report.status).toBe("ok");
    expect(report.complete).toBe(false); // 三页都未到 is_last（真实样本）
    expect(requests).toHaveLength(3);
    for (const newsType of ["1", "2", "3"] as const) {
      expect(report.perType[newsType].added).toHaveLength(20);
      expect(report.perType[newsType].status).toBe("ok");
      expect(report.perType[newsType].nextScan.lastId).toBe("20");
      expect(report.perType[newsType].nextScan.reachedLast).toBe(false);
    }
    const watermark = report.nextState.watermark as MiyousheWatermark;
    expect(watermark.model).toBe("last-id-offset");
    expect(Object.keys(watermark.scans["1"].fingerprints)).toHaveLength(20);
    expect(report.nextState.lastPollCompletedAtMs).toBe(CAPTURED_AT_MS);
  });

  it("补漏续扫：保存的游标透传（last_id=20 → type1 第二页）", async () => {
    const { fetchFn, requests } = miyousheFetch([
      { type: "1", body: (newsType1Page2 as { body: unknown }).body },
      { type: "2", body: (newsType2Page1 as { body: unknown }).body },
      { type: "3", body: (newsType3Page1 as { body: unknown }).body },
    ]);
    const type1Url = () =>
      new URL(requests.find((r) => new URL(r).searchParams.get("type") === "1") ?? "");
    const firstBatch = await runMiyoushePollBatch(
      miyoushe,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      {
        fetchFn: miyousheFetch(typePages).fetchFn,
      },
    );
    const secondBatch = await runMiyoushePollBatch(
      miyoushe,
      firstBatch.nextState,
      CAPTURED_AT_MS + 1000,
      {
        fetchFn,
      },
    );
    expect(secondBatch.status).toBe("ok");
    expect(type1Url().searchParams.get("last_id")).toBe("20");
    expect(secondBatch.perType["1"].nextScan.lastId).toBe("40");
  });

  it("稳态（曾到 is_last）：每批从最新页重叠重扫，改标题可见为 changed", async () => {
    const firstBatch = await runMiyoushePollBatch(
      miyoushe,
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      {
        fetchFn: miyousheFetch(typePages).fetchFn,
      },
    );
    // 稳态重扫（同一样本 → 无新增无变化）。
    const steady = miyousheFetch(typePages);
    const steadyBatch = await runMiyoushePollBatch(
      miyoushe,
      asReachedLast(firstBatch.nextState),
      CAPTURED_AT_MS + 1000,
      {
        fetchFn: steady.fetchFn,
      },
    );
    expect(steadyBatch.status).toBe("ok");
    for (const newsType of ["1", "2", "3"] as const) {
      expect(steadyBatch.perType[newsType].added).toEqual([]);
      expect(steadyBatch.perType[newsType].changed).toEqual([]);
    }
    expect(new URL(steady.requests[0]).searchParams.get("last_id")).toBe("");

    // 改第一个条目的标题 → 标题级 changed 可见。
    const body = structuredClone((newsType1Page1 as { body: { data: { list: unknown[] } } }).body);
    const firstItem = body.data.list[0] as { post: Record<string, unknown> };
    firstItem.post.subject = `${String(firstItem.post.subject)}（更新）`;
    const changedFetch = miyousheFetch([
      { type: "1", body },
      { type: "2", body: (newsType2Page1 as { body: unknown }).body },
      { type: "3", body: (newsType3Page1 as { body: unknown }).body },
    ]);
    const changedBatch = await runMiyoushePollBatch(
      miyoushe,
      steadyBatch.nextState,
      CAPTURED_AT_MS + 2000,
      {
        fetchFn: changedFetch.fetchFn,
      },
    );
    expect(changedBatch.status).toBe("ok");
    expect(changedBatch.perType["1"].added).toEqual([]);
    expect(changedBatch.perType["1"].changed).toHaveLength(1);
    expect(changedBatch.perType["1"].changed[0]?.externalId).toBe(String(firstItem.post.post_id));
  });

  it("单类型 403：整体 maintenance-required；每类型仍只请求一次（不重试）", async () => {
    const { fetchFn, requests } = miyousheFetch([
      { type: "1", body: null, status: 403 },
      { type: "2", body: (newsType2Page1 as { body: unknown }).body },
      { type: "3", body: (newsType3Page1 as { body: unknown }).body },
    ]);
    const report = await runMiyoushePollBatch(miyoushe, INITIAL_SOURCE_POLL_STATE, CAPTURED_AT_MS, {
      fetchFn,
    });
    expect(report.status).toBe("maintenance-required");
    expect(report.perType["1"].failure).toMatchObject({ kind: "restricted", status: 403 });
    expect(report.perType["2"].status).toBe("ok");
    expect(requests).toHaveLength(3);
  });
});

/** 把米游社状态的三个扫描标记为"曾到 is_last"（稳态构造辅助）。 */
function asReachedLast(state: SourcePollState): SourcePollState {
  const watermark = state.watermark;
  if (watermark === null || watermark.model !== "last-id-offset") {
    throw new Error("测试辅助要求米游社水位");
  }
  const scans = { ...watermark.scans };
  for (const newsType of ["1", "2", "3"] as const) {
    scans[newsType] = { ...scans[newsType], lastId: null, reachedLast: true };
  }
  return { ...state, watermark: { model: "last-id-offset", scans } };
}
