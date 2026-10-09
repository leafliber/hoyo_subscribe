// ADR-0030 · 直播兑换码来源的一次采集：发现直播活动 → 逐个读活动与兑换码 → 文章版本计划 + 兑换码条数据。
//
// 每次轮询至多 1 次首页请求 + 每个需要读取的活动 2 次请求（REDEEM_LIVE_TRACK_MAX 封顶）。
// - 活动来源：首页里的官方直播页链接，加上管理员登记的活动 ID（发现入口没出现时的兜底）；
// - 官方返回"活动已结束"的活动记下时刻、不再请求；首次发现满 REDEEM_LIVE_TRACK_DAYS 天的不再跟踪；
// - 已发放的兑换码另作「有效兑换码」条的数据，由 runtime 在落页时写入 redeem_codes；
// - 有尚未发放的兑换码时，按官方发放时刻排下一次采集（REDEEM_CODE_REVEAL_GRACE），发放时刻过了
//   SOURCE_HOT_POLL 仍没取到就回到常规间隔。
// ADR-0034：
// - 有已发放的兑换码才写文章版本（预告了时刻、码还是空的条目不写，免得真正发放时官方改时刻造成改期）；
//   取到兑换码的这一轮就写，runtime 随即排发布，发布后同一待办里重建公共快照；
// - 直播收尾（官方写明已结束、没有待发放的条目）之后：有截止时间（管理员登记或官方说明认出）的不再请求；
//   没有截止时间的只在北京时间整点（redeemStatusCheckAfter）请求一次，官方不再列出的兑换码报作消失；
// - 管理员登记的截止时间写进正文一行，登记或改动后按记下的官方内容重写正文（不必再请求官方；
//   官方已返回"活动已结束"的直播也照此重写）。
// 遇到鉴权/验证码/访问限制整批按 maintenance-required 交给 runtime 停用并标维护（规则 6），不绕过。
import {
  earliestExplicitDate,
  REDEEM_CODE_REVEAL_GRACE,
  REDEEM_LIVE_TRACK_DAYS,
  REDEEM_LIVE_TRACK_MAX,
  redeemStatusCheckAfter,
  SOURCE_HOT_POLL,
} from "@hoyo/contracts";
import { readableBlockText } from "../../extraction/model/readable";
import { redeemExpiryInstant, redeemExpiryTime } from "../../extraction/redeem";
import {
  discoverLiveActIds,
  fetchLiveSnapshot,
  type LiveSnapshot,
} from "../../sources/adapters/miyolive";
import { liveArticleHtml, type RevealedLiveCode } from "../../sources/adapters/miyolive-article";
import type { ArticleBodyBlock } from "../../sources/articles/blocks";
import { type ArticleIngestPlan, buildArticleIngestPlan } from "../../sources/articles/ingest";
import type { MiyoliveSourceEntry } from "../../sources/registry";
import {
  advanceFullSnapshotWatermark,
  type FullSnapshotWatermark,
  type SnapshotRecord,
  sha256Hex,
} from "../../sources/snapshot-diff";
import type { SourceItemStub } from "../../sources/types";
import type { LiveRecord, SourcePollState, TrackedLive } from "./source-poll";

// 单位换算，非业务参数。
const SECOND = 1000;
const DAY = 86_400_000;

/** 「有效兑换码」条的一行（已发放的兑换码；有效期只填官方说明认出的，管理员登记的另存）。 */
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
  /** ADR-0034：本次读取时官方兑换码列表里已经没有的兑换码（以前发放过）。 */
  readonly gone: readonly { readonly actId: string; readonly code: string }[];
}

/** ADR-0034：管理员照官方说明登记的截止时间（每场直播一条）。 */
export interface ManualRedeemExpiry {
  readonly expiresAt: number;
  /** 写进正文的写法"YYYY/MM/DD HH:MM(:SS)"。 */
  readonly expression: string;
}

/** runtime 交给采集的库内输入：管理员登记的活动 ID 与截止时间。 */
export interface LiveCollectInputs {
  readonly hints: readonly string[];
  readonly expiries: ReadonlyMap<string, ManualRedeemExpiry>;
}

export const NO_LIVE_INPUTS: LiveCollectInputs = { hints: [], expiries: new Map() };

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

/** ADR-0034：直播收尾——官方写明已结束（is_end 或过了 live.end），且没有码还空着的条目。 */
function liveSettled(record: LiveRecord, now: number): boolean {
  return (
    record.pendingRevealAtMs.length === 0 &&
    (record.ended || (record.endAtMs !== null && now >= record.endAtMs))
  );
}

