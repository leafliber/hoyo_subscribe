import {
  type BrowseFilters,
  type BrowseRange,
  browseWindow,
  type PublicCatalogResponse,
  type PublicEventsResponse,
  PublicEventsResponseSchema,
  type PublicRedeemCodesResponse,
  type PublicStatusResponse,
} from "@hoyo/contracts";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";

export interface ScheduleLoadState {
  pages: PublicEventsResponse[];
  /** pages 属于哪个浏览范围（"显示更多"读取下一档期间，页面照常显示这一档）。 */
  loadedRange: BrowseRange | null;
  /** "显示更多"正在读取的下一档；读完整体换上，期间不清空已显示的条目（ADR-0017）。 */
  extending: BrowseRange | null;
  /** ADR-0032：切换筛选或刷新时新的一档正在后台读取，旧列表暂时保留（页面淡化显示）。 */
  switching: boolean;
  /** ADR-0032：当前列表直接取自本标签页的副本（站内切换回来、切回读过的筛选）：原地出现，不播放入场动效。 */
  restored: boolean;
  catalog: PublicCatalogResponse | null;
  status: PublicStatusResponse | null;
  /** ADR-0030「有效兑换码」条；读取失败时为 null，条不出现（不影响日程与来源提示）。 */
  redeem: PublicRedeemCodesResponse | null;
  phase: "loading" | "ready" | "failed";
  error: unknown;
  metadataFailed: boolean;
  metadataError: unknown;
  retryAt: number;
}
/**
 * 日程页的公开数据。ADR-0032：响应另在本标签页留副本（lib/public-api/store.ts，只有公开数据），
 * 站内切换回来直接显示、按需核对；不涉及私人缓存。
 */
export class ScheduleLoader {
  state: ScheduleLoadState = {
    pages: [],
    loadedRange: null,
    extending: null,
    switching: false,
    restored: false,
    catalog: null,
    status: null,
    redeem: null,
    phase: "loading",
    error: null,
    metadataFailed: false,
    metadataError: null,
    retryAt: 0,
  };
  private controller = new AbortController();
  private revision = 0;
  /** 元数据（目录、状态、兑换码）独立于筛选：本页第一次与用户刷新时读取，切换筛选不重读（ADR-0032）。 */
  private metadataController = new AbortController();
  private metadataRevision = 0;
  private metadataStarted = false;
  private selection: Pick<BrowseFilters, "range" | "games"> | null = null;
  private cursor: string | undefined;
  /** 正在后台换上的这一档与旧列表筛选不同：读取失败时旧列表不能留作新筛选的结果。 */
  private discardOnFailure = false;
  constructor(
    private readonly changed: () => void,
    private readonly api = new PublicApiClient(),
  ) {}

