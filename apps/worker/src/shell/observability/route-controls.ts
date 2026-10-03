import { ApiError } from "../errors";
import type { ShellRoute } from "../router";
import { readControl, requireControl } from "./controls";
/** 在外壳完成鉴权、CSRF、结构检查后读取；终止及其认证前置不被维护阻断。 */
export function withOperationalControls(routes: ShellRoute[]): ShellRoute[] {
  const mutable = new Set([
    "/api/v2/me/subscription",
    "/api/v2/me/email-change",
    "/api/v2/me/calendar/enable",
    "/api/v2/me/calendar/reset",
  ]);
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      if (
        route.write &&
        (mutable.has(route.pattern) || route.pattern.startsWith("/api/v2/admin/review/"))
      ) {
        if ((await readControl(ctx.env.DB, "read_only")).value === true)
          throw new ApiError("temporarily_unavailable");
      }
      if (route.pattern === "/api/v2/me/calendar/enable")
        await requireControl(ctx.env.DB, "calendar_enabled");
      return route.handler(ctx);
    },
  }));
}
