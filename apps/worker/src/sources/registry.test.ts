// 来源注册表漂移校验（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 生产注册表（sources/registry.ts）是 P0-02 登记产物的类型化转录；本测试导入两份原始
// JSON（fixtures/sources/registry.draft.json、scripts/probes/source-samples/sources.verified.json）
// 与 contracts 参数注册表做逐字段比对——转录与登记不一致即失败（沿 P1-04 expected-schema
// 同步约定：宁可测试红，不要悄悄漂移）。
// JSON 导入在当前工具链（tsgo bundler 解析 + vite 运行时）直接可用且类型化，无需开关。

import {
  SOURCE_HOT_POLL,
  SOURCE_LIMIT_PROFILE,
  SOURCE_POLL,
  SOURCE_RECHECK_INTERVAL,
  SOURCE_RECHECK_WINDOW,
} from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import genshinContent from "../../../../fixtures/sources/genshin-ann/content-21819.json";
import genshinIndex from "../../../../fixtures/sources/genshin-ann/index.json";
import hsrContent from "../../../../fixtures/sources/hsr-ann/content-1195.json";
import hsrIndex from "../../../../fixtures/sources/hsr-ann/index.json";
import miyousheType2 from "../../../../fixtures/sources/miyoushe-news/news-list-type2-page1.json";
import registryDraft from "../../../../fixtures/sources/registry.draft.json";
import zzzContent from "../../../../fixtures/sources/zzz-ann/content-1301.json";
import zzzIndex from "../../../../fixtures/sources/zzz-ann/index.json";
import sourcesVerified from "../../../../scripts/probes/source-samples/sources.verified.json";
import { getSourceEntry, listSourceEntries, SOURCE_REGISTRY } from "./registry";

const draft = registryDraft as { sources: Array<Record<string, unknown>> };
const verified = sourcesVerified as { sources: Array<Record<string, unknown>> };
const annIndexes: Record<string, { list_observation: { page_size: number } }> = {
  "genshin-ann": genshinIndex as { list_observation: { page_size: number } },
  "hsr-ann": hsrIndex as { list_observation: { page_size: number } },
  "zzz-ann": zzzIndex as { list_observation: { page_size: number } },
};

const contentSamples: Record<string, { body: { data: { list: unknown[] } } }> = {
  "genshin-ann": genshinContent,
  "hsr-ann": hsrContent,
  "zzz-ann": zzzContent,
};

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const roundToBlock = (bytes: number): number => Math.ceil(bytes / (64 * 1024)) * 64 * 1024;

function draftEntry(sourceId: string): Record<string, unknown> {
  const found = draft.sources.find((source) => source.source_id === sourceId);
  expect(found, `registry.draft.json 应含 ${sourceId}`).toBeDefined();
  return found as Record<string, unknown>;
}

function verifiedEntry(sourceId: string): Record<string, unknown> {
  const found = verified.sources.find((source) => source.source_id === sourceId);
  expect(found, `sources.verified.json 应含 ${sourceId}`).toBeDefined();
  return found as Record<string, unknown>;
}

function limitsOf(sourceId: string): Record<string, unknown> {
  return draftEntry(sourceId).limit_profile_measured as Record<string, unknown>;
}

