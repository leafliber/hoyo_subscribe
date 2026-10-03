import {
  type CalendarNodesResponse,
  CalendarNodesResponseSchema,
  type CalendarPreviewNode,
  feedWindow,
  PUBLIC_CACHE_FRESH,
} from "@hoyo/contracts";

export class PreviewDataError extends Error {
  constructor(readonly unavailable: boolean) {
    super(unavailable ? "公开数据暂时取不到" : "公开数据未通过完整性校验");
  }
}

/** Only an entire, validated public snapshot may reach the projector. */
export async function downloadCalendarNodes(
  signal: AbortSignal,
  progress: (loaded: number, total: number) => void,
): Promise<CalendarNodesResponse> {
  let restart = false;
  for (;;) {
    let first: CalendarNodesResponse | undefined;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const identities = new Set<string>();
    const nodes: CalendarPreviewNode[] = [];
    for (;;) {
      const url = new URL("/api/v2/calendar/nodes", location.origin);
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      let response: Response;
      try {
        response = await fetch(url, {
          credentials: "omit",
          redirect: "error",
          cache: restart ? "reload" : "default",
          headers: restart ? { "cache-control": "no-cache" } : undefined,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PreviewDataError(true);
      }
      if (response.status === 409) {
        if (restart) throw new PreviewDataError(false);
        restart = true;
        progress(0, 0);
        break; // Discard every page and bypass the browser cache on the next attempt.
      }
      if (!response.ok) throw new PreviewDataError(true);
      let page: CalendarNodesResponse;
      try {
        page = CalendarNodesResponseSchema.parse(await response.json());
      } catch {
        throw new PreviewDataError(false);
      }
      const window = feedWindow(page.asOf);
      if (
        response.redirected ||
        page.asOf < page.publication.publishedAt ||
        page.asOf > Date.now() ||
        page.window.start !== window.start ||
        page.window.end !== window.end ||
        page.cache.stale ||
        page.cache.generatedAt > Date.now() ||
        page.cache.freshUntil <= Date.now() ||
        page.cache.freshUntil > page.cache.generatedAt + PUBLIC_CACHE_FRESH * 1000 ||
        Date.now() - page.asOf >= PUBLIC_CACHE_FRESH * 1000
      )
        throw new PreviewDataError(false);
      if (
        first &&
        (page.publication.generation !== first.publication.generation ||
          page.publication.publishedAt !== first.publication.publishedAt ||
          page.asOf !== first.asOf ||
          page.window.start !== first.window.start ||
          page.window.end !== first.window.end ||
          page.totals.nodes !== first.totals.nodes ||
          JSON.stringify(page.sources) !== JSON.stringify(first.sources))
      )
        throw new PreviewDataError(false);
      first ??= page;
      for (const node of page.nodes) {
        const id = node.projection.milestone_id;
        if (identities.has(id)) throw new PreviewDataError(false);
        identities.add(id);
        nodes.push(node);
      }
      if (nodes.length > first.totals.nodes) throw new PreviewDataError(false);
      progress(nodes.length, first.totals.nodes);
      if (page.nextCursor === null) {
        if (
          nodes.length !== first.totals.nodes ||
          first.cache.freshUntil <= Date.now() ||
          Date.now() - first.asOf >= PUBLIC_CACHE_FRESH * 1000
        )
          throw new PreviewDataError(false);
        return { ...first, nodes, nextCursor: null };
      }
      if (cursors.has(page.nextCursor) || page.nextCursor.length === 0)
        throw new PreviewDataError(false);
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}
