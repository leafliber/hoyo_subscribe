// 公告 API 适配器：genshin-ann / hsr-ann / zzz-ann（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 采集模型（P0-02 实测，docs/evidence/p0/source-params.md §2）：
//   - getAnnList 不分页：page/page_size 被服务端忽略，单请求返回全部存续公告
//     （page=2 与 page=1 相同）→ **每请求全量快照 + ann_id 差分**，不存在页码游标。
//   - getAnnContent 同样忽略 announcement_id，单次返回全部正文（实测约 254 KiB）→
//     fetchArticle 内部做一次全量正文拉取并按 ann_id 选取；**不实现不存在的单篇通道**，
//     SOURCE_RECHECK_WINDOW 的"按篇复查"在此等价于全量重拉。
//   - 正文里的时间高亮是转义标签（&lt;t class="t_gl"&gt;），contentHtml 原样保真。
//   - zzz 列表 title 含 HTML：保真透出，去噪属 P3-02。
//
// complete 语义：HTTP 200 但 retcode != 0（如 -1003 参数有误）→ complete=false；
// 信封读不出（非 JSON / 无 retcode）→ complete=false。列表声称 has_content 但全量正文
// 响应缺该条 → missing-from-content-set（缺口原料，交给 P3-02，不转成"无活动"）。

import { classifyRestriction } from "../guarded-fetch";
import type { AnnouncementSourceEntry } from "../registry";
import { sha256Hex } from "../snapshot-diff";
import type {
  ArticleCompletenessSignals,
  ArticleFetchResult,
  ArticleRef,
  ListEnvelopeInfo,
  ListResult,
  SourceAdapter,
  SourceCursor,
  SourceFetchFailure,
  SourceItemStub,
} from "../types";
import {
  asExternalId,
  asNullableString,
  buildSourceUrl,
  fetchJsonBody,
  parseEnvelope,
} from "./shared";

