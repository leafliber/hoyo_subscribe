// ADR-0030 · 直播兑换码来源的一次采集：发现直播活动 → 逐个读活动与兑换码 → 文章版本计划 + 兑换码条数据。
//
// 每次轮询至多 1 次首页请求 + 每个跟踪中的活动 2 次请求（REDEEM_LIVE_TRACK_MAX 封顶）。
// - 活动来源：首页里的官方直播页链接，加上管理员登记的活动 ID（发现入口没出现时的兜底）；
// - 官方返回"活动已结束"的活动记下时刻、不再请求；首次发现满 REDEEM_LIVE_TRACK_DAYS 天的不再跟踪；
// - 有兑换码条目的活动写成文章版本（内容不变不产生新版本），交给规则模板生成兑换码事件；
// - 已发放的兑换码另作「有效兑换码」条的数据，由 runtime 在落页时写入 redeem_codes；
// - 有尚未发放的兑换码时，按官方发放时刻排下一次采集（REDEEM_CODE_REVEAL_GRACE），发放时刻过了
//   SOURCE_HOT_POLL 仍没取到就回到常规间隔。
// 遇到鉴权/验证码/访问限制整批按 maintenance-required 交给 runtime 停用并标维护（规则 6），不绕过。
import {
  earliestExplicitDate,
  REDEEM_CODE_REVEAL_GRACE,
  REDEEM_LIVE_TRACK_DAYS,
  REDEEM_LIVE_TRACK_MAX,
  SOURCE_HOT_POLL,
} from "@hoyo/contracts";
import { readableBlockText } from "../../extraction/model/readable";
import { redeemExpiryInstant, redeemExpiryTime } from "../../extraction/redeem";
import {
  discoverLiveActIds,
  fetchLiveSnapshot,
  type LiveSnapshot,
} from "../../sources/adapters/miyolive";
import { liveArticleHtml } from "../../sources/adapters/miyolive-article";
import { type ArticleIngestPlan, buildArticleIngestPlan } from "../../sources/articles/ingest";
import type { MiyoliveSourceEntry } from "../../sources/registry";
import {
  advanceFullSnapshotWatermark,
  type FullSnapshotWatermark,
  type SnapshotRecord,
  sha256Hex,
} from "../../sources/snapshot-diff";
import type { SourceItemStub } from "../../sources/types";
import type { SourcePollState, TrackedLive } from "./source-poll";

// 单位换算，非业务参数。
const SECOND = 1000;
const DAY = 86_400_000;

/** 「有效兑换码」条的一行（已发放的兑换码）。 */
export interface RedeemCodeRow {
  readonly actId: string;
  readonly code: string;
  readonly liveTitle: string;
  readonly reward: string;
  readonly revealedAt: number;
  readonly expiresAt: number | null;
  readonly expiryText: string | null;
}

export interface RedeemUpdate {
  readonly rows: readonly RedeemCodeRow[];
  /** 本次观察到官方"活动已结束"的活动。 */
  readonly closed: readonly string[];
}

export interface CollectedLivePage {
  plans: ArticleIngestPlan[];
  nextState: SourcePollState;
  status: "ok" | "incomplete" | "maintenance-required";
  backfill: boolean;
  redeem: RedeemUpdate;
  nextPollAtMs: number | null;
}

function liveStub(entry: MiyoliveSourceEntry, actId: string, title: string): SourceItemStub {
  return {
    sourceId: entry.sourceId,
    externalId: actId,
    title,
    subtitle: null,
    typeLabel: "直播兑换码",
    tagLabel: null,
    listStartTime: null,
    listEndTime: null,
    bannerUrl: null,
    coverUrl: null,
    imageUrls: [],
    publisherUid: null,
    hasContent: true,
    publishedAtMs: null,
  };
}

/** 跟踪名单：保留跟踪期内的旧条目，新出现的活动（首页在前、管理员登记在后）每次至多补到上限。 */
function trackedLives(
  previous: readonly TrackedLive[],
  discovered: readonly string[],
  hints: readonly string[],
  now: number,
): TrackedLive[] {
  const horizon = now - REDEEM_LIVE_TRACK_DAYS * DAY;
  const kept = previous.filter((live) => live.firstSeenAtMs >= horizon);
  const known = new Set(kept.map((live) => live.actId));
  const fresh = [...new Set([...discovered, ...hints])]
    .filter((actId) => !known.has(actId))
    .slice(0, REDEEM_LIVE_TRACK_MAX)
    .map((actId) => ({ actId, firstSeenAtMs: now, closedAtMs: null }));
  return [...kept, ...fresh];
}

/** 有尚未发放的兑换码时，下一次采集的时刻；没有则为 null（按常规间隔）。 */
function nextRevealPoll(snapshots: readonly LiveSnapshot[], now: number): number | null {
  let next: number | null = null;
  for (const live of snapshots) {
    if (live.status !== "open") continue;
    for (const code of live.codes) {
      if (code.code !== null) continue;
      const due =
        code.revealAtMs + REDEEM_CODE_REVEAL_GRACE * SECOND > now
          ? code.revealAtMs + REDEEM_CODE_REVEAL_GRACE * SECOND
          : now < code.revealAtMs + SOURCE_HOT_POLL * SECOND
            ? now + REDEEM_CODE_REVEAL_GRACE * SECOND
            : null;
      if (due !== null && (next === null || due < next)) next = due;
    }
  }
  return next;
}

