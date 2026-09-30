import {
  decodePublicCursor,
  EVENT_TYPES,
  encodePublicCursor,
  type GameId,
  PUBLIC_READ_LIMITS as LIMITS,
  NODE_TYPES,
  type PublicCache,
  PublicCatalogResponseSchema,
  PublicEventDetailResponseSchema,
  PublicEventsResponseSchema,
  type PublicPublication,
  type PublicScheduleNode,
  type PublicSnapshotNode,
  parsePublicSelection,
  publicCache,
  publicCursorMatches,
  publicEvidence,
  publicImportantNode,
  publicNode,
  publicNodeInWindow,
  publicSourceStatus,
  SUPPORTED_SCOPE,
} from "@hoyo/contracts";
import { ApiError, errorResponse, jsonResponse } from "../shell";
import {
  PUBLIC_CHANGES_SQL,
  PUBLIC_DETAIL_SQL,
  PUBLIC_HEAD_SQL,
  PUBLIC_NOTICE_SQL,
  PUBLIC_PAGE_SQL,
  PUBLIC_PENDING_SQL,
  PUBLIC_SOURCES_SQL,
} from "./queries";

interface Head {
  id: string;
  generation: number;
  published_at: number | null;
}
interface NodeRow {
  milestone_id: string;
  node_json: string | null;
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const unavailable = () => new ApiError("temporarily_unavailable");
const publication = (head: Head | null): PublicPublication | null =>
  head?.published_at === null || !head
    ? null
    : { generation: head.generation, publishedAt: head.published_at };

export function validatePublicQuery(url: URL, allowed: readonly string[] = []): void {
  if (bytes(url.search) > LIMITS.queryBytes) throw new ApiError("validation");
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new ApiError("validation");
  }
}

export function publicResponse(body: { cache: PublicCache }): Response {
  const encoded = JSON.stringify(body);
  if (bytes(encoded) > LIMITS.responseBytes) throw unavailable();
  const response = jsonResponse(body);
  // 不使用 stale-while-revalidate：避免缓存返回 stale:false 的已过期内容。
  const seconds = body.cache.stale
    ? 0
    : Math.max(0, Math.floor((body.cache.freshUntil - body.cache.generatedAt) / 1000));
  response.headers.set("cache-control", `public, max-age=${seconds}, must-revalidate`);
  return response;
}

async function head(db: D1Database): Promise<Head | null> {
  return db.prepare(PUBLIC_HEAD_SQL).first<Head>();
}
async function assertCurrent(db: D1Database, expected: Head): Promise<void> {
  const latest = await head(db);
  if (latest?.id !== expected.id || latest.published_at !== expected.published_at)
    throw new ApiError("conflict");
}
function requirePublication(value: Head | null): { head: Head; publication: PublicPublication } {
  const pub = publication(value);
  if (!value || !pub) throw unavailable();
  return { head: value, publication: pub };
}
function parseNode(row: NodeRow, now: number): PublicSnapshotNode | null {
  if (row.node_json === null) throw unavailable();
  const node = JSON.parse(row.node_json) as PublicSnapshotNode;
  if (
    node?.projection?.milestone_id !== row.milestone_id ||
    !SUPPORTED_SCOPE.games.includes(node.game) ||
    !SUPPORTED_SCOPE.regions.includes(node.region)
  )
    throw unavailable();
  // 与 readCurrentPublicSnapshot 的到期处理相同；业务表现由 contracts 纯函数定义。
  if (node.tombstone && (node.patch?.retain_until ?? 0) <= now) return null;
  const result =
    node.patch !== null && node.patch.retain_until <= now ? { ...node, patch: null } : node;
  publicNode(result); // 闭合 schema 校验；内部字段永不原样透传。
  return result;
}
async function notices(
  db: D1Database,
  nodes: readonly PublicSnapshotNode[],
  publishedAt: number,
): Promise<
  Map<string, { publishedAt: number | null; evidence: ReturnType<typeof publicEvidence> }>
