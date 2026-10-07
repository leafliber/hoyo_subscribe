import {
  type ApiErrorBody,
  type BrowseFilters,
  CLIENT_RECHECK_INTERVAL,
  isApiErrorBody,
  PublicCatalogResponseSchema,
  PublicEventDetailResponseSchema,
  PublicEventsResponseSchema,
  PublicRedeemCodesResponseSchema,
  PublicStatusResponseSchema,
} from "@hoyo/contracts";
import { checkedThisPage, forgetStored, pageReloaded, readStored, writeStored } from "./store";

/** 只接受本模块生成的相对公共路径；注入点供离线测试使用。 */
type PublicFetch = (path: string, init: RequestInit) => Promise<Response>;

export class PublicReadError extends Error {
  constructor(
    readonly kind: "http" | "network" | "invalid_response",
    readonly status: number | null,
    readonly body: ApiErrorBody | null = null,
  ) {
    // 不把自由服务端文本、URL 或响应体写入错误消息/日志。
    super("公共数据读取未完成");
    this.name = "PublicReadError";
  }

  get retryAfterMs(): number | null {
    const detail = this.body?.error.details;
    return detail?.code === "rate_limited" || detail?.code === "temporarily_unavailable"
      ? (detail.retry_after_ms ?? null)
      : null;
  }
}

/** 读取方式：cached 先用页面副本（ADR-0032），fresh 立即向服务端核对（刷新按钮、重试）。 */
export type ReadMode = "cached" | "fresh";
/** 一次读取的结果来源：副本直接复用 / 服务端确认没变（304）/ 服务端给了新内容。 */
export type ReadSource = "cache" | "not_modified" | "network";
export interface ReadResult<T> {
  readonly value: T;
  readonly from: ReadSource;
}

export type PublicCapability = "open" | "closed" | "unknown";
export type PublicCapabilities = Record<"calendar" | "push" | "email_seats", PublicCapability>;
/** 只读能力开关的宽松视图：缺项或未知取值都按 unknown，不据此说"不可用"。 */
const PublicCapabilitiesView = {
  parse(value: unknown): PublicCapabilities {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("status");
    const raw = (value as { capabilities?: Record<string, unknown> }).capabilities;
    const read = (item: unknown): PublicCapability =>
      item === "open" || item === "closed" ? item : "unknown";
    return {
      calendar: read(raw?.calendar),
      push: read(raw?.push),
      email_seats: read(raw?.email_seats),
    };
  },
};

const defaultFetch: PublicFetch = (path, init) => fetch(path, init);
/** 一次向服务端的读取（尚未按调用方的视图校验）。 */
interface RawRead {
  readonly body: unknown;
  readonly from: Exclude<ReadSource, "cache">;
  readonly status: number;
  readonly etag: string | null;
  readonly checkedAt: number;
}
/** 同一页面里同时发出的同一公开读取只请求一次（只对真实 fetch 生效）。 */
const inflight = new Map<string, Promise<RawRead>>();

/** 副本里的 cache 字段按最近一次核对的时间改写：核对过就算这一刻的信息，新鲜期跨度沿用服务端给的。 */
function confirmedAt(body: unknown, at: number): unknown {
  if (body === null || typeof body !== "object" || !("cache" in body)) return body;
  const cache = (body as { cache?: { generatedAt?: unknown; freshUntil?: unknown } }).cache;
  if (typeof cache?.generatedAt !== "number" || typeof cache.freshUntil !== "number") return body;
  return {
    ...body,
    cache: {
      generatedAt: at,
      freshUntil: at + (cache.freshUntil - cache.generatedAt),
      stale: false,
    },
  };
}

/**
 * 响应类型与校验器直接消费 contracts；不创建身份或续期。
 * ADR-0032：公开响应在本标签页留一份副本（store.ts），站内切换时直接复用，超过 CLIENT_RECHECK_INTERVAL
 * 或用户主动刷新时带 If-None-Match 向服务端核对；绕过浏览器 HTTP 缓存（no-store），新鲜与否由这里决定。
 */
export class PublicApiClient {
  constructor(private readonly request: PublicFetch = defaultFetch) {}

  /** 只读页面副本，不发请求；没有或形状不符时为 null。用于首屏立即显示。 */
  peek<T>(path: string, schema: { parse(value: unknown): T }): ReadResult<T> | null {
    const stored = readStored(path);
    if (stored === null) return null;
    try {
      return { value: schema.parse(stored.body), from: "cache" };
    } catch {
      forgetStored(path);
      return null;
    }
  }

  /** 副本是否已核对过足够近（不需要再问服务端）；刷新进入的页面只认本页加载之后的核对。 */
  isFresh(path: string, now = Date.now()): boolean {
    const stored = readStored(path);
    if (stored === null) return false;
    if (pageReloaded && !checkedThisPage.has(path)) return false;
    return now - stored.checkedAt < CLIENT_RECHECK_INTERVAL * 1000;
  }