export async function collectLiveSource(
  entry: MiyoliveSourceEntry,
  state: SourcePollState,
  now: number,
  fetchFn: typeof fetch,
  hints: readonly string[] = [],
): Promise<CollectedLivePage> {
  const backfill = state.watermark === null;
  const empty = { rows: [], closed: [] };
  const discovery = await discoverLiveActIds(entry, fetchFn);
  if ("failure" in discovery && discovery.failure.kind === "restricted")
    return {
      plans: [],
      nextState: state,
      status: "maintenance-required",
      backfill,
      redeem: empty,
      nextPollAtMs: null,
    };
  let status: "ok" | "incomplete" = "failure" in discovery ? "incomplete" : "ok";
  const lives = trackedLives(
    state.lives ?? [],
    "failure" in discovery ? [] : discovery.actIds,
    hints,
    now,
  );
  const open = lives
    .filter((live) => live.closedAtMs === null)
    .sort((a, b) => b.firstSeenAtMs - a.firstSeenAtMs || a.actId.localeCompare(b.actId))
    .slice(0, REDEEM_LIVE_TRACK_MAX);

  const previous = new Map(
    (state.watermark?.records ?? []).map((record) => [record.externalId, record.fingerprint]),
  );
  const records = new Map(previous);
  const plans: ArticleIngestPlan[] = [];
  const rows: RedeemCodeRow[] = [];
  const closed: string[] = [];
  const snapshots: LiveSnapshot[] = [];
  for (const live of open) {
    const fetched = await fetchLiveSnapshot(entry, live.actId, now, fetchFn);
    if ("failure" in fetched) {
      if (fetched.failure.kind === "restricted")
        return {
          plans: [],
          nextState: state,
          status: "maintenance-required",
          backfill,
          redeem: empty,
          nextPollAtMs: null,
        };
      status = "incomplete";
      continue;
    }
    const snapshot = fetched.live;
    snapshots.push(snapshot);
    if (snapshot.status === "closed") {
      closed.push(snapshot.actId);
      continue;
    }
    // 还没有兑换码条目的活动不写文章（不产生空候选）；兑换码出现后再入账。
    if (snapshot.codes.length === 0) continue;
    const contentHtml = liveArticleHtml(snapshot.codes, snapshot.tip);
    const fingerprint = await sha256Hex(`${snapshot.title}\n${contentHtml}`);
    const plan = await buildArticleIngestPlan(
      entry,
      liveStub(entry, snapshot.actId, snapshot.title),
      {
        status: "fetched",
        sourceId: entry.sourceId,
        externalId: snapshot.actId,
        title: snapshot.title,
        contentHtml,
        contentSha256: await sha256Hex(contentHtml),
        signals: {
          contentEmpty: false,
          imageCount: 0,
          contentBytes: new TextEncoder().encode(contentHtml).length,
          bodyTruncated: false,
        },
        fetchedAtMs: now,
      },
      now,
    );
    if (previous.get(snapshot.actId) !== fingerprint) plans.push(plan);
    records.set(snapshot.actId, fingerprint);
    // 有效期与日历的结束节点用同一份正文、同一参照日期换算（extraction/redeem）。
    const blocks = plan.kind === "version" ? plan.plan.blocks : [];
    const expiry =
      snapshot.tip === null
        ? null
        : redeemExpiryTime(snapshot.tip, earliestExplicitDate(blocks.map(readableBlockText)));
    const expiresAt = expiry === null ? null : redeemExpiryInstant(expiry);
    for (const code of snapshot.codes) {
      if (code.code === null) continue;
      rows.push({
        actId: snapshot.actId,
        code: code.code,
        liveTitle: snapshot.title,
        reward: code.reward,
        revealedAt: code.revealAtMs,
        expiresAt,
        expiryText: expiresAt === null || expiry === null ? null : expiry.raw_expression,
      });
    }
  }

  const nextLives = lives.map((live) =>
    closed.includes(live.actId) ? { ...live, closedAtMs: now } : live,
  );
  const tracked = new Set(nextLives.map((live) => live.actId));
  const watermark: FullSnapshotWatermark = advanceFullSnapshotWatermark(
    [...records]
      .filter(([actId]) => tracked.has(actId))
      .map(([externalId, fingerprint]): SnapshotRecord => ({ externalId, fingerprint })),
  );
  return {
    plans,
    nextState: {
      watermark,
      lastPollCompletedAtMs: status === "ok" ? now : state.lastPollCompletedAtMs,
      lastRecheckCompletedAtMs: status === "ok" ? now : state.lastRecheckCompletedAtMs,
      lives: nextLives,
    },
    status,
    backfill,
    redeem: { rows, closed },
    nextPollAtMs: nextRevealPoll(snapshots, now),
  };
}
