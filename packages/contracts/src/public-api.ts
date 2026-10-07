/** P3-14：真实公共读接口。所有时间沿用 TimeValue；null 表示事实未知。
 * ScheduleNode 的字段名保留；增加 eventId，noticePublishedAt 允许 unknown。
 * 不使用 synthetic ScheduleSnapshot；F1-06 应直接消费以下 schema。
 * GET events: range= today|3d|7d|30d|90d|all，games=逗号分隔游戏，cursor=不透明游标。
 * 分页按稳定节点身份；页面内排序交给前端。空页仍可能有 nextCursor。
 * 同代游标含 UTC+8 浏览日起点；换代返回 conflict，客户端清空后重载。
 * all 仅指服务端当前有限代次内今天起的节点，外加昨天带，绝非无限历史查询。
 */
import { z } from "zod";
import {
  EventStatusSchema,
  EventTypeSchema,
  GameIdSchema,
  NodeTypeSchema,
  RegionIdSchema,
} from "./enums";
import { ArticleCompletenessSchema } from "./official-article";
import { TimeValueSchema } from "./time";

const Timestamp = z.int();
export const PublicPublicationSchema = z.strictObject({
  generation: z.int().positive(),
  publishedAt: Timestamp,
});
/** 响应副本的新鲜期；源站实时响应 stale 恒为 false，非代次或来源水位。 */
export const PublicCacheSchema = z.strictObject({
  generatedAt: Timestamp,
  freshUntil: Timestamp,
  stale: z.boolean(),
});
export const PublicChangeSchema = z.strictObject({
  kind: z.enum([
    "rescheduled",
    "cancelled",
    "retracted",
    "pending",
    "deleted",
    "restored",
    "classification_corrected",
  ]),
  explanation: z.string(),
  /** 共享层保留的历史时间水位，可能早于最近一次改期，不是当前安排。 */
  historicalTime: TimeValueSchema.nullable(),
  currentTime: TimeValueSchema.nullable(),
  retainUntil: Timestamp,
  evidence: z.string(),
});
export const PublicScheduleNodeSchema = z.strictObject({
  id: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string(),
  game: GameIdSchema,
  eventType: EventTypeSchema,
  nodeType: NodeTypeSchema,
  status: EventStatusSchema,
  time: TimeValueSchema,
  evidence: z.string(),
  noticePublishedAt: Timestamp.nullable(),
  change: PublicChangeSchema.nullable(),
});
export const PublicCatalogResponseSchema = z.strictObject({
  games: z.array(GameIdSchema),
  regions: z.array(RegionIdSchema),
  eventTypes: z.array(EventTypeSchema),
  nodeTypes: z.array(NodeTypeSchema),
  publication: PublicPublicationSchema.nullable(),
  cache: PublicCacheSchema,
});
export const PublicEventsResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  cache: PublicCacheSchema,
  window: z.strictObject({ start: Timestamp, end: Timestamp.nullable(), yesterday: Timestamp }),
  nodes: z.array(PublicScheduleNodeSchema),
  /** 只按游戏筛选，不随浏览日期隐藏；仅当前快照中仍在共享更正保留期的有限结果。
   * 只随首页（无 cursor）返回；续页恒为 [] 与 false。 */
  recentChanges: z.array(PublicScheduleNodeSchema),
  recentChangesTruncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export const PublicOfficialEvidenceSchema = z.strictObject({
  url: z.url().nullable(),
  publisher: z.string().nullable(),
  publishedAt: Timestamp.nullable(),
  updatedAt: Timestamp.nullable(),
  /** 已发布事实的原始时间表述；不是完整公告 HTML 或抽取原文。按文本渲染。 */
  excerpts: z.array(z.string()),
});
export const PublicEventDetailResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  cache: PublicCacheSchema,
  event: z.strictObject({
    id: z.string(),
    title: z.string(),
    game: GameIdSchema,
    eventType: EventTypeSchema,
    status: EventStatusSchema,
    /** 仅从实际存在的节点挑选；没有可确认的当前安排时为 null。 */
    importantNodeId: z.string().nullable(),
    milestones: z.array(PublicScheduleNodeSchema),
    changes: z.array(z.strictObject({ nodeId: z.string(), change: PublicChangeSchema })),
    official: PublicOfficialEvidenceSchema,
  }),
});
/** P3-22（ADR-0014）：文章版本的正文块，原样取自不可变版本。title/text 是文本；
 * html 是官方原始 HTML 片段，只能惰性解析后按白名单重建，不得放进 innerHTML。 */