/** 有已发放的兑换码，且有截止时间（管理员登记或官方说明认出）。 */
function hasDeadline(record: LiveRecord, manual: ManualRedeemExpiry | null): boolean {
  return record.codes.length > 0 && (manual !== null || record.officialExpiry !== null);
}

/**
 * ADR-0034：一场直播当前的采集阶段——reading：没有记下官方内容或直播没收尾，每轮都读（ADR-0030 原样）；
 * deadline：收尾且有截止时间，不再读；checking：收尾、没有截止时间，到下一个整点（nextCheckAt）才读。
 * 采集与管理端展示用同一判断。
 */
export function liveTrackingPhase(
  live: TrackedLive,
  manual: ManualRedeemExpiry | null,
  now: number,
): { phase: "reading" | "deadline" | "checking"; nextCheckAt: number | null } {
  const { record, checkedAtMs } = live;
  if (record === undefined || checkedAtMs === undefined || !liveSettled(record, now))
    return { phase: "reading", nextCheckAt: null };
  if (hasDeadline(record, manual)) return { phase: "deadline", nextCheckAt: null };
  return { phase: "checking", nextCheckAt: redeemStatusCheckAfter(checkedAtMs) };
}

/** 这一轮要不要请求这场直播。 */
function shouldRead(live: TrackedLive, manual: ManualRedeemExpiry | null, now: number): boolean {
  const { phase, nextCheckAt } = liveTrackingPhase(live, manual, now);
  return phase === "reading" || (phase === "checking" && now >= (nextCheckAt ?? now));
}

/** 合并新读到的官方内容：已发放的兑换码以本次为准，本次没列出的旧兑换码保留（正文不因消失而变）。 */
function mergeRecord(
  previous: LiveRecord | undefined,
  snapshot: Extract<LiveSnapshot, { status: "open" }>,
): Omit<LiveRecord, "officialExpiry"> {
  const current = new Map<string, RevealedLiveCode>();
  for (const code of snapshot.codes)
    if (code.code !== null)
      current.set(code.code, { code: code.code, reward: code.reward, revealAtMs: code.revealAtMs });
  const kept = (previous?.codes ?? []).filter((code) => !current.has(code.code));
  return {
    title: snapshot.title,
    tip: snapshot.tip,
    endAtMs: snapshot.endAtMs,
    ended: snapshot.ended,
    codes: [...kept, ...current.values()].sort(
      (a, b) => a.revealAtMs - b.revealAtMs || a.code.localeCompare(b.code),
    ),
    pendingRevealAtMs: snapshot.codes
      .filter((code) => code.code === null)
      .map((code) => code.revealAtMs),
  };
}

