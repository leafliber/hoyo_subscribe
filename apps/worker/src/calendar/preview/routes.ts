import { PUBLIC_CACHE_FRESH, RATE_WINDOWS_MAX } from "@hoyo/contracts";
import { ApiError, errorResponse } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import { FeedPublicCache } from "../feed/public-read";
import { readCalendarNodes, readSavedCalendarPreview, snapshotUnavailable } from "./read";

/** 每 isolate 共用 FeedPublicCache；只在路由边界附传输头，不处理任何 Cookie。 */
export function makeCalendarPreviewRoutes(
  deps: { cache?: FeedPublicCache; now?: () => number } = {},
): readonly ShellRoute[] {
  const cache = deps.cache ?? new FeedPublicCache(),
    now = deps.now ?? Date.now;
  // 无新增频率参数：沿用管理路由的同主体在途请求合并保护，簿记受注册表上限限制。
  const busy = new Set<string>();
  async function respond(work: () => Promise<Response>, privateRead: boolean) {
    let response: Response;
    try {
      response = await work();
    } catch (error) {
      response =
        error instanceof ApiError
          ? errorResponse(error.code, error.details)
          : snapshotUnavailable();
    }
    response.headers.set(
      "cache-control",
      !privateRead && response.ok ? `public, max-age=${PUBLIC_CACHE_FRESH}` : "private, no-store",
    );
    return response;
  }
  return [
    {
      method: "GET",
      pattern: "/api/v2/calendar/nodes",
      domain: "public",
      write: false,
      handler: (ctx) => respond(() => readCalendarNodes(ctx.env.DB, ctx.url, cache, now()), false),
    },
    {
      method: "GET",
      pattern: "/api/v2/me/calendar/preview",
      domain: "user",
      write: false,
      handler: (ctx) =>
        respond(async () => {
          const auth = ctx.auth;
          if (auth.kind !== "session" || auth.domain !== "user")
            throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
          if (busy.has(auth.sessionId) || busy.size >= RATE_WINDOWS_MAX)
            throw new ApiError("rate_limited", { code: "rate_limited" });
          busy.add(auth.sessionId);
          try {
            return await readSavedCalendarPreview(ctx.env.DB, auth.userId, ctx.url, cache, now());
          } finally {
            busy.delete(auth.sessionId);
          }
        }, true),
    },
  ];
}
