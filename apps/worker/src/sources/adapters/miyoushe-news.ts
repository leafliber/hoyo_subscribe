// 米游社官方资讯适配器（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 采集模型（P0-02 实测，docs/evidence/p0/source-params.md §3）：
//   - 列表现行为 painter/wapi/getNewsList（post/wapi/getNewsList 已 404）；
//     last_id 是**偏移量式游标**（page_size=20 时 20/40/60 递进），不是帖子 id；
//     响应带 is_last。三类型（1=公告 2=活动 3=资讯）各自独立游标。
//   - page_size 超范围回落 20；文档区间 1-50 但 50 未单测——生产沿用实测批量上限 20。
//   - getPostFull 返回 403 访问控制：来源按 maintenance-required-list-only 登记，
//     **fetchArticle 不发任何请求**，直接返回 channel-unavailable——不重试、不换路径、
//     不 UA 伪装、不借第三方聚合后端（AGENTS.md 规则 6）。
//   - 列表条目 uid="0" 不携带发布者身份 → publisherUid=null，verified_publishers 空是实测结论。
//
// 本适配器只产出标题/图片级信息，不声称有正文（hasContent=null，正文通道维护态）。

import { classifyRestriction } from "../guarded-fetch";
import type { MiyousheNewsSourceEntry } from "../registry";
import type {
  ArticleFetchResult,
  ArticleRef,
  ListEnvelopeInfo,
  ListResult,
  MiyousheNewsType,
  SourceAdapter,
  SourceCursor,
  SourceFetchFailure,
  SourceItemStub,
} from "../types";
import type { AdapterDeps } from "./announcement";
import {
  asExternalId,
  asNullableString,
  buildSourceUrl,
  fetchJsonBody,
  parseEnvelope,
} from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** 每类型一个适配器实例（三类型独立游标）；所有请求走 approved_hosts[0]。 */
export function createMiyousheNewsAdapter(
  entry: MiyousheNewsSourceEntry,
  newsType: MiyousheNewsType,
  deps: AdapterDeps = {},
): SourceAdapter {
  if (!entry.newsTypes.includes(newsType)) {
    throw new TypeError(`来源 ${entry.sourceId} 未登记列表类型 ${newsType}`);
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const host = entry.approvedHosts[0];
  const pageCap = entry.requestLimits.listPageSizeCap;
  if (pageCap === null) {
    throw new TypeError(
      `来源 ${entry.sourceId} 登记缺批量上限（limit_profile batch_upper_bound_items）`,
    );
  }

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

    async list(cursor: SourceCursor | null, limit: number): Promise<ListResult> {
      if (cursor !== null && (cursor.model !== "last-id-offset" || cursor.newsType !== newsType)) {
        throw new TypeError(
          `来源 ${entry.sourceId} 类型 ${newsType} 的游标不匹配：${JSON.stringify(cursor)}`,
        );
      }
      // limit → page_size，被限制在实测批量上限内（超范围服务端回落 20，宁可选小）。
      const pageSize = Math.max(1, Math.min(Math.floor(limit), pageCap));
      const lastId = cursor === null ? "" : cursor.lastId;
      const url = buildSourceUrl(host, entry.request.listPath, {
        ...entry.request.listParams,
        type: newsType,
        last_id: lastId,
        page_size: String(pageSize),
      });
      const fetched = await fetchJsonBody(entry, url, fetchFn);
      if ("failure" in fetched) {
        return failureResult(fetched.failure);
      }
      const envelope = parseEnvelope(fetched.body.bodyText);
      if (!envelope.ok) {
        return failureResult({
          kind: "malformed-body",
          detail: "米游社信封解析失败（非 JSON 或无 retcode）",
        });
      }
      const envelopeInfo: ListEnvelopeInfo = {
        retcode: envelope.retcode,
        message: envelope.message,
        timezone: null,
        total: null,
        typeLabels: [],
      };
      if (envelope.retcode !== 0) {
        const restrictionSignals = classifyRestriction(200, envelope.message);
        return {
          items: [],
          nextCursor: null,
          complete: false,
          envelope: envelopeInfo,
          failure:
            restrictionSignals.length > 0
              ? { kind: "restricted", status: 200, signals: restrictionSignals }
              : { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
          skippedItems: 0,
        };
      }
      const data = envelope.data;
      const rawItems = Array.isArray(data.list) ? data.list : [];
      const lastIdRaw = data.last_id;
      const isLast = data.is_last === true;
      if (
        typeof lastIdRaw !== "string" &&
        typeof lastIdRaw !== "number" &&
        lastIdRaw !== undefined &&
        lastIdRaw !== null
      ) {
        return failureResult({
          kind: "malformed-body",
          detail: "last_id 形状异常（非字符串/数值）",
        });
      }

      const stubs: SourceItemStub[] = [];
      let skipped = 0;
      for (const raw of rawItems) {
        if (!isRecord(raw) || !isRecord(raw.post)) {
          skipped += 1;
          continue;
        }
        const post = raw.post as Record<string, unknown>;
        const externalId = asExternalId(post.post_id);
        if (externalId === null) {
          skipped += 1;
          continue;
        }
        const cover = isRecord(raw.cover) ? asNullableString(raw.cover.url) : null;
        const imageUrls = Array.isArray(raw.image_list)
          ? raw.image_list
              .filter(isRecord)
              .map((image) => asNullableString(image.url))
              .filter((url): url is string => url !== null)
          : [];
        const uidRaw = asNullableString(post.uid);
        const createdAtSec = post.created_at;
        const publishedAtMs =
          typeof createdAtSec === "number" && Number.isFinite(createdAtSec)
            ? createdAtSec * 1000
            : null;
        stubs.push({
          sourceId: entry.sourceId,
          externalId,
          title: asNullableString(post.subject) ?? "",
          subtitle: null,
          typeLabel: null,
          tagLabel: null,
          listStartTime: null,
          listEndTime: null,
          bannerUrl: null,
          coverUrl: cover,
          imageUrls,
          // uid="0" 是哑值：不携带发布者身份（P0-02 §3），verified_publishers 为空。
          publisherUid: uidRaw === null || uidRaw === "0" ? null : uidRaw,
          // 正文通道维护态：不声称有正文。
          hasContent: null,
          publishedAtMs,
        });
      }

      // complete 按游标推进判定：is_last=true 才是扫描范围真的完成（P0-02：响应含 is_last 布尔）。
      if (!isLast && (lastIdRaw === undefined || lastIdRaw === null)) {
        return failureResult({
          kind: "malformed-body",
          detail: "未到 is_last 但响应缺 last_id（游标无法推进）",
        });
      }
      const nextCursor =
        isLast || lastIdRaw === undefined || lastIdRaw === null
          ? null
          : { model: "last-id-offset" as const, newsType, lastId: String(lastIdRaw) };
      return {
        items: stubs,
        nextCursor,
        complete: isLast,
        envelope: envelopeInfo,
        failure: null,
        skippedItems: skipped,
      };
    },

    async fetchArticle(ref: ArticleRef): Promise<ArticleFetchResult> {
      // getPostFull 403 访问控制（P0-02 §3）：正文通道已停用。不发请求、不重试、不换路径。
      return {
        status: "channel-unavailable",
        sourceId: entry.sourceId,
        externalId: ref.externalId,
        reason:
          "正文接口 post/wapi/getPostFull 被 403 访问控制拦截（P0-02，诚实探针 UA、无凭据、两台官方主机一致）；来源按 maintenance-required-list-only 登记，仅贡献标题/图片级信息",
      };
    },
  };
}