  /**
   * ADR-0032：本标签页读过的这一档日程（各页同代、同窗口、今天的窗口）直接拿来显示，不出骨架；
   * 副本已过 CLIENT_RECHECK_INTERVAL 时再用条件请求核对首页，没变就不再下载。缺页、换代或跨日则为 null。
   */
  private cachedChain(selection: Pick<BrowseFilters, "range" | "games">) {
    const first = this.api.peek(
      PublicApiClient.eventsPath(selection),
      PublicEventsResponseSchema,
    )?.value;
    if (!first || first.window.start !== browseWindow(selection.range, Date.now()).start)
      return null;
    const pages = [first];
    const seen = new Set<string>();
    for (let cursor = first.nextCursor; cursor !== null; ) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const page = this.api.peek(
        PublicApiClient.eventsPath(selection, cursor),
        PublicEventsResponseSchema,
      )?.value;
      if (
        !page ||
        page.publication.generation !== first.publication.generation ||
        JSON.stringify(page.window) !== JSON.stringify(first.window)
      )
        return null;
      pages.push(page);
      cursor = page.nextCursor;
    }
    // 同一代的各页一起核对过：都按首页最近一次核对的时间算新鲜期。
    return pages.map((page) => ({ ...page, cache: first.cache }));
  }

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
    this.state.extending = null;
    this.cursor = undefined;
    if (waiting) {
      if (!same) this.state.pages = [];
      this.state.switching = false;
      this.state.phase = "failed";
      this.state.error = this.state.metadataError ?? this.state.error;
      this.changed();
      return;
    }
    this.state.error = null;
    this.state.retryAt = 0;
    if (refresh || !this.metadataStarted) this.loadMetadata(refresh);
    const cached = refresh ? null : this.cachedChain(selection);
    if (cached) {
      this.state.pages = cached;
      this.state.loadedRange = selection.range;
      this.state.switching = false;
      this.state.restored = true;
      this.state.phase = "ready";
      this.changed();
      if (!this.api.isFresh(PublicApiClient.eventsPath(selection)))
        void this.recheck(revision, selection);
      return;
    }
    // 已有列表（切换筛选或刷新）时旧列表保留到新的一档读完再整体换上，不退回骨架；首次加载逐页显示。
    const buffered = this.state.pages.length > 0;
    if (!buffered) this.state.loadedRange = selection.range;
    this.state.switching = buffered;
    this.discardOnFailure = buffered && !same;
    this.state.phase = "loading";
    this.changed();
    void this.drain(revision, refresh, buffered);
  }
  /**
   * 按需核对（ADR-0032）：标签页回到前台等时机调用。只有超过 CLIENT_RECHECK_INTERVAL 的部分才问服务端，
   * 用条件请求，内容没变就不下载、不重绘列表。
   */
  recheckIfStale() {
    if (this.state.phase !== "ready" || !this.selection) return;
    const selection = this.selection;
    if (!this.api.isFresh(PublicApiClient.eventsPath(selection)))
      void this.recheck(this.revision, selection);
    if (!this.api.metadataFresh()) this.loadMetadata(false);
  }
  /** 副本过了核对间隔：问一次首页；没变（304）只更新核对时间，变了再按新的一档整体换上。 */
  private async recheck(revision: number, selection: Pick<BrowseFilters, "range" | "games">) {
    const signal = this.controller.signal;
    try {
      const result = await this.api.load(
        PublicApiClient.eventsPath(selection),
        PublicEventsResponseSchema,
        signal,
        "fresh",
      );
      if (revision !== this.revision || signal.aborted) return;
      if (result.from === "not_modified") {
        this.state.pages = this.state.pages.map((page) => ({ ...page, cache: result.value.cache }));
        this.changed();
        return;
      }
      this.state.phase = "loading";
      this.changed();
      void this.drain(revision, true, true, result.value);
    } catch (error) {
      if (revision !== this.revision || signal.aborted) return;
      // 核对失败：已有副本照旧显示（它带着自己的信息获取时间），末行如实写读取失败并给出重试，
      // 与刷新失败时一样（旧列表保留）。
      this.state.error = error;
      this.state.retryAt =
        Date.now() + (error instanceof PublicReadError ? (error.retryAfterMs ?? 0) : 0);
      this.state.phase = "failed";
      this.changed();
    }
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
    // ADR-0032：这一档本标签页读过就直接换上。
    const cached = this.cachedChain(selection);
    if (cached) {
      this.state.pages = cached;
      this.state.loadedRange = selection.range;
      this.state.extending = null;
      this.state.restored = true;
      this.state.phase = "ready";
      this.changed();
      if (!this.api.isFresh(PublicApiClient.eventsPath(selection)))
        void this.recheck(revision, selection);
      return;
    }
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
    else this.loadMetadata(true);
    void this.drain(this.revision, true, buffered);
  }
  private loadMetadata(refresh: boolean) {
    this.metadataStarted = true;
    this.metadataController.abort();
    this.metadataController = new AbortController();
    void this.metadata(++this.metadataRevision, refresh);
  }
  private async metadata(revision: number, refresh: boolean) {
    const signal = this.metadataController.signal;
    const [redeem, ...results] = await Promise.allSettled([
      this.api.redeemCodes(signal, refresh),
      this.api.catalog(signal, refresh),
      this.api.status(signal, refresh),
    ]);
    if (revision !== this.metadataRevision || signal.aborted) return;
    const [catalog, status] = results;
    if (redeem.status === "fulfilled") this.state.redeem = redeem.value;
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
  /**
   * buffered：页先收在本地，读完整体换上；失败时已显示的条目原样保留（"显示更多"、切换筛选与刷新用）。
   * seed：已经取到的首页（核对时发现变了），从它的下一页接着读。
   */
  private async drain(
    revision: number,
    reload: boolean,
    buffered = false,
    seed?: PublicEventsResponse,
  ) {
    if (!this.selection) return;
    const selection = this.selection;
    const signal = this.controller.signal;
    let restarted = false;
    const seen = new Set<string>();
    let collected: PublicEventsResponse[] = seed ? [seed] : [];
    if (seed) {
      if (seed.nextCursor === null) {
        this.state.pages = collected;
        this.state.restored = false;
        this.state.loadedRange = selection.range;
        this.state.extending = null;
        this.state.switching = false;
        this.state.phase = "ready";
        this.changed();
        return;
      }
      seen.add(seed.nextCursor);
      this.cursor = seed.nextCursor;
    }
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
        else {
          this.state.pages = this.cursor === undefined ? [page] : [...this.state.pages, page];
          this.state.restored = false;
        }
        if (page.nextCursor === null) {
          this.cursor = undefined;
          if (buffered) {
            this.state.pages = collected;
            this.state.restored = false;
            this.state.loadedRange = selection.range;
            this.state.extending = null;
          }
          this.state.switching = false;
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
        // 切换筛选时读取失败：旧列表属于别的筛选，不能当成新筛选的结果留着；刷新失败则照旧保留。
        if (this.state.switching && this.discardOnFailure) this.state.pages = [];
        this.state.switching = false;
        this.state.phase = "failed";
        this.changed();
        return;
      }
    }
  }
}
