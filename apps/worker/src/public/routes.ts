import { errorResponse, type ShellRoute } from "../shell";
import { conditionalPublic } from "./conditional";
import {
  readCatalog,
  readEventArticles,
  readEventDetail,
  readEvents,
  readRedeemCodes,
} from "./read";

// P3-22（ADR-0014）：/api/v2/events/{eventId}/articles 是同一事件的原文子资源，其余形状仍按详情处理。
// ADR-0032：公开读取的 200 响应带 ETag，条件请求命中回 304（conditional.ts）。
const ARTICLES_PATH = /^\/([^/]+)\/articles$/;

export const publicRoutes: readonly ShellRoute[] = [
  {
    method: "GET",
    pattern: "/api/v2/catalog",
    domain: "public",
    write: false,
    handler: async (ctx) => conditionalPublic(ctx.request, await readCatalog(ctx.env.DB, ctx.url)),
  },
  {
    method: "GET",
    pattern: "/api/v2/events",
    domain: "public",
    write: false,
    handler: async (ctx) => conditionalPublic(ctx.request, await readEvents(ctx.env.DB, ctx.url)),
  },
  {
    // ADR-0030：「有效兑换码」条。
    method: "GET",
    pattern: "/api/v2/redeem-codes",
    domain: "public",
    write: false,
    handler: async (ctx) =>
      conditionalPublic(ctx.request, await readRedeemCodes(ctx.env.DB, ctx.url)),
  },
  {
    method: "GET",
    pattern: "/api/v2/events/*",
    domain: "public",
    write: false,
    handler: async (ctx) => {
      const rest = ctx.params.rest ?? "";
      if (!rest.startsWith("/"))
        return errorResponse(
          "validation",
          { code: "validation", fields: [{ path: "$path", reason: "not_found" }] },
          404,
        );
      const articles = ARTICLES_PATH.exec(rest);
      if (articles?.[1])
        return conditionalPublic(
          ctx.request,
          await readEventArticles(ctx.env.DB, ctx.url, articles[1]),
        );
      return conditionalPublic(
        ctx.request,
        await readEventDetail(ctx.env.DB, ctx.url, rest.slice(1)),
      );
    },
  },
];
