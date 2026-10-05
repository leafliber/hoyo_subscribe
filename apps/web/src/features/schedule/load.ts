import type {
  BrowseFilters,
  BrowseRange,
  PublicCatalogResponse,
  PublicEventsResponse,
  PublicStatusResponse,
} from "@hoyo/contracts";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";

export interface ScheduleLoadState {
  pages: PublicEventsResponse[];
  /** pages 属于哪个浏览范围（"显示更多"读取下一档期间，页面照常显示这一档）。 */
  loadedRange: BrowseRange | null;
  /** "显示更多"正在读取的下一档；读完整体换上，期间不清空已显示的条目（ADR-0017）。 */
  extending: BrowseRange | null;
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
    loadedRange: null,
    extending: null,
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
    const waiting = Date.now() < this.state.retryAt;
    if (same && waiting) {
      this.changed();
      return;
    }
    // 筛选身份先失效，再判断能否发请求；取消失败时 revision 仍挡住旧响应和续页。
    this.controller.abort();
    this.controller = new AbortController();
    const revision = ++this.revision;
    if (!same) this.state.pages = [];
    this.state.loadedRange = selection.range;
    this.state.extending = null;
    this.cursor = undefined;
    if (waiting) {
      this.state.phase = "failed";
      this.state.error = this.state.metadataError ?? this.state.error;
      this.changed();
      return;
    }
    this.state.phase = "loading";
    this.state.error = null;
    this.state.retryAt = 0;
    this.changed();
    void this.metadata(revision, refresh);
    void this.drain(revision, refresh);
  }
  /**
   * "显示更多"：读取更大的一档。已显示的条目照常保留，下一档在后台读完后整体换上——
   * 公开分页按节点身份排序，不按时间，逐页替换会让已显示的条目先消失再回来（ADR-0017）。
   * 窗口都从今天起，大档包含小档，换上后新条目接在原来最后一天之后。
   */
  extend(selection: Pick<BrowseFilters, "range" | "games">) {
    if (this.state.phase !== "ready" || this.state.pages.length === 0) {
      this.start(selection);
      return;
    }
    this.selection = { range: selection.range, games: [...selection.games] };
    this.controller.abort();
    this.controller = new AbortController();
    const revision = ++this.revision;
    this.cursor = undefined;
    this.state.extending = selection.range;
    this.state.phase = "loading";
    this.state.error = null;
    this.changed();
    void this.drain(revision, false, true);
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
    const buffered = this.state.extending !== null;
    if (buffered) this.cursor = undefined;
    else void this.metadata(this.revision, true);
    void this.drain(this.revision, true, buffered);
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
  /** buffered：页先收在本地，读完整体换上；失败时已显示的条目原样保留（"显示更多"用）。 */
  private async drain(revision: number, reload: boolean, buffered = false) {
    if (!this.selection) return;
    const selection = this.selection;
    const signal = this.controller.signal;
    let restarted = false;
    const seen = new Set<string>();
    let collected: PublicEventsResponse[] = [];
    while (revision === this.revision && !signal.aborted) {
      try {
        const page = await this.api.events(selection, this.cursor, signal, reload);
        if (revision !== this.revision || signal.aborted) return;
        const first = buffered ? collected[0] : this.state.pages[0];
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
        if (buffered) collected = this.cursor === undefined ? [page] : [...collected, page];
        else this.state.pages = this.cursor === undefined ? [page] : [...this.state.pages, page];
        if (page.nextCursor === null) {
          this.cursor = undefined;
          if (buffered) {
            this.state.pages = collected;
            this.state.loadedRange = selection.range;
            this.state.extending = null;
          }
          this.state.phase = "ready";
          this.changed();
          return;
        }
        seen.add(page.nextCursor);
        this.cursor = page.nextCursor;
        if (!buffered) this.changed();
      } catch (error) {
        if (revision !== this.revision || signal.aborted) return;
        if (error instanceof PublicReadError && error.status === 409) {
          if (buffered) collected = [];
          else this.state.pages = [];
          this.cursor = undefined;
          if (!buffered) this.changed();
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
