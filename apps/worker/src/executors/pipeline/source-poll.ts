// 来源轮询批次与调度判定（任务卡 P3-01，验收 ID A-P3-FETCH；占位 PipelineDO 的采集内核，
// 真实调度接线属后续卡——本卡交付纯编排，状态由调用方持久化）。
//
// 合同依据：主方案 §3.1/§3.2——SOURCE_POLL 常规 / SOURCE_HOT_POLL 热点；保留重叠窗口，
// **不能仅按最大 ID 推进水位**；SOURCE_RECHECK_WINDOW 内近期公告按 SOURCE_RECHECK_INTERVAL
// 复查；分页、补漏保存游标；每批有上限；遇到访问控制停用来源并标维护，不实施绕过。
//
// 公告源批次形状（P0-02 实测）：每批 = getAnnList + getAnnContent 各一次（都是全量快照），
// 整份指纹集合差分；"重叠窗口"= 水位保存整份上次快照。复查即全量重拉（不存在单篇通道）。
// 米游社批次随来源下线删除（ADR-0016）。
//
// 所有间隔来自 @hoyo/contracts（经 sources/registry.ts 的 pollPolicy 引用），本文件零字面常量。

import {
  createAnnouncementAdapter,
  fetchAnnouncementContentSet,
} from "../../sources/adapters/announcement";
import type { AnnouncementSourceEntry, SourceRegistryEntry } from "../../sources/registry";
import {
  advanceFullSnapshotWatermark,
  announcementFingerprint,
  diffSnapshotRecords,
  type FullSnapshotWatermark,
  type SnapshotDiff,
  type SnapshotRecord,
  type SourceWatermark,
} from "../../sources/snapshot-diff";
import type { SourceFetchFailure, SourceItemStub } from "../../sources/types";

export type PollMode = "normal" | "hot";

/** 单来源采集状态（由调用方持久化；watermark 是重叠窗口的载体）。 */
export interface SourcePollState {
  readonly watermark: SourceWatermark | null;
  /** 上次**成功完成**的常规/热点轮询（失败不推进，下一批仍到期）。 */
  readonly lastPollCompletedAtMs: number | null;
  /** 上次近期公告复查完成（公告源每次全量拉取即复查，与此计数一致推进）。 */
  readonly lastRecheckCompletedAtMs: number | null;
  /** ADR-0030：直播兑换码来源正在跟踪的直播活动（公告源没有这一项）。 */
  readonly lives?: readonly TrackedLive[];
}

/** ADR-0030：一个被跟踪的直播活动。官方返回"活动已结束"后记下时刻、不再请求，满跟踪期后移出。 */
export interface TrackedLive {
  readonly actId: string;
  readonly firstSeenAtMs: number;
  readonly closedAtMs: number | null;
}

export const INITIAL_SOURCE_POLL_STATE: SourcePollState = {
  watermark: null,
  lastPollCompletedAtMs: null,
  lastRecheckCompletedAtMs: null,
};

// ---------- 调度判定（纯函数） ----------

/** 轮询间隔：热点模式用 SOURCE_HOT_POLL，常规用 SOURCE_POLL（经来源注册项引用 contracts）。 */
export function pollIntervalSeconds(entry: SourceRegistryEntry, mode: PollMode): number {
  return mode === "hot" ? entry.pollPolicy.hotPollIntervalS : entry.pollPolicy.pollIntervalS;
}

export function isPollDue(
  entry: SourceRegistryEntry,
  state: SourcePollState,
  nowMs: number,
  mode: PollMode,
): boolean {
  if (state.lastPollCompletedAtMs === null) return true;
  return nowMs - state.lastPollCompletedAtMs >= pollIntervalSeconds(entry, mode) * 1000;
}

/** 下次常规/热点到期时刻（从未跑过 → null = 立即）。 */
export function nextPollDueAtMs(
  entry: SourceRegistryEntry,
  state: SourcePollState,
  mode: PollMode,
): number | null {
  if (state.lastPollCompletedAtMs === null) return null;
  return state.lastPollCompletedAtMs + pollIntervalSeconds(entry, mode) * 1000;
}

/** 复查到期：SOURCE_RECHECK_INTERVAL（经来源注册项引用 contracts）。 */
export function isRecheckDue(
  entry: SourceRegistryEntry,
  state: SourcePollState,
  nowMs: number,
): boolean {
  if (state.lastRecheckCompletedAtMs === null) return true;
  return nowMs - state.lastRecheckCompletedAtMs >= entry.pollPolicy.recheckIntervalS * 1000;
}

/**
 * SOURCE_RECHECK_WINDOW 内的"近期公告"筛选：以列表展示时间（UTC+8）为筛选依据——
 * 它是公告可见窗口的起点（P0-02 index.json 的 list_start_time），**不是活动时间**（§3.1）；
 * 解析失败或缺字段时保守纳入（不因解析失败悄悄退出复查跟踪）。
 */
