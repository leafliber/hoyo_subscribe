import { ApiError, errorResponse } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import { FeedPublicCache } from "../feed/public-read";
import { CalendarPreviewRateGate } from "./rate";
import { readCalendarNodes, readSavedCalendarPreview, snapshotUnavailable } from "./read";

/** 每 isolate 共用 FeedPublicCache；只在路由边界附传输头，不处理任何 Cookie。 */
export function makeCalendarPreviewRoutes(
  deps: { cache?: FeedPublicCache; now?: () => number } = {},
): readonly ShellRoute[] {
  const cache = deps.cache ?? new FeedPublicCache(),
    now = deps.now ?? Date.now;
  const rate = new CalendarPreviewRateGate();
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
    // ADR-0015：公开预览与公开日程一致，浏览器每次都向源站取最新。
    response.headers.set(
      "cache-control",
      !privateRead && response.ok ? "no-cache" : "private, no-store",
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
          const at = now();
          const retryAfterMs = rate.take(auth.sessionId, at);
          if (retryAfterMs > 0)
            throw new ApiError("rate_limited", {
              code: "rate_limited",
              retry_after_ms: retryAfterMs,
            });
          return readSavedCalendarPreview(ctx.env.DB, auth.userId, ctx.url, cache, at);
        }, true),
    },
  ];
}
