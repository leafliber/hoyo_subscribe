import type {
  BrowseFilters,
  PublicCatalogResponse,
  PublicEventsResponse,
  PublicStatusResponse,
} from "@hoyo/contracts";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";

export interface ScheduleLoadState {
  pages: PublicEventsResponse[];
  catalog: PublicCatalogResponse | null;
  status: PublicStatusResponse | null;
  phase: "loading" | "ready" | "failed";
  error: unknown;
  metadataFailed: boolean;
  metadataError: unknown;
  retryAt: number;
}
/** 单页生命周期内的公共副本，不落盘，不涉及私人缓存。 */
export class ScheduleLoader {
  state: ScheduleLoadState = {
    pages: [],
    catalog: null,
    status: null,
    phase: "loading",
    error: null,
    metadataFailed: false,
    metadataError: null,
    retryAt: 0,
  };
  private controller = new AbortController();
  private revision = 0;
  private selection: Pick<BrowseFilters, "range" | "games"> | null = null;
  private cursor: string | undefined;
  constructor(
    private readonly changed: () => void,
    private readonly api = new PublicApiClient(),
  ) {}

  start(selection: Pick<BrowseFilters, "range" | "games">, refresh = false) {
    const same = JSON.stringify(this.selection) === JSON.stringify(selection);
    this.selection = { range: selection.range, games: [...selection.games] };
    if (Date.now() < this.state.retryAt) {
      if (!same) {
        this.state.pages = [];
        this.cursor = undefined;
      }
      this.changed();
      return;
    }
    this.controller.abort();
    this.controller = new AbortController();
    const revision = ++this.revision;
    if (!same) this.state.pages = [];
    this.cursor = undefined;
    this.state.phase = "loading";
    this.state.error = null;
    this.state.retryAt = 0;
    this.changed();
    void this.metadata(revision, refresh);
    void this.drain(revision, refresh);
  }
  retry() {
    if (this.state.phase === "loading" || Date.now() < this.state.retryAt || !this.selection)
      return;
    if (this.state.phase === "ready") {
      this.start(this.selection, true);
      return;
    }
    this.state.phase = "loading";
    this.state.error = null;
    this.changed();
    void this.metadata(this.revision, true);
    void this.drain(this.revision, true);
  }
  private async metadata(revision: number, refresh: boolean) {
    const signal = this.controller.signal;
    const results = await Promise.allSettled([
      this.api.catalog(signal, refresh),
      this.api.status(signal, refresh),
    ]);
    if (revision !== this.revision || signal.aborted) return;
    const [catalog, status] = results;
    this.state.metadataFailed = catalog.status === "rejected" || status.status === "rejected";
    this.state.metadataError =
      catalog.status === "rejected"
        ? catalog.reason
        : status.status === "rejected"
          ? status.reason
          : null;
    for (const result of results)
      if (result.status === "rejected" && result.reason instanceof PublicReadError) {
        this.state.retryAt = Math.max(
          this.state.retryAt,
          Date.now() + (result.reason.retryAfterMs ?? 0),
        );
      }
    if (catalog.status === "fulfilled") this.state.catalog = catalog.value;
    if (status.status === "fulfilled") this.state.status = status.value;
    this.changed();
  }
  private async drain(revision: number, reload: boolean) {
    if (!this.selection) return;
    const selection = this.selection;
    const signal = this.controller.signal;
    let restarted = false;
    const seen = new Set<string>();
    while (revision === this.revision && !signal.aborted) {
      try {
        const page = await this.api.events(selection, this.cursor, signal, reload);
        if (revision !== this.revision || signal.aborted) return;
        const first = this.state.pages[0];
        if (
          this.cursor !== undefined &&
          first &&
          (page.publication.generation !== first.publication.generation ||
            JSON.stringify(page.window) !== JSON.stringify(first.window))
        )
          throw new PublicReadError("http", 409);
        if (
          page.nextCursor !== null &&
          (page.nextCursor === this.cursor || seen.has(page.nextCursor))
        )
          throw new PublicReadError("invalid_response", 200);
        this.state.pages = this.cursor === undefined ? [page] : [...this.state.pages, page];
        if (page.nextCursor === null) {
          this.cursor = undefined;
          this.state.phase = "ready";
          this.changed();
          return;
        }
        seen.add(page.nextCursor);
        this.cursor = page.nextCursor;
        this.changed();
      } catch (error) {
        if (revision !== this.revision || signal.aborted) return;
        if (error instanceof PublicReadError && error.status === 409) {
          this.state.pages = [];
          this.cursor = undefined;
          this.changed();
          if (!restarted) {
            restarted = true;
            reload = true;
            seen.clear();
            continue;
          }
        }
        this.state.error = error;
        this.state.retryAt =
          Date.now() + (error instanceof PublicReadError ? (error.retryAfterMs ?? 0) : 0);
        this.state.phase = "failed";
        this.changed();
        return;
      }
    }
  }
}
