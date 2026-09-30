import { errorResponse, type ShellRoute } from "../shell";
import { readCatalog, readEventDetail, readEvents } from "./read";
export const publicRoutes: readonly ShellRoute[] = [
  {
    method: "GET",
    pattern: "/api/v2/catalog",
    domain: "public",
    write: false,
    handler: (ctx) => readCatalog(ctx.env.DB, ctx.url),
  },
  {
    method: "GET",
    pattern: "/api/v2/events",
    domain: "public",
    write: false,
    handler: (ctx) => readEvents(ctx.env.DB, ctx.url),
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
      return readEventDetail(ctx.env.DB, ctx.url, rest.slice(1));
    },
  },
];