export const PublicArticleBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("title"), text: z.string() }),
  z.strictObject({ kind: z.literal("html"), html: z.string() }),
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
]);
/** GET /api/v2/events/{eventId}/articles：本代该活动依据的官方公告原文（本站采集时保存的版本）。 */
export const PublicEventArticlesResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  cache: PublicCacheSchema,
  eventId: z.string().min(1),
  /** 与公告发布时间同一绑定条件（已发布证据、本代投影一致、逐字段匹配）的文章版本，去重、按抓取时间新到旧；
   * 无法证明绑定时为空数组，不取未发布或未批准的正文。 */
  articles: z.array(
    z.strictObject({
      officialUrl: z.url(),
      versionNo: z.int().positive(),
      /** 本站抓取这一版正文的时间，不是官方发布或更新时间。 */
      fetchedAt: Timestamp,
      publishedAt: Timestamp.nullable(),
      completeness: ArticleCompletenessSchema,
      blocks: z.array(PublicArticleBlockSchema),
    }),
  ),
});
/**
 * 来源的用途（ADR-0030）：announcement 是日程事实的来源（游戏内公告），live_codes 是米游社直播兑换码。
 * 只有 announcement 决定日程是否受来源异常影响；兑换码来源异常只影响兑换码条与兑换码事件。
 */
export const PUBLIC_SOURCE_KINDS = ["announcement", "live_codes"] as const;
export type PublicSourceKind = (typeof PUBLIC_SOURCE_KINDS)[number];
/** 来源用途的界面名称（服务状态页逐来源列出时用）。 */
export const PUBLIC_SOURCE_KIND_LABELS: Record<PublicSourceKind, string> = {
  announcement: "游戏内公告",
  live_codes: "直播兑换码",
};
export const PublicSourceStatusSchema = z.strictObject({
  sourceId: z.string().min(1),
  game: GameIdSchema,
  kind: z.enum(PUBLIC_SOURCE_KINDS),
  verifiedAt: Timestamp.nullable(),
  verificationState: z.enum(["verified", "unavailable", "unknown"]),
  degradationReasons: z.array(
    z.enum(["source_unavailable", "maintenance_required", "not_verified", "content_unavailable"]),
  ),
});
export const PublicCapabilitySchema = z.enum(["open", "closed", "unknown"]);
export const PublicStatusResponseSchema = z.strictObject({
  registration_open: z.boolean(),
  mail_sending_available: z.boolean(),
  publication: PublicPublicationSchema.nullable(),
  cache: PublicCacheSchema,
  /** null 表示来源聚合未知；空数组表示查询成功且没有登记来源。 */
  sources: z.array(PublicSourceStatusSchema).nullable(),
  reviewGaps: z.array(
    z.strictObject({ game: GameIdSchema, count: z.int().nonnegative().nullable() }),
  ),
  capabilities: z.strictObject({
    calendar: PublicCapabilitySchema,
    email_seats: PublicCapabilitySchema,
    routine_email: PublicCapabilitySchema,
    push: PublicCapabilitySchema,
  }),
  calendarClients: z.array(
    z.strictObject({
      client: z.enum(["apple_calendar_macos", "google_calendar", "outlook"]),
      support: z.enum(["verified", "unknown"]),
    }),
  ),
});
/**
 * GET /api/v2/redeem-codes（ADR-0030）：当前在「有效兑换码」条里的兑换码，来自米游社官方直播页接口。
 * 只含已发放、仍在显示期内的条目（contracts redeemCodeVisible）；code 与 reward 按文本渲染。
 */
export const PublicRedeemCodeSchema = z.strictObject({
  game: GameIdSchema,
  code: z.string().min(1).max(64),
  /** 奖励说明，官方 HTML 已整理为纯文本。 */
  reward: z.string(),
  liveTitle: z.string(),
  /** 官方发放时刻。 */
  revealedAt: Timestamp,
  /** 官方写明的有效期截止；没写为 null（此时只按显示上限隐藏）。 */
  expiresAt: Timestamp.nullable(),
  /** 有效期原文，例如"10月10日12:00"；没写为 null。 */
  expiryText: z.string().nullable(),
  /** 用于页面到点隐藏的时刻（官方有效期，或没写有效期时的显示上限）。 */
  hiddenAt: Timestamp,
  /** 官方直播页。 */
  officialUrl: z.url(),
  /** 已发布的兑换码事件；尚未发布时为 null。 */
  eventId: z.string().min(1).nullable(),
});
export const PublicRedeemCodesResponseSchema = z.strictObject({
  cache: PublicCacheSchema,
  codes: z.array(PublicRedeemCodeSchema),
});
export type PublicRedeemCode = z.infer<typeof PublicRedeemCodeSchema>;
export type PublicRedeemCodesResponse = z.infer<typeof PublicRedeemCodesResponseSchema>;
export type PublicCatalogResponse = z.infer<typeof PublicCatalogResponseSchema>;
export type PublicSourceStatus = z.infer<typeof PublicSourceStatusSchema>;
export type PublicPublication = z.infer<typeof PublicPublicationSchema>;
export type PublicCache = z.infer<typeof PublicCacheSchema>;
export type PublicScheduleNode = z.infer<typeof PublicScheduleNodeSchema>;
export type PublicEventsResponse = z.infer<typeof PublicEventsResponseSchema>;
export type PublicEventDetailResponse = z.infer<typeof PublicEventDetailResponseSchema>;
export type PublicArticleBlock = z.infer<typeof PublicArticleBlockSchema>;
export type PublicEventArticlesResponse = z.infer<typeof PublicEventArticlesResponseSchema>;
export type PublicStatusResponse = z.infer<typeof PublicStatusResponseSchema>;