> {
  if (nodes.length === 0) return new Map();
  // 参数只携带有界的公开投影；按页分块，单值远低于 D1 2 MB 限制。
  const result = new Map<
    string,
    { publishedAt: number | null; evidence: ReturnType<typeof publicEvidence> }
  >();
  for (let offset = 0; offset < nodes.length; offset += LIMITS.scanPage) {
    const input = nodes
      .slice(offset, offset + LIMITS.scanPage)
      .map((n) => ({
        id: n.projection.milestone_id,
        eventId: n.projection.event_id,
        projection: n.source_projection_json,
      }));
    const rows = await db
      .prepare(PUBLIC_NOTICE_SQL)
      .bind(LIMITS.nodeBytes, JSON.stringify(input), publishedAt, publishedAt)
      .all<{ id: string; official_published_at: number | null; proposal_json: string | null }>();
    for (const row of rows.results) {
      const node = nodes.find((n) => n.projection.milestone_id === row.id);
      const evidence =
        node && row.proposal_json ? publicEvidence(node, JSON.parse(row.proposal_json)) : null;
      result.set(row.id, {
        publishedAt: evidence === null ? null : row.official_published_at,
        evidence,
      });
    }
  }
  return result;
}

export async function readCatalog(db: D1Database, url: URL, now = Date.now()): Promise<Response> {
  validatePublicQuery(url);
  const pub = publication(await head(db));
  return publicResponse(
    PublicCatalogResponseSchema.parse({
      ...SUPPORTED_SCOPE,
      eventTypes: EVENT_TYPES,
      nodeTypes: NODE_TYPES,
      publication: pub,
      cache: publicCache(pub, now),
    }),
  );
}

export async function readEvents(db: D1Database, url: URL, now = Date.now()): Promise<Response> {
  validatePublicQuery(url, ["range", "games", "cursor"]);
  const selection = parsePublicSelection(url.searchParams, now);
  if (selection === null) throw new ApiError("validation");
  const state = requirePublication(await head(db));
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? null : decodePublicCursor(rawCursor);
  if (rawCursor !== null && cursor === null) throw new ApiError("validation");
  if (cursor !== null && !publicCursorMatches(cursor, selection, state.publication.generation))
    throw new ApiError("conflict");
  const rows = (
    await db
      .prepare(PUBLIC_PAGE_SQL)
      .bind(LIMITS.nodeBytes, state.head.id, cursor?.after ?? "", LIMITS.scanPage + 1)
      .all<NodeRow>()
  ).results;
  const changeRows: NodeRow[] = [];
  for (const game of selection.games) {
    changeRows.push(
      ...(
        await db
          .prepare(PUBLIC_CHANGES_SQL)
          .bind(LIMITS.nodeBytes, state.head.id, game, now, LIMITS.recentChanges + 1)
          .all<NodeRow>()
      ).results,
    );
  }
  const changes = changeRows
    .map((r) => parseNode(r, now))
    .filter((n): n is PublicSnapshotNode => n !== null)
    .sort(
      (a, b) =>
        (b.patch?.retain_until ?? 0) - (a.patch?.retain_until ?? 0) ||
        a.projection.milestone_id.localeCompare(b.projection.milestone_id),
    );
  const selectedChanges = changes.slice(0, LIMITS.recentChanges);
  const page = rows
    .slice(0, LIMITS.scanPage)
    .map((r) => ({ id: r.milestone_id, node: parseNode(r, now) }));
  const selected = page.filter(
    (r): r is { id: string; node: PublicSnapshotNode } =>
      r.node !== null &&
      selection.games.includes(r.node.game) &&
      publicNodeInWindow(r.node, selection.range, now),
  );
  const noticeTimes = await notices(
    db,
    [...selected.map((r) => r.node), ...selectedChanges],
    state.publication.publishedAt,
  );
  const toPublic = (n: PublicSnapshotNode) =>
    publicNode(
      n,
      noticeTimes.get(n.projection.milestone_id)?.publishedAt ?? null,
      noticeTimes.get(n.projection.milestone_id)?.evidence ?? null,
    );
  const makeCursor = (after: string) =>
    encodePublicCursor({
      generation: state.publication.generation,
      start: selection.window.start,
      range: selection.range,
      games: selection.games,
      after,
    });
  const response = {
    publication: state.publication,
    cache: publicCache(state.publication, now),
    window: { start: selection.window.start, end: selection.window.end },
    nodes: [] as PublicScheduleNode[],
    recentChanges: selectedChanges.map(toPublic),
    recentChangesTruncated: changes.length > LIMITS.recentChanges,
    nextCursor: null as string | null,
  };
  let consumed = cursor?.after ?? "";
  for (const item of page) {
    const match = selected.find((r) => r.id === item.id);
    if (match) response.nodes.push(toPublic(match.node));
    response.nextCursor = makeCursor(item.id);
    if (bytes(JSON.stringify(response)) > LIMITS.responseBytes) {
      if (!match || response.nodes.length === 1) throw unavailable();
      response.nodes.pop();
      response.nextCursor = makeCursor(consumed);
      await assertCurrent(db, state.head);
      return publicResponse(PublicEventsResponseSchema.parse(response));
    }
    consumed = item.id;
  }
  response.nextCursor = rows.length > LIMITS.scanPage ? makeCursor(consumed) : null;
  await assertCurrent(db, state.head);
  return publicResponse(PublicEventsResponseSchema.parse(response));
}