/** 有尚未发放的兑换码时，按发放时刻补取的时刻；没有为 null。 */
function revealPoll(record: LiveRecord, now: number): number | null {
  let next: number | null = null;
  for (const revealAtMs of record.pendingRevealAtMs) {
    const due =
      revealAtMs + REDEEM_CODE_REVEAL_GRACE * SECOND > now
        ? revealAtMs + REDEEM_CODE_REVEAL_GRACE * SECOND
        : now < revealAtMs + SOURCE_HOT_POLL * SECOND
          ? now + REDEEM_CODE_REVEAL_GRACE * SECOND
          : null;
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

export async function collectLiveSource(
  entry: MiyoliveSourceEntry,
  state: SourcePollState,
  now: number,
  fetchFn: typeof fetch,
  inputs: LiveCollectInputs = NO_LIVE_INPUTS,
): Promise<CollectedLivePage> {
  const backfill = state.watermark === null;
  const empty = { rows: [], closed: [], gone: [] };
  const maintenance = {
    plans: [],
    nextState: state,
    status: "maintenance-required" as const,
    backfill,
    redeem: empty,
    nextPollAtMs: null,
  };
  const discovery = await discoverLiveActIds(entry, fetchFn);
  if ("failure" in discovery && discovery.failure.kind === "restricted") return maintenance;
  let status: "ok" | "incomplete" = "failure" in discovery ? "incomplete" : "ok";
  const lives = trackedLives(
    state.lives ?? [],
    "failure" in discovery ? [] : discovery.actIds,
    inputs.hints,
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
  const gone: { actId: string; code: string }[] = [];
  const updated = new Map<string, TrackedLive>();
  const dues: number[] = [];

  /** 按记下的官方内容与登记的截止时间写正文；没有已发放的兑换码不写。返回正文块（用于年份参照）。 */
  const writeArticle = async (
    actId: string,
    record: Omit<LiveRecord, "officialExpiry">,
    manual: ManualRedeemExpiry | null,
  ): Promise<readonly ArticleBodyBlock[]> => {
    if (record.codes.length === 0) return [];
    const contentHtml = liveArticleHtml(record.codes, record.tip, manual?.expression ?? null);
    const fingerprint = await sha256Hex(`${record.title}\n${contentHtml}`);
    const plan = await buildArticleIngestPlan(
      entry,
      liveStub(entry, actId, record.title),
      {
        status: "fetched",
        sourceId: entry.sourceId,
        externalId: actId,
        title: record.title,
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
    if (previous.get(actId) !== fingerprint) plans.push(plan);
    records.set(actId, fingerprint);
    return plan.kind === "version" ? plan.plan.blocks : [];
  };

  for (const live of open) {
    const manual = inputs.expiries.get(live.actId) ?? null;
    if (!shouldRead(live, manual, now)) {
      // 不请求官方：登记的截止时间新增或改动时，正文据此多一版，日历的"兑换码过期"随之发布或改期。
      if (live.record !== undefined) await writeArticle(live.actId, live.record, manual);
      continue;
    }
    const fetched = await fetchLiveSnapshot(entry, live.actId, now, fetchFn);
    if ("failure" in fetched) {
      if (fetched.failure.kind === "restricted") return maintenance;
      status = "incomplete";
      continue;
    }
    const snapshot = fetched.live;
    if (snapshot.status === "closed") {
      closed.push(snapshot.actId);
      continue;
    }
    const merged = mergeRecord(live.record, snapshot);
    const listed = new Set(
      snapshot.codes.flatMap((code) => (code.code === null ? [] : [code.code])),
    );
    for (const code of live.record?.codes ?? [])
      if (!listed.has(code.code)) gone.push({ actId: live.actId, code: code.code });
    // 有效期与日历的结束节点用同一份正文、同一参照日期换算（extraction/redeem）。
    const blocks = await writeArticle(live.actId, merged, manual);
    const expiry =
      merged.tip === null || blocks.length === 0
        ? null
        : redeemExpiryTime(merged.tip, earliestExplicitDate(blocks.map(readableBlockText)));
    const expiresAt = expiry === null ? null : redeemExpiryInstant(expiry);
    const record: LiveRecord = {
      ...merged,
      officialExpiry:
        expiry === null || expiresAt === null
          ? null
          : { atMs: expiresAt, text: expiry.raw_expression },
    };
    updated.set(live.actId, { ...live, record, checkedAtMs: now });
    for (const code of snapshot.codes) {
      if (code.code === null) continue;
      rows.push({
        actId: snapshot.actId,
        code: code.code,
        liveTitle: snapshot.title,
        reward: code.reward,
        revealedAt: code.revealAtMs,
        expiresAt: record.officialExpiry?.atMs ?? null,
        expiryText: record.officialExpiry?.text ?? null,
      });
    }
    const reveal = revealPoll(record, now);
    if (reveal !== null) dues.push(reveal);
  }

  // 官方已结束的直播不再请求，但管理员仍可为它登记截止时间：按记下的官方内容重写正文（ADR-0034）。
  for (const live of lives)
    if (live.closedAtMs !== null && live.record !== undefined)
      await writeArticle(live.actId, live.record, inputs.expiries.get(live.actId) ?? null);

  const nextLives = lives.map((live) =>
    closed.includes(live.actId) ? { ...live, closedAtMs: now } : (updated.get(live.actId) ?? live),
  );
  // ADR-0034：收尾后仍没有截止时间的直播，下一次采集排在下一个整点（不晚于常规间隔，由 runtime 取较早者）。
  // 本轮该读却没读成（请求失败）的不在这里排：交给 runtime 的失败重试间隔，避免立即空转。
  for (const live of nextLives) {
    if (live.closedAtMs !== null) continue;
    const { nextCheckAt } = liveTrackingPhase(live, inputs.expiries.get(live.actId) ?? null, now);
    if (nextCheckAt !== null && nextCheckAt > now) dues.push(nextCheckAt);
  }
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
    redeem: { rows, closed, gone },
    nextPollAtMs: dues.length === 0 ? null : Math.min(...dues),
  };
}