// 公开表现和窗口判断的单一定义源；Worker 只执行查询与传输。
import { PUBLIC_CACHE_FRESH, PUBLIC_READ_LIMITS, SUPPORTED_SCOPE } from "./params/registry";
import {
  CALENDAR_PATCH_KIND,
  type PatchDecision,
  type PublicSnapshotNode,
} from "./public-calendar";
import {
  BROWSE_DEFAULT_RANGE,
  BROWSE_RANGES,
  type BrowseRange,
  browseDate,
  browseWindow,
} from "./schedule-browse";

export function publicCache(_publication: PublicPublication | null, now: number): PublicCache {
  return { generatedAt: now, freshUntil: now + PUBLIC_CACHE_FRESH * 1000, stale: false };
}

/**
 * ADR-0028：改期却没有任何曾公开过的旧时间，是节点从"时间待定"第一次得到时间——多由本站补全年份、
 * 版本推导或解析规则更新造成——不是前端 §4.4 所说的"有公开依据的改期"，不进公开变更。
 * 只管公开浏览的表现；共享更正层与个人 Feed 仍按 decideCalendarPatch 的结果。
 * 公开读取的变更查询（Worker `PUBLIC_CHANGES_SQL`）按同一条件在 SQL 里排除。
 */
export const PUBLIC_UNANNOUNCED_PATCH_KIND = CALENDAR_PATCH_KIND.RESCHEDULED;
export function isPublicChange(patch: PatchDecision): boolean {
  return !(patch.kind === PUBLIC_UNANNOUNCED_PATCH_KIND && patch.old_time === null);
}

/** 不把 ICS tombstone（删除补偿）误称为官方取消；它只能在变更区域出现。 */
export function publicNode(
  node: PublicSnapshotNode,
  noticePublishedAt: number | null = null,
  evidence: { node: string; change: string | null } | null = null,
): PublicScheduleNode {
  const { projection: p, patch } = node;
  const kind = patch?.kind === "postponed_unknown" ? "pending" : patch?.kind;
  return PublicScheduleNodeSchema.parse({
    id: p.milestone_id,
    eventId: p.event_id,
    title: p.event.title,
    game: node.game,
    eventType: p.event.event_type,
    nodeType: p.milestone.node_type,
    status: node.tombstone ? "retracted" : p.event.status,
    time: p.milestone.time,
    evidence: evidence?.node ?? p.milestone.time.raw_expression,
    noticePublishedAt,
    change:
      patch === null || !isPublicChange(patch)
        ? null
        : {
            kind,
            explanation: patch.fact_reason,
            historicalTime: patch.old_time,
            currentTime:
              node.tombstone || p.event.status === "cancelled" || p.event.status === "retracted"
                ? null
                : p.milestone.time,
            retainUntil: patch.retain_until,
            evidence: evidence?.change ?? evidence?.node ?? p.milestone.time.raw_expression,
          },
  });
}

export function publicNodeInWindow(
  node: PublicSnapshotNode,
  range: BrowseRange,
  now: number,
): boolean {
  if (node.tombstone) return false;
  const { start, end, yesterday } = browseWindow(range, now);
  const time = node.projection.milestone.time;
  if (time.precision === "unknown") return true;
  if (time.precision === "datetime")
    return (
      (time.utc_ms >= yesterday && time.utc_ms < start) ||
      (time.utc_ms >= start && (end === null || time.utc_ms < end))
    );
  return (
    time.date === browseDate(yesterday) ||
    (time.date >= browseDate(start) && (end === null || time.date < browseDate(end)))
  );
}

/** 优先未来的确切节点，其次日期节点，最后待定；不据时钟宣称实际进行中。 */
export function publicImportantNode(
  nodes: readonly PublicScheduleNode[],
  now: number,
): string | null {
  const current = nodes.filter((n) => n.status !== "cancelled" && n.status !== "retracted");
  const exact = current
    .filter((n) => n.time.precision === "datetime" && n.time.utc_ms >= now)
    .sort(
      (a, b) =>
        (a.time.precision === "datetime" ? a.time.utc_ms : 0) -
          (b.time.precision === "datetime" ? b.time.utc_ms : 0) || a.id.localeCompare(b.id),
    );
  const dated = current
    .filter((n) => n.time.precision === "date" && n.time.date >= browseDate(now))
    .sort(
      (a, b) =>
        (a.time.precision === "date" ? a.time.date : "").localeCompare(
          b.time.precision === "date" ? b.time.date : "",
        ) || a.id.localeCompare(b.id),
    );
  return (
    exact[0]?.id ?? dated[0]?.id ?? current.find((n) => n.time.precision === "unknown")?.id ?? null
  );
}