export async function readEventDetail(
  db: D1Database,
  url: URL,
  id: string,
  now = Date.now(),
): Promise<Response> {
  validatePublicQuery(url);
  if (!id || bytes(id) > LIMITS.queryBytes || id.includes("/")) throw new ApiError("validation");
  const state = requirePublication(await head(db));
  const rows = (
    await db
      .prepare(PUBLIC_DETAIL_SQL)
      .bind(LIMITS.nodeBytes, state.head.id, id, LIMITS.detailNodes + 1)
      .all<NodeRow>()
  ).results;
  if (rows.length > LIMITS.detailNodes) throw unavailable();
  const nodes = rows
    .map((r) => parseNode(r, now))
    .filter((n): n is PublicSnapshotNode => n !== null && !n.tombstone);
  if (!nodes.length) {
    await assertCurrent(db, state.head);
    return errorResponse(
      "validation",
      { code: "validation", fields: [{ path: "$path", reason: "not_found" }] },
      404,
    );
  }
  const times = await notices(db, nodes, state.publication.publishedAt);
  const milestones = nodes.map((n) =>
    publicNode(
      n,
      times.get(n.projection.milestone_id)?.publishedAt ?? null,
      times.get(n.projection.milestone_id)?.evidence ?? null,
    ),
  );
  const first = milestones[0];
  const facts = nodes[0]?.projection.event;
  if (!first || !facts) throw unavailable();
  const dates = new Set(milestones.map((n) => n.noticePublishedAt));
  const body = PublicEventDetailResponseSchema.parse({
    publication: state.publication,
    cache: publicCache(state.publication, now),
    event: {
      id,
      title: first.title,
      game: first.game,
      eventType: first.eventType,
      status: first.status,
      importantNodeId: publicImportantNode(milestones, now),
      milestones,
      changes: milestones.flatMap((n) =>
        n.change === null ? [] : [{ nodeId: n.id, change: n.change }],
      ),
      official: {
        url: facts.official_url,
        publisher: null,
        publishedAt: dates.size === 1 ? first.noticePublishedAt : null,
        updatedAt: null,
        excerpts: milestones.map((n) => n.evidence),
      },
    },
  });
  await assertCurrent(db, state.head);
  return publicResponse(body);
}

export async function readPublicStatus(db: D1Database, now = Date.now()) {
  const pub = publication(await head(db));
  const pending = (
    await db
      .prepare(PUBLIC_PENDING_SQL)
      .bind(LIMITS.pendingCandidates + 1)
      .all<{ game: string | null }>()
  ).results;
  if (
    pending.length > LIMITS.pendingCandidates ||
    pending.some((r) => !SUPPORTED_SCOPE.games.includes(r.game as GameId))
  )
    throw unavailable();
  const sources = [];
  for (const game of SUPPORTED_SCOPE.games) {
    const rows = (
      await db
        .prepare(PUBLIC_SOURCES_SQL)
        .bind(game, LIMITS.sourcesPerGame + 1)
        .all<{ last_success_at: number | null; verification_state: string }>()
    ).results;
    if (rows.length > LIMITS.sourcesPerGame) throw unavailable();
    sources.push(publicSourceStatus(game, rows, pending.filter((r) => r.game === game).length));
  }
  return {
    publication: pub,
    cache: publicCache(pub, now),
    sources,
    capabilities: {
      calendar: "unknown",
      email_seats: "unknown",
      routine_email: "unknown",
      push: "unknown",
    },
    calendarClients: [
      { client: "apple_calendar_macos", support: "verified" },
      { client: "google_calendar", support: "unknown" },
      { client: "outlook", support: "unknown" },
    ],
  };
}