export function selectRecheckCandidates(
  entry: AnnouncementSourceEntry,
  items: readonly SourceItemStub[],
  nowMs: number,
): readonly string[] {
  const windowMs = entry.pollPolicy.recheckWindowDays * 86_400_000;
  return items
    .filter((stub) => {
      const startMs = parseUtc8DisplayTimeMs(stub.listStartTime);
      return startMs === null || nowMs - startMs <= windowMs;
    })
    .map((stub) => stub.externalId);
}

/** "YYYY-MM-DD HH:mm:ss"（UTC+8 展示时间）→ Epoch 毫秒；形状不符返回 null。 */
function parseUtc8DisplayTimeMs(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (match === null) return null;
  const parsed = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`,
  );
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------- 公告源批次 ----------

export interface AnnouncementPollReport {
  /** P3-11：复用本批已限量读取的正文，不为每篇重复请求全集。 */
  readonly contentSet?: Awaited<ReturnType<typeof fetchAnnouncementContentSet>>;
  readonly sourceId: string;
  /** ok=本批完整成功；incomplete=临时失败（水位不动，下批重试）；maintenance-required=访问控制信号（停用并标维护）。 */
  readonly status: "ok" | "incomplete" | "maintenance-required";
  readonly complete: boolean;
  readonly diff: SnapshotDiff | null;
  readonly items: readonly SourceItemStub[];
  readonly recheckCandidates: readonly string[];
  readonly failure: SourceFetchFailure | null;
  readonly nextState: SourcePollState;
}

export interface PollBatchDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * 公告源一批：列表 + 全量正文各一次请求 → 组合指纹（列表字段 + 正文 hash）→ 与水位整体差分。
 * 失败时保留旧水位（不推进、不半更新：列表成功而正文失败不做列表级差分，避免指纹抖动伪造"变化"）。
 */
export async function runAnnouncementPollBatch(
  entry: AnnouncementSourceEntry,
  state: SourcePollState,
  nowMs: number,
  deps: PollBatchDeps = {},
): Promise<AnnouncementPollReport> {
  const fetchFn = deps.fetchFn ?? fetch;
  const adapter = createAnnouncementAdapter(entry, { fetchFn, now: () => nowMs });

  // 全量快照型：单请求即全集，limit 无法缩小批次（截断=丢条目=伪造"消失"）；
  // 每批上限由请求本身承载（limit_profile：pages=1，全集即批量）。
  const list = await adapter.list(null, Number.POSITIVE_INFINITY);
  if (list.failure !== null) {
    const status = list.failure.kind === "restricted" ? "maintenance-required" : "incomplete";
    return {
      sourceId: entry.sourceId,
      status,
      complete: false,
      diff: null,
      items: [],
      recheckCandidates: [],
      failure: list.failure,
      nextState: state,
    };
  }
  if (!list.complete) {
    return {
      sourceId: entry.sourceId,
      status: "incomplete",
      complete: false,
      diff: null,
      items: list.items,
      recheckCandidates: [],
      failure: list.failure,
      nextState: state,
    };
  }

  const contentSet = await fetchAnnouncementContentSet(entry, fetchFn);
  if ("failure" in contentSet) {
    const status = contentSet.failure.kind === "restricted" ? "maintenance-required" : "incomplete";
    return {
      sourceId: entry.sourceId,
      status,
      complete: false,
      diff: null,
      items: list.items,
      contentSet,
      recheckCandidates: [],
      failure: contentSet.failure,
      nextState: state,
    };
  }

  const records: SnapshotRecord[] = await Promise.all(
    list.items.map(async (stub) => ({
      externalId: stub.externalId,
      // 正文缺位以 null 参与指纹：后续批拿到正文会如实表现为一次"变化"。
      fingerprint: await announcementFingerprint(
        stub,
        contentSet.entries.get(stub.externalId)?.contentSha256 ?? null,
      ),
    })),
  );

  const previousWatermark: FullSnapshotWatermark | null =
    state.watermark !== null && state.watermark.model === "full-snapshot" ? state.watermark : null;
  // 重叠窗口：与上次成功快照**整体**差分（不按最大 ID 截断——历史条目变化仍能被发现）。
  const diff = diffSnapshotRecords(previousWatermark?.records ?? [], records);

  return {
    sourceId: entry.sourceId,
    status: "ok",
    complete: true,
    diff,
    contentSet,
    items: list.items,
    recheckCandidates: selectRecheckCandidates(entry, list.items, nowMs),
    failure: null,
    nextState: {
      watermark: advanceFullSnapshotWatermark(records),
      lastPollCompletedAtMs: nowMs,
      // 全量拉取本身覆盖复查窗口：复查水位同批推进（公告源"按篇复查"=全量重拉，P0-02）。
      lastRecheckCompletedAtMs: nowMs,
    },
  };
}
