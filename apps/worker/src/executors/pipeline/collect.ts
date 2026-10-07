// P3-11：组合 P3-01 已读取结果与 P3-02/P3-08 的版本计划，不另发正文请求。
import { PIC_LIST_ID_PREFIX } from "../../sources/adapters/announcement";
import { bodyHasVisibleText, denoiseTitle, splitBodyBlocks } from "../../sources/articles/blocks";
import { type ArticleIngestPlan, buildArticleIngestPlan } from "../../sources/articles/ingest";
import type { SourceRegistryEntry } from "../../sources/registry";
import type { ArticleFetchResult, SourceItemStub } from "../../sources/types";
import { collectLiveSource, type RedeemUpdate } from "./collect-live";
import { isRecheckDue, runAnnouncementPollBatch, type SourcePollState } from "./source-poll";

/**
 * P3-24（ADR-0019，修改 ADR-0016 的"记来源暂空、不丢弃"）：图文资讯里只有一张图片的条目
 * （标题为空、正文没有可读文字）不入库。
 * 本站不识别图片里的文字，入库只会产生无从核对的空候选；列表快照照常记下它，
 * 之后官方补上标题或正文时按"变更"重新取正文入库。公告目录（data.list）不受影响。
 */
function isImageOnlyPicItem(stub: SourceItemStub, fetched: ArticleFetchResult): boolean {
  if (!stub.externalId.startsWith(PIC_LIST_ID_PREFIX) || fetched.status !== "fetched") return false;
  if (denoiseTitle(fetched.title || stub.title) !== "") return false;
  return !bodyHasVisibleText(splitBodyBlocks(fetched.contentHtml));
}
export interface CollectedPage {
  plans: ArticleIngestPlan[];
  nextState: SourcePollState;
  status: "ok" | "incomplete" | "maintenance-required";
  backfill: boolean;
  /** ADR-0030：直播兑换码来源本次的兑换码与已结束的活动；runtime 落页时写入 redeem_codes 后删去。 */
  redeem?: RedeemUpdate;
  /** ADR-0030：有尚未发放的兑换码时下一次采集的时刻；没有则按常规间隔。 */
  nextPollAtMs?: number | null;
}
export async function collectSource(
  entry: SourceRegistryEntry,
  state: SourcePollState,
  now: number,
  fetchFn: typeof fetch,
  liveHints: readonly string[] = [],
): Promise<CollectedPage> {
  if (entry.adapterKind === "miyolive")
    return collectLiveSource(entry, state, now, fetchFn, liveHints);
  // 首轮（还没有水位）是历史补录：入账但不发新事件通知。
  const backfill = state.watermark === null;
  const plans: ArticleIngestPlan[] = [];
  const report = await runAnnouncementPollBatch(entry, state, now, { fetchFn });
  const changed = new Set([
    ...(report.diff?.added ?? []),
    ...(report.diff?.changed.map((item) => item.externalId) ?? []),
  ]);
  const recheck = isRecheckDue(entry, state, now);
  for (const stub of report.items) {
    const set = report.contentSet;
    if (set === undefined || report.status === "maintenance-required") break;
    let fetched: ArticleFetchResult;
    if ("failure" in set) {
      if (set.failure.kind !== "response-too-large") break;
      fetched = {
        status: "truncated",
        sourceId: entry.sourceId,
        externalId: stub.externalId,
        observedAtLeastBytes: set.failure.bytes,
        capBytes: set.failure.cap,
      };
    } else {
      // 全集复查同时覆盖近期公告和仍关联活跃节点的旧公告，不按最大 ID 筛除。
      if (!recheck && !changed.has(stub.externalId)) continue;
      const content = set.entries.get(stub.externalId);
      fetched =
        content === undefined
          ? {
              status: "missing-from-content-set",
              sourceId: entry.sourceId,
              externalId: stub.externalId,
              note: "content_set_missing",
            }
          : {
              status: "fetched",
              sourceId: entry.sourceId,
              externalId: stub.externalId,
              title: content.title,
              contentHtml: content.contentHtml,
              contentSha256: content.contentSha256,
              signals: content.signals,
              fetchedAtMs: now,
            };
    }
    if (isImageOnlyPicItem(stub, fetched)) continue;
    plans.push(await buildArticleIngestPlan(entry, stub, fetched, now));
  }
  return {
    plans,
    nextState: {
      ...report.nextState,
      lastRecheckCompletedAtMs: recheck
        ? report.nextState.lastRecheckCompletedAtMs
        : state.lastRecheckCompletedAtMs,
    },
    status: report.status,
    backfill,
  };
}