export interface AdapterDeps {
  /** 测试替身可注入；缺省用运行时 fetch。 */
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface RawAnnouncementItem {
  ann_id: unknown;
  title: unknown;
  subtitle: unknown;
  type_label: unknown;
  tag_label: unknown;
  banner: unknown;
  content: unknown;
  start_time: unknown;
  end_time: unknown;
  has_content: unknown;
  /** 分组结构（getAnnList 的 data.list[].list）才有的字段。 */
  list?: unknown;
}

function isRawItem(value: unknown): value is RawAnnouncementItem {
  return value !== null && typeof value === "object";
}

/** getAnnList 的 data.list 是"按 type 分组"的二维结构；getAnnContent 是扁平数组（两种都识别，P0-02）。 */
function flattenAnnouncementList(data: Record<string, unknown>): {
  typeLabels: string[];
  items: unknown[];
} {
  const rawList = Array.isArray(data.list) ? data.list : [];
  const isGrouped =
    rawList.length > 0 && rawList.every((group) => isRawItem(group) && Array.isArray(group.list));
  if (isGrouped) {
    const typeLabels: string[] = [];
    const items: unknown[] = [];
    for (const group of rawList as Array<RawAnnouncementItem & { list: unknown[] }>) {
      if (typeof group.type_label === "string") {
        typeLabels.push(group.type_label);
      }
      items.push(...group.list);
    }
    return { typeLabels, items };
  }
  return { typeLabels: [], items: rawList.filter(isRawItem) };
}

function toStub(
  sourceId: string,
  item: RawAnnouncementItem,
): { stub: SourceItemStub } | { skipped: true } {
  const externalId = asExternalId(item.ann_id);
  if (externalId === null) {
    return { skipped: true };
  }
  return {
    stub: {
      sourceId,
      externalId,
      title: asNullableString(item.title) ?? "",
      subtitle: asNullableString(item.subtitle),
      typeLabel: asNullableString(item.type_label),
      tagLabel: asNullableString(item.tag_label),
      listStartTime: asNullableString(item.start_time),
      listEndTime: asNullableString(item.end_time),
      bannerUrl: asNullableString(item.banner),
      coverUrl: null,
      imageUrls: [],
      publisherUid: null,
      hasContent: typeof item.has_content === "boolean" ? item.has_content : null,
      publishedAtMs: null,
    },
  };
}

function countImages(html: string): number {
  return (html.match(/<img\b/gi) ?? []).length;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 全量正文集合中的一条（按 ann_id 选取后）。 */
export interface AnnouncementContentEntry {
  readonly externalId: string;
  readonly title: string;
  readonly contentHtml: string;
  readonly contentSha256: string;
  readonly signals: ArticleCompletenessSignals;
}

/**
 * 一次 getAnnContent = 全部正文（P0-02 §2.2：announcement_id 被忽略，实测约 254 KiB）。
 * 差分与复查都需要整个集合，故以集合为单位拉取一次；fetchArticle 是它在单条上的投影。
 */
export async function fetchAnnouncementContentSet(
  entry: AnnouncementSourceEntry,
  fetchFn: typeof fetch,
): Promise<{ entries: Map<string, AnnouncementContentEntry> } | { failure: SourceFetchFailure }> {
  const url = buildSourceUrl(
    entry.approvedHosts[0],
    entry.request.contentPath,
    entry.request.listParams,
  );
  const fetched = await fetchJsonBody(entry, url, fetchFn);
  if ("failure" in fetched) {
    return { failure: fetched.failure };
  }
  const envelope = parseEnvelope(fetched.body.bodyText);
  if (!envelope.ok) {
    return {
      failure: { kind: "malformed-body", detail: "正文信封解析失败（非 JSON 或无 retcode）" },
    };
  }
  if (envelope.retcode !== 0) {
    const restrictionSignals = classifyRestriction(200, envelope.message);
    return {
      failure:
        restrictionSignals.length > 0
          ? { kind: "restricted", status: 200, signals: restrictionSignals }
          : { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
    };
  }
  const { items } = flattenAnnouncementList(envelope.data);
  const entries = new Map<string, AnnouncementContentEntry>();
  for (const item of items) {
    const externalId = asExternalId((item as RawAnnouncementItem).ann_id);
    if (externalId === null) continue;
    const contentHtml = asNullableString((item as RawAnnouncementItem).content) ?? "";
    entries.set(externalId, {
      externalId,
      title: asNullableString((item as RawAnnouncementItem).title) ?? "",
      contentHtml,
      contentSha256: await sha256Hex(contentHtml),
      signals: {
        contentEmpty: contentHtml.length === 0,
        imageCount: countImages(contentHtml),
        contentBytes: utf8Bytes(contentHtml),
        bodyTruncated: fetched.body.bodyTruncated,
      },
    });
  }
  return { entries };
}

function listEnvelope(
  retcode: number,
  message: string | null,
  data: Record<string, unknown>,
  typeLabels: readonly string[],
): ListEnvelopeInfo {
  return {
    retcode,
    message,
    timezone: typeof data.timezone === "number" ? data.timezone : null,
    total: typeof data.total === "number" ? data.total : null,
    typeLabels,
  };
}

/** 全量快照型适配器。每来源一个实例；所有请求走 approved_hosts[0]。 */
export function createAnnouncementAdapter(
  entry: AnnouncementSourceEntry,
  deps: AdapterDeps = {},
): SourceAdapter {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const host = entry.approvedHosts[0];

  function failureResult(failure: SourceFetchFailure): ListResult {
    return {
      items: [],
      nextCursor: null,
      complete: false,
      envelope: null,
      failure,
      skippedItems: 0,
    };
  }

  return {
    sourceId: entry.sourceId,

    async list(cursor: SourceCursor | null, _limit: number): Promise<ListResult> {
      // 每请求即全集：cursor 无续扫含义（传入其他模型即程序错误）；limit 不截断条目——
      // 服务端忽略分页，截断本地条目=丢条目=伪造"消失"（P0-02 §2.1）。
      if (cursor !== null && cursor.model !== "full-snapshot-per-request") {
        throw new TypeError(`来源 ${entry.sourceId} 是全量快照型，不接受游标 ${cursor.model}`);
      }

      const url = buildSourceUrl(host, entry.request.listPath, {
        ...entry.request.listParams,
        ...entry.request.paginationParams,
      });
      const fetched = await fetchJsonBody(entry, url, fetchFn);
      if ("failure" in fetched) {
        return failureResult(fetched.failure);
      }
      const envelope = parseEnvelope(fetched.body.bodyText);
      if (!envelope.ok) {
        return failureResult({
          kind: "malformed-body",
          detail: "公告信封解析失败（非 JSON 或无 retcode）",
        });
      }
      if (envelope.retcode !== 0) {
        // HTTP 200 但业务码错误：complete 必须为 false（任务卡关键约束）。
        // 信封 message 命中访问限制标记时按 restricted 处理（停用并标维护，不绕过）。
        const restrictionSignals = classifyRestriction(200, envelope.message);
        return {
          items: [],
          nextCursor: null,
          complete: false,
          envelope: listEnvelope(envelope.retcode, envelope.message, envelope.data, []),
          failure:
            restrictionSignals.length > 0
              ? { kind: "restricted", status: 200, signals: restrictionSignals }
              : { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
          skippedItems: 0,
        };
      }
      const { typeLabels, items } = flattenAnnouncementList(envelope.data);
      const stubs: SourceItemStub[] = [];
      let skipped = 0;
      for (const item of items) {
        const converted = toStub(entry.sourceId, item as RawAnnouncementItem);
        if ("stub" in converted) {
          stubs.push(converted.stub);
        } else {
          skipped += 1;
        }
      }
      return {
        items: stubs,
        nextCursor: null,
        complete: true,
        envelope: listEnvelope(envelope.retcode, envelope.message, envelope.data, typeLabels),
        failure: null,
        skippedItems: skipped,
      };
    },

    async fetchArticle(ref: ArticleRef): Promise<ArticleFetchResult> {
      // getAnnContent 忽略 announcement_id（P0-02 §2.2）：不存在单篇通道，
      // fetchArticle 是全量正文集合在单条上的投影（"复查=全量重拉"的落点）。
      const fetchedSet = await fetchAnnouncementContentSet(entry, fetchFn);
      if ("failure" in fetchedSet) {
        return {
          status: "failed",
          sourceId: entry.sourceId,
          externalId: ref.externalId,
          failure: fetchedSet.failure,
        };
      }
      const matched = fetchedSet.entries.get(ref.externalId);
      if (matched === undefined) {
        return {
          status: "missing-from-content-set",
          sourceId: entry.sourceId,
          externalId: ref.externalId,
          note: "全量正文响应中无此 ann_id（列表声称 has_content 时为缺口原料；不转成无活动，P3-02 判定）",
        };
      }
      return {
        status: "fetched",
        sourceId: entry.sourceId,
        externalId: ref.externalId,
        title: matched.title || ref.title || "",
        contentHtml: matched.contentHtml,
        contentSha256: matched.contentSha256,
        signals: matched.signals,
        fetchedAtMs: now(),
      };
    },
  };
}