describe("A-P3-FETCH 来源注册表与 P0-02 登记零漂移", () => {
  it("登记草案的每个来源都在生产注册表内，字段逐项一致", () => {
    expect(listSourceEntries().map((entry) => entry.sourceId)).toEqual(
      draft.sources.map((source) => source.source_id),
    );
    for (const entry of SOURCE_REGISTRY) {
      const draftSource = draftEntry(entry.sourceId);
      expect(entry.game).toBe(draftSource.game);
      expect(entry.region).toBe(draftSource.region);
      expect(entry.approvedHosts).toEqual(draftSource.approved_hosts);
      // verified_publishers 为空是 P0-02 实测结论（公告无发布者字段；米游社 uid="0"）——照搬。
      expect(entry.verifiedPublishers).toEqual(draftSource.verified_publishers);
      expect(entry.verificationState).toBe(draftSource.verification_state);
      expect(entry.lastSuccessAtUtc).toBe(draftSource.last_success_at_utc);
      expect((draftSource.adapter as string).startsWith(entry.adapterId)).toBe(true);
      expect((draftSource.cursor as Record<string, unknown>).model).toBe(entry.cursorModel);
      expect((draftSource.cursor as Record<string, unknown>).external_id_field).toBe(
        entry.externalIdField,
      );
    }
  });

  it("轮询/复查间隔与 contracts 参数注册表及登记草案三方一致（不写第二份）", () => {
    for (const entry of SOURCE_REGISTRY) {
      const policy = draftEntry(entry.sourceId).poll_policy as Record<string, number>;
      expect(entry.pollPolicy.pollIntervalS).toBe(SOURCE_POLL);
      expect(entry.pollPolicy.pollIntervalS).toBe(policy.poll_interval_s);
      expect(entry.pollPolicy.hotPollIntervalS).toBe(SOURCE_HOT_POLL);
      expect(entry.pollPolicy.hotPollIntervalS).toBe(policy.hot_poll_interval_s);
      if (entry.pollPolicy.recheckWindowDays === null) {
        expect(policy.recheck_window_days).toBeUndefined();
        expect(entry.pollPolicy.recheckIntervalS).toBeNull();
        expect(policy.recheck_interval_s).toBeUndefined();
      } else {
        expect(entry.pollPolicy.recheckWindowDays).toBe(SOURCE_RECHECK_WINDOW);
        expect(entry.pollPolicy.recheckWindowDays).toBe(policy.recheck_window_days);
        expect(entry.pollPolicy.recheckIntervalS).toBe(SOURCE_RECHECK_INTERVAL);
        expect(entry.pollPolicy.recheckIntervalS).toBe(policy.recheck_interval_s);
      }
    }
  });

  it("A-P3-TRUNCATE 请求上限来自 SOURCE_LIMIT_PROFILE 且高于观测峰值、低于统一安全界", () => {
    for (const entry of SOURCE_REGISTRY) {
      const limits = limitsOf(entry.sourceId);
      expect(entry.requestLimits.timeoutMs).toBe(limits.request_timeout_recommend_ms);
      const registeredCaps = SOURCE_LIMIT_PROFILE.responseCapsBytes as Readonly<
        Record<string, number>
      >;
      expect(entry.requestLimits.maxResponseBytes).toBe(registeredCaps[entry.sourceId]);
      expect(entry.requestLimits.maxResponseBytes).toBeGreaterThan(0);
      expect(entry.requestLimits.maxResponseBytes).toBeLessThanOrEqual(
        SOURCE_LIMIT_PROFILE.responseCapCeilingBytes,
      );
      if (entry.adapterKind === "announcement-webview") {
        expect(entry.requestLimits.maxResponseBytes).toBeGreaterThan(
          limits.max_observed_content_bytes as number,
        );
        expect(entry.requestLimits.listPageSizeCap).toBeNull();
      } else {
        // 米游社无正文（403 停用）：上限取列表实测区间上界（"50,056–110,546 B（…）"）。
        const range = limits.list_response_bytes_observed_range as string;
        const numbers = range.match(/\d[\d,]*/g)?.map((raw) => Number(raw.replace(/,/g, ""))) ?? [];
        expect(entry.requestLimits.maxResponseBytes).toBeGreaterThan(Math.max(...numbers));
        expect(entry.requestLimits.listPageSizeCap).toBe(limits.batch_upper_bound_items);
      }
    }
  });

  it("A-P3-TRUNCATE 余量按公告一批增长和最大单篇、列表最大卡片推导，非任意倍数", () => {
    for (const [sourceId, sample] of Object.entries(contentSamples)) {
      const observed = limitsOf(sourceId).max_observed_content_bytes as number;
      const items = sample.body.data.list;
      const sampleBytes = utf8Bytes(sample.body);
      const largestItemBytes = Math.max(...items.map(utf8Bytes));
      const pageSize = annIndexes[sourceId].list_observation.page_size;
      const projected =
        observed +
        Math.ceil((observed / items.length) * pageSize) +
        Math.ceil((largestItemBytes / sampleBytes) * observed);
      expect(getSourceEntry(sourceId).requestLimits.maxResponseBytes).toBe(roundToBlock(projected));
    }
    const miyousheItems = (miyousheType2 as { body: { data: { list: unknown[] } } }).body.data.list;
    const observedRange = limitsOf("miyoushe-news").list_response_bytes_observed_range as string;
    const observed = Math.max(
      ...(observedRange.match(/\d[\d,]*/g)?.map((value) => Number(value.replace(/,/g, ""))) ?? []),
    );
    expect(getSourceEntry("miyoushe-news").requestLimits.maxResponseBytes).toBe(
      roundToBlock(observed + Math.max(...miyousheItems.map(utf8Bytes))),
    );
  });

  it("请求形状沿用 sources.verified.json 的已核验参数集（level/uid 门控不自行调整，ADR-0001）", () => {
    for (const entry of SOURCE_REGISTRY) {
      const verifiedSource = verifiedEntry(entry.sourceId);
      const list = verifiedSource.list as Record<string, unknown>;
      if (entry.adapterKind === "announcement-webview") {
        expect(entry.request.listPath).toBe(list.path);
        expect({ ...entry.request.listParams }).toEqual(list.params);
        expect(entry.request.contentPath).toBe(
          (verifiedSource.content as Record<string, unknown>).path,
        );
      } else {
        expect(entry.request.listPath).toBe(list.path);
        expect({ ...entry.request.listParams }).toEqual(list.params);
      }
    }
  });

  it("公告源分页参数与 P0-02 已核验请求形状一致（服务端忽略，page_size 取采集实测值）", () => {
    for (const [sourceId, index] of Object.entries(annIndexes)) {
      const entry = getSourceEntry(sourceId);
      expect(entry.adapterKind).toBe("announcement-webview");
      if (entry.adapterKind !== "announcement-webview") continue;
      expect(entry.request.paginationParams).toEqual({
        page: "1",
        page_size: String(index.list_observation.page_size),
      });
    }
  });

  it("米游社正文通道由 verification_state 推导为停用（403 访问控制，不绕过）", () => {
    const miyoushe = getSourceEntry("miyoushe-news");
    expect(miyoushe.verificationState).toBe("maintenance-required-list-only");
    expect(miyoushe.contentChannelDisabled).toBe(true);
    expect(draftEntry("miyoushe-news").maintenance_reason).toContain("403");
    for (const sourceId of ["genshin-ann", "hsr-ann", "zzz-ann"]) {
      expect(getSourceEntry(sourceId).contentChannelDisabled).toBe(false);
    }
  });

  it("未知来源拒绝：不在登记内即抛错", () => {
    expect(() => getSourceEntry("not-a-source")).toThrow(/未知来源/);
  });
});
