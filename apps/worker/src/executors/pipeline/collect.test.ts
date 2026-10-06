// A-P3-PIC-LIST · 采集组合：图文资讯目录（data.pic_list）进入文章版本计划（ADR-0016）。
// 样本来自 P0-02 真实抓取（synthetic:false），fetch 替身回放，不发真实网络请求。

import { describe, expect, it } from "vitest";
import hsrContent from "../../../../../fixtures/sources/hsr-ann/content-1430.json";
import hsrList from "../../../../../fixtures/sources/hsr-ann/list-page-1.json";
import zzzContent from "../../../../../fixtures/sources/zzz-ann/content-1296.json";
import zzzList from "../../../../../fixtures/sources/zzz-ann/list-page-1.json";
import { PIC_LIST_ID_PREFIX } from "../../sources/adapters/announcement";
import type { ArticleIngestPlan } from "../../sources/articles/ingest";
import { getSourceEntry } from "../../sources/registry";
import { collectSource } from "./collect";
import { INITIAL_SOURCE_POLL_STATE } from "./source-poll";

const CAPTURED_AT_MS = Date.parse("2026-09-21T17:41:54Z");

/** getAnnList → 列表样本；getAnnContent → 正文样本。 */
function replay(list: { body: unknown }, content: { body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const isList = new URL(String(input)).pathname.endsWith("getAnnList");
    return new Response(JSON.stringify(isList ? list.body : content.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function versions(plans: readonly ArticleIngestPlan[]) {
  return new Map(
    plans.flatMap((plan) => (plan.kind === "version" ? [[plan.plan.externalId, plan.plan]] : [])),
  );
}

const titleOf = (blocks: readonly { kind: string; text?: string }[]) =>
  blocks.find((block) => block.kind === "title")?.text;

interface PicListBody {
  data: {
    pic_list: Array<{ type_list: Array<{ list: Array<{ ann_id: number; title: string }> }> }>;
  };
}
/** 列表样本里给一条图文资讯补上标题（模拟官方之后补写）。 */
function withPicTitle(list: { body: unknown }, annId: number, title: string): { body: unknown } {
  const body = structuredClone(list.body) as PicListBody;
  for (const group of body.data.pic_list)
    for (const typeGroup of group.type_list)
      for (const item of typeGroup.list) if (item.ann_id === annId) item.title = title;
  return { body };
}

describe("A-P3-PIC-LIST 采集：图文资讯条目建成文章版本，正文与时间齐全", () => {
  it("A-P3-PIC-IMAGE-ONLY 崩铁：跃迁公告带正文进入版本计划；空标题空正文的图片条目不入库，补上标题后按变更入库", async () => {
    const page = await collectSource(
      getSourceEntry("hsr-ann"),
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      replay(hsrList, hsrContent),
    );
    expect(page.status).toBe("ok");
    const byId = versions(page.plans);
    expect(byId.size).toBe(24);
    const warp = byId.get(`${PIC_LIST_ID_PREFIX}1331`);
    expect(warp?.completeness).toBe("complete");
    expect(titleOf(warp?.blocks ?? [])).toBe("4.5版本活动跃迁（其二）");
    // 正文块原样保真（含官方转义的时间标签）。
    expect(JSON.stringify(warp?.blocks)).toContain("本期活动跃迁时间为");
    expect(JSON.stringify(warp?.blocks)).toContain("2026/09/28 03:59:00");
    // 1344 只有一张图片：没有标题、正文没有文字，不入库（P3-24）。
    expect(byId.has(`${PIC_LIST_ID_PREFIX}1344`)).toBe(false);

    // 同一份响应再轮询一次：图文资讯条目指纹稳定，不产生新版本计划（被跳过的图片条目也已记入列表快照）。
    const again = await collectSource(
      getSourceEntry("hsr-ann"),
      page.nextState,
      CAPTURED_AT_MS + 60_000,
      replay(hsrList, hsrContent),
    );
    expect(again.plans).toEqual([]);

    // 官方之后补上标题：按列表变更重新取正文，这次入库（正文仍空，记来源暂空等人工）。
    const titled = await collectSource(
      getSourceEntry("hsr-ann"),
      again.nextState,
      CAPTURED_AT_MS + 120_000,
      replay(withPicTitle(hsrList, 1344, "4.6版本前瞻海报"), hsrContent),
    );
    const late = versions(titled.plans).get(`${PIC_LIST_ID_PREFIX}1344`);
    expect(late?.completeness).toBe("gap-source-empty");
    expect(titleOf(late?.blocks ?? [])).toBe("4.6版本前瞻海报");
  });

  it("绝区零：撞号的 238 与图文资讯 238 是两篇文章，标题去噪后各自对应正文", async () => {
    const page = await collectSource(
      getSourceEntry("zzz-ann"),
      INITIAL_SOURCE_POLL_STATE,
      CAPTURED_AT_MS,
      replay(zzzList, zzzContent),
    );
    const byId = versions(page.plans);
    // 24 条里图文资讯 247 只有一张图片（与 2026-10-06 线上同一条），不入库。
    expect(byId.size).toBe(23);
    expect(byId.has(`${PIC_LIST_ID_PREFIX}247`)).toBe(false);
    const forum = byId.get("238");
    const signal = byId.get(`${PIC_LIST_ID_PREFIX}238`);
    expect(titleOf(forum?.blocks ?? [])).toBe("绳网认证分部一览");
    expect(titleOf(signal?.blocks ?? [])).toBe("3.2版本限时频段（上期）");
    expect(JSON.stringify(signal?.blocks)).toContain("调频活动时间");
    expect(JSON.stringify(forum?.blocks)).not.toContain("调频活动时间");
  });
});
