// P3-11：组合 P3-01 已读取结果与 P3-02/P3-08 的版本计划，不另发正文请求。
import { type ArticleIngestPlan, buildArticleIngestPlan } from "../../sources/articles/ingest";
import type { SourceRegistryEntry } from "../../sources/registry";
import type { ArticleFetchResult } from "../../sources/types";
import { isRecheckDue, runAnnouncementPollBatch, type SourcePollState } from "./source-poll";
export interface CollectedPage {
  plans: ArticleIngestPlan[];
  nextState: SourcePollState;
  status: "ok" | "incomplete" | "maintenance-required";
  backfill: boolean;
}
export async function collectSource(
  entry: SourceRegistryEntry,
  state: SourcePollState,
  now: number,
  fetchFn: typeof fetch,
): Promise<CollectedPage> {
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
