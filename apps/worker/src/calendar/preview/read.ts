import {
  buildApiErrorBody,
  CalendarNodesResponseSchema,
  CalendarPreviewConfigSchema,
  CalendarPreviewResponseSchema,
  type CalendarPreviewSource,
  type CalendarPreviewCursor as Cursor,
  CalendarPreviewCursorSchema as CursorSchema,
  calendarPreviewCandidates,
  explainCalendarPreview,
  FEED_DIAGNOSTICS,
  FEED_RESPONSE_MAX_BYTES,
  feedIdentity,
  feedSourcesFresh,
  feedWindow,
  PUBLIC_CACHE_FRESH,
  PUBLIC_READ_LIMITS,
  personalCalendarNodes,
  publicCache,
  requiredCalendarSources,
  SUPPORTED_SCOPE_GAMES,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
} from "@hoyo/contracts";
import { readSubscription } from "../../accounts/subscription/service";
import { validatePublicQuery } from "../../public/read";
import { ApiError, errorResponse, jsonResponse } from "../../shell/errors";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { serializeCalendar } from "../feed/ical";
import {
  type FeedPublicCache,
  type FeedSnapshot,
  readFeedSourceWatermarks,
} from "../feed/public-read";

export function encodePreviewCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(CursorSchema.parse(cursor)));
}
function cursorFrom(url: URL, privateRead: boolean): Cursor | null {
  validatePublicQuery(url, ["cursor"]);
  const raw = url.searchParams.get("cursor");
  if (raw === null) return null;
  try {
    const cursor = CursorSchema.parse(JSON.parse(atob(raw)));
    if ((cursor.revision !== undefined) !== privateRead) throw new Error("cursor_domain");
    return cursor;
  } catch {
    throw new ApiError("validation");
  }
}
export function previewOutdated(): never {
  throw new ApiError("conflict", { code: "conflict", reason: "preview_outdated" });
}
function asOfFor(snapshot: FeedSnapshot, now: number, cursor: Cursor | null, revision?: number) {
  if (!cursor) return now;
  if (cursor.generation !== snapshot.generation || cursor.revision !== revision) previewOutdated();
  if (cursor.asOf > now || cursor.asOf < snapshot.published_at) throw new ApiError("validation");
  if (revision !== undefined && now - cursor.asOf > PUBLIC_CACHE_FRESH * 1000) previewOutdated();
  return cursor.asOf;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** 验证全集单项大小，不能先给成功的前页、再把后面的超大条目藏掉。 */
function page<T>(
  all: readonly T[],
  cursor: Cursor | null,
  binding: Omit<Cursor, "offset">,
  envelope: (items: readonly T[], next: string | null) => unknown,
) {
  if (all.some((item) => bytes(item) > PUBLIC_READ_LIMITS.nodeBytes))
    throw new ApiError("temporarily_unavailable");
  const start = cursor?.offset ?? 0;
  if (start > all.length || (cursor && start === all.length && all.length > 0))
    throw new ApiError("validation");
  let lo = start,
    hi = all.length;
  const bodyAt = (end: number) =>
    envelope(
      all.slice(start, end),
      end < all.length ? encodePreviewCursor({ ...binding, offset: end }) : null,
    );
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(bodyAt(mid)) <= PUBLIC_READ_LIMITS.responseBytes) lo = mid;
    else hi = mid - 1;
  }
  if ((lo === start && start < all.length) || bytes(bodyAt(lo)) > PUBLIC_READ_LIMITS.responseBytes)
    throw new ApiError("temporarily_unavailable");
  return bodyAt(lo);
}
export function snapshotUnavailable(): Response {
  const base = errorResponse("temporarily_unavailable");
  return new Response(
    JSON.stringify({
      ...buildApiErrorBody("temporarily_unavailable"),
      calendar: {
        reason: "snapshot_unavailable",
        message: FEED_DIAGNOSTICS.snapshot_unavailable,
        settings_path: "/subscription",
      },
    }),
    { status: base.status, headers: base.headers },
  );
}
async function snapshot(cache: FeedPublicCache, db: D1Database, now: number) {
  try {
    return await cache.read(db, now);
  } catch {
    return null;
  }
}
async function sources(db: D1Database): Promise<CalendarPreviewSource[]> {
  const entries = requiredCalendarSources(
    { scope: { games: SUPPORTED_SCOPE_GAMES, regions: SUPPORTED_SCOPE_REGIONS } },
    SOURCE_REGISTRY,
  );
  const times = await readFeedSourceWatermarks(
    db,
    entries.map((e) => e.sourceId),
  );
  return entries.map((e, i) => ({
    sourceId: e.sourceId,
    game: e.game,
    region: e.region,
    lastSuccessAt: times[i] ?? null,
  }));
}
export async function readCalendarNodes(
  db: D1Database,
  url: URL,
  cache: FeedPublicCache,
  now: number,
): Promise<Response> {
  const cursor = cursorFrom(url, false);
  const current = await snapshot(cache, db, now);
  if (!current) return snapshotUnavailable();
  const asOf = asOfFor(current, now, cursor);
  const nodes = calendarPreviewCandidates(current.nodes, asOf);
  const publication = { generation: current.generation, publishedAt: current.published_at };
  const common = {
    publication,
    asOf,
    window: feedWindow(asOf),
    cache: publicCache(publication, now),
    sources: await sources(db),
    totals: { nodes: nodes.length },
  };
  const body = page(
    nodes,
    cursor,
    { generation: current.generation, asOf },
    (nodes, nextCursor) => ({ ...common, nodes, nextCursor }),
  );
  return jsonResponse(CalendarNodesResponseSchema.parse(body));
}
/** 与 Feed 完全相同的序列化器和字段组装。仅 namespace 用等长 UUID 占位；不输出凭证。 */
export function previewIcs(
  snapshot: FeedSnapshot,
  config: SubscriptionConfig,
  asOf: number,
  feed: { view_revision: number; changed_at: number } | null,
): string {
  return serializeCalendar(
    personalCalendarNodes(config, snapshot.nodes, asOf).map((item) => {
      const p = item.node.projection;
      const changedAt = (item.node as typeof item.node & { public_changed_at?: number })
        .public_changed_at;
      if (!Number.isSafeInteger(changedAt)) throw new Error("snapshot_missing_public_changed_at");
      return {
        ...feedIdentity(
          "00000000-0000-0000-0000-000000000000",
          p.milestone_id,
          item.node.public_ical_revision,
          feed?.view_revision ?? 0,
        ),
        modifiedAt: Math.max(changedAt as number, feed?.changed_at ?? asOf),
        time: item.time,
        summary: `${p.event.title} · ${p.milestone.title}`,
        description: [p.event.summary, item.patch ? item.node.patch?.fact_reason : null]
          .filter(Boolean)
          .join("\n"),
        url: p.event.official_url,
        cancelled: item.cancelled,
        alarmSeconds: item.alarm_seconds,
      };
    }),
  );
}
export async function readSavedCalendarPreview(
  db: D1Database,
  userId: string,
  url: URL,
  cache: FeedPublicCache,
  now: number,
): Promise<Response> {
  const cursor = cursorFrom(url, true);
  const saved = await readSubscription(db, userId);
  if (!saved.config)
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "subscription", reason: "subscription_uninitialized" }],
    });
  const current = await snapshot(cache, db, now);
  if (!current) return snapshotUnavailable();
  const asOf = asOfFor(current, now, cursor, saved.revision);
  const explained = explainCalendarPreview(saved.config, current.nodes, asOf);
  const required = requiredCalendarSources(saved.config, await sources(db));
  const watermarks = required.map((s) => s.lastSuccessAt);
  const fresh = feedSourcesFresh(watermarks, now);
  const verifiedAt =
    watermarks.length === 0 || watermarks.some((t) => t === null)
      ? null
      : Math.min(...watermarks.filter((t): t is number => t !== null));
  const feed = await db
    .prepare("SELECT view_revision, changed_at FROM calendar_feeds WHERE user_id=?")
    .bind(userId)
    .first<{ view_revision: number; changed_at: number }>();
  let diagnostic = !fresh ? "source_stale" : explained.nodeLimit;
  if (
    diagnostic === null &&
    new TextEncoder().encode(previewIcs(current, saved.config, asOf, feed)).byteLength >
      FEED_RESPONSE_MAX_BYTES
  )
    diagnostic = "response_byte_limit";
  const common = {
    server_time: now,
    subscription: { revision: saved.revision },
    config: CalendarPreviewConfigSchema.parse({
      scope: saved.config.scope,
      calendar: saved.config.calendar,
      notifications: { rule_ids: saved.config.notifications.rule_ids },
    }),
    publication: { generation: current.generation, publishedAt: current.published_at },
    asOf,
    window: feedWindow(asOf),
    sources: { fresh, verifiedAt },
    totals: explained.totals,
    omitted: explained.omitted,
    ...(diagnostic === null ? { outcome: "ok" } : { outcome: "blocked", diagnostic }),
  };
  const body = page(
    explained.items,
    cursor,
    { generation: current.generation, asOf, revision: saved.revision },
    (items, nextCursor) => ({ ...common, items, nextCursor }),
  );
  return jsonResponse(CalendarPreviewResponseSchema.parse(body));
}
