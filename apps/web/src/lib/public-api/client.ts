import {
  type ApiErrorBody,
  type BrowseFilters,
  isApiErrorBody,
  PublicCatalogResponseSchema,
  PublicEventDetailResponseSchema,
  PublicEventsResponseSchema,
  PublicStatusResponseSchema,
} from "@hoyo/contracts";

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

/** 响应类型与校验器直接消费 contracts；不持久化数据、不创建身份或续期。 */
export class PublicApiClient {
  constructor(private readonly request: PublicFetch = (path, init) => fetch(path, init)) {}

  private async read<T>(path: string, schema: { parse(value: unknown): T }, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await this.request(path, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        cache: "no-cache",
        signal,
        headers: { Accept: "application/json" },
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
        throw error;
      throw new PublicReadError("network", null);
    }
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
    try {
      return schema.parse(value);
    } catch {
      throw new PublicReadError("invalid_response", response.status);
    }
  }

  catalog(signal?: AbortSignal) {
    return this.read("/api/v2/catalog", PublicCatalogResponseSchema, signal);
  }

  events(selection: Pick<BrowseFilters, "games" | "range">, cursor?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({
      games: selection.games.join(","),
      range: selection.range,
    });
    if (cursor !== undefined) params.set("cursor", cursor);
    return this.read(`/api/v2/events?${params}`, PublicEventsResponseSchema, signal);
  }

  detail(eventId: string, signal?: AbortSignal) {
    return this.read(
      `/api/v2/events/${encodeURIComponent(eventId)}`,
      PublicEventDetailResponseSchema,
      signal,
    );
  }

  status(signal?: AbortSignal) {
    return this.read("/api/v2/status", PublicStatusResponseSchema, signal);
  }
}