export function publicSourceStatus(
  game: PublicSourceStatus["game"],
  row: { source_id: string; last_success_at: number | null; verification_state: string },
  kind: PublicSourceKind = "announcement",
): PublicSourceStatus {
  const stopped = row.verification_state === "maintenance-required";
  const listOnly = row.verification_state === "maintenance-required-list-only";
  const verified =
    row.last_success_at !== null && (row.verification_state === "verified-working" || listOnly);
  return {
    sourceId: row.source_id,
    game,
    kind,
    verifiedAt: row.last_success_at,
    verificationState:
      row.last_success_at === null
        ? "unknown"
        : stopped
          ? "unavailable"
          : verified
            ? "verified"
            : "unknown",
    degradationReasons: stopped
      ? ["maintenance_required"]
      : listOnly
        ? verified
          ? ["content_unavailable"]
          : ["content_unavailable", "not_verified"]
        : verified
          ? []
          : ["not_verified"],
  };
}

/** 只取已批准且逐字段匹配本代事实的证据片段；不把候选载荷暴露给浏览者。 */
export function publicEvidence(
  node: PublicSnapshotNode,
  approvedProposal: unknown,
): { node: string; change: string | null } | null {
  const proposal = z
    .object({
      events: z.array(
        z.object({
          title: z.string(),
          event_type: EventTypeSchema,
          status: EventStatusSchema,
          status_evidence: z.object({ quote: z.string() }).nullable(),
          milestones: z.array(
            z.object({
              milestone_key: z.string(),
              node_type: NodeTypeSchema,
              time: TimeValueSchema,
              time_evidence: z.object({ quote: z.string() }),
            }),
          ),
        }),
      ),
    })
    .safeParse(approvedProposal);
  if (!proposal.success) return null;
  const p = node.projection;
  for (const event of proposal.data.events) {
    if (
      event.title !== p.event.title ||
      event.event_type !== p.event.event_type ||
      event.status !== p.event.status
    )
      continue;
    const milestone = event.milestones.find(
      (m) =>
        m.milestone_key === p.milestone.milestone_key &&
        m.node_type === p.milestone.node_type &&
        JSON.stringify(m.time) === JSON.stringify(TimeValueSchema.parse(p.milestone.time)),
    );
    if (milestone || event.status_evidence !== null)
      return {
        node: milestone?.time_evidence.quote ?? p.milestone.time.raw_expression,
        change: event.status_evidence?.quote ?? null,
      };
  }
  return null;
}

const PublicCursorSchema = z.strictObject({
  generation: z.int().positive(),
  start: Timestamp,
  range: z.enum(BROWSE_RANGES.map((r) => r.id)),
  games: z.array(GameIdSchema).max(SUPPORTED_SCOPE.games.length),
  after: z.string().max(PUBLIC_READ_LIMITS.queryBytes),
});
export type PublicCursor = z.infer<typeof PublicCursorSchema>;
export function encodePublicCursor(cursor: PublicCursor): string {
  return btoa(encodeURIComponent(JSON.stringify(PublicCursorSchema.parse(cursor))));
}
export function decodePublicCursor(raw: string): PublicCursor | null {
  try {
    return PublicCursorSchema.parse(JSON.parse(decodeURIComponent(atob(raw))));
  } catch {
    return null;
  }
}
export function parsePublicSelection(params: URLSearchParams, now: number) {
  const range = params.get("range") ?? BROWSE_DEFAULT_RANGE;
  if (!BROWSE_RANGES.some((r) => r.id === range)) return null;
  const gameInput = params.get("games");
  const values =
    gameInput === null ? [...SUPPORTED_SCOPE.games] : gameInput === "" ? [] : gameInput.split(",");
  if (
    values.some((g) => !GameIdSchema.safeParse(g).success) ||
    new Set(values).size !== values.length
  )
    return null;
  const games = SUPPORTED_SCOPE.games.filter((g) => values.includes(g));
  return { range: range as BrowseRange, games, window: browseWindow(range as BrowseRange, now) };
}
export function publicCursorMatches(
  cursor: PublicCursor,
  selection: NonNullable<ReturnType<typeof parsePublicSelection>>,
  generation: number,
): boolean {
  return (
    cursor.generation === generation &&
    cursor.start === selection.window.start &&
    cursor.range === selection.range &&
    JSON.stringify(cursor.games) === JSON.stringify(selection.games)
  );
}