  /** 日程页的目录、状态、兑换码副本是否都在核对间隔内。 */
  metadataFresh(now = Date.now()): boolean {
    return ["/api/v2/catalog", "/api/v2/status", "/api/v2/redeem-codes"].every((path) =>
      this.isFresh(path, now),
    );
  }

  async load<T>(
    path: string,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
    mode: ReadMode = "cached",
  ): Promise<ReadResult<T>> {
    if (mode === "cached" && this.isFresh(path)) {
      const cached = this.peek(path, schema);
      if (cached) return cached;
    }
    const shared = this.request === defaultFetch;
    const key = `${mode}:${path}`;
    let task = shared ? inflight.get(key) : undefined;
    if (!task) {
      // 共用的请求不带某一个调用方的取消信号：一处取消不影响同时在等的其他读取。
      task = this.revalidate(path, shared ? undefined : signal);
      if (shared) {
        inflight.set(key, task);
        void task.then(
          () => inflight.delete(key),
          () => inflight.delete(key),
        );
      }
    }
    const raw = await task;
    signal?.throwIfAborted();
    // 共用的是原始正文，各调用方按自己的视图校验（同一路径可能有严格与宽松两种读法）。
    let value: T;
    try {
      value = schema.parse(raw.body);
    } catch {
      forgetStored(path);
      throw new PublicReadError("invalid_response", raw.status);
    }
    writeStored(path, { etag: raw.etag, body: raw.body, checkedAt: raw.checkedAt });
    return { value, from: raw.from };
  }

  private async revalidate(path: string, signal?: AbortSignal): Promise<RawRead> {
    const stored = readStored(path);
    let response: Response;
    try {
      response = await this.request(path, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        // 新鲜与否由页面副本与条件请求决定，不让浏览器 HTTP 缓存在中间悄悄复用。
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          ...(stored?.etag ? { "If-None-Match": stored.etag } : {}),
        },
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
        throw error;
      throw new PublicReadError("network", null);
    }
    const now = Date.now();
    if (response.status === 304 && stored !== null)
      return {
        body: confirmedAt(stored.body, now),
        from: "not_modified",
        status: 304,
        etag: stored.etag,
        checkedAt: now,
      };
    let value: unknown;
    try {
      value = await response.json();
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PublicReadError(response.ok ? "invalid_response" : "http", response.status);
    }
    if (!response.ok)
      throw new PublicReadError("http", response.status, isApiErrorBody(value) ? value : null);
    return {
      body: value,
      from: "network",
      status: response.status,
      etag: response.headers.get("etag"),
      checkedAt: now,
    };
  }

  private async read<T>(
    path: string,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
    reload = false,
  ): Promise<T> {
    return (await this.load(path, schema, signal, reload ? "fresh" : "cached")).value;
  }

  /** 日程一页的路径（副本键与请求地址相同）。 */
  static eventsPath(selection: Pick<BrowseFilters, "games" | "range">, cursor?: string): string {
    const params = new URLSearchParams({
      games: selection.games.join(","),
      range: selection.range,
    });
    if (cursor !== undefined) params.set("cursor", cursor);
    return `/api/v2/events?${params}`;
  }

  catalog(signal?: AbortSignal, reload = false) {
    return this.read("/api/v2/catalog", PublicCatalogResponseSchema, signal, reload);
  }

  events(
    selection: Pick<BrowseFilters, "games" | "range">,
    cursor?: string,
    signal?: AbortSignal,
    reload = false,
  ) {
    return this.read(
      PublicApiClient.eventsPath(selection, cursor),
      PublicEventsResponseSchema,
      signal,
      reload,
    );
  }

  static detailPath(eventId: string): string {
    return `/api/v2/events/${encodeURIComponent(eventId)}`;
  }

  detail(eventId: string, signal?: AbortSignal, reload = false) {
    return this.read(
      PublicApiClient.detailPath(eventId),
      PublicEventDetailResponseSchema,
      signal,
      reload,
    );
  }

  /** P3-22（ADR-0014）：活动依据的官方公告原文——本站采集时保存的不可变版本，不直连官方（读取见 article-dialog）。 */
  static articlesPath(eventId: string): string {
    return `${PublicApiClient.detailPath(eventId)}/articles`;
  }

  status(signal?: AbortSignal, reload = false) {
    return this.read("/api/v2/status", PublicStatusResponseSchema, signal, reload);
  }

  /**
   * 公开能力开关（订阅页的日历、Push、邮件入口）。ADR-0032：与日程页、状态页共用 `/api/v2/status` 的副本，
   * 订阅页三处读取合成一次；只取 capabilities，其余字段不在这里校验。读取失败由调用方按 unknown 处理。
   */
  async capabilities(signal?: AbortSignal): Promise<PublicCapabilities> {
    return (await this.load("/api/v2/status", PublicCapabilitiesView, signal)).value;
  }

  /** ADR-0030：「有效兑换码」条（米游社官方直播页的兑换码，只含仍在显示期内的）。 */
  redeemCodes(signal?: AbortSignal, reload = false) {
    return this.read("/api/v2/redeem-codes", PublicRedeemCodesResponseSchema, signal, reload);
  }
}
