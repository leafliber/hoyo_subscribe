// P3-07：地址只经专用 GET 返回；所有写动作显式确认，无额外 OTP。
import { calendarActionSchema, calendarMutationSchema } from "@hoyo/contracts";
import { requireOperationKey } from "../../auth/consume/operation";
import { ApiError, jsonResponse } from "../../shell/errors";
import type { RouteContext, ShellRoute } from "../../shell/router";
import type { Keyring } from "../../storage/crypto/keyring";
import { type CalendarSession, mutateCalendar, readCalendar } from "./service";

function session(ctx: Pick<RouteContext, "auth">): CalendarSession {
  const auth = ctx.auth;
  if (auth.kind !== "session" || auth.domain !== "user")
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    sessionTokenHash: auth.sessionTokenHash,
  };
}
function response(body: unknown) {
  const value = jsonResponse(body);
  value.headers.set("cache-control", "private, no-store");
  return value;
}
export function makeCalendarRoutes(
  keys: () => Promise<Keyring>,
  now: () => number = Date.now,
): readonly ShellRoute[] {
  const busy = new Set<string>();
  return [
    {
      method: "GET",
      pattern: "/api/v2/me/calendar",
      domain: "user",
      write: false,
      handler: async (ctx) =>
        response(
          await readCalendar(
            ctx.env.DB,
            await keys(),
            session(ctx),
            new URL(ctx.request.url).origin,
            now(),
          ),
        ),
    },
    ...calendarActionSchema.options.map(
      (action) =>
        ({
          method: "POST",
          pattern: `/api/v2/me/calendar/${action}`,
          domain: "user",
          write: true,
          bodySchema: {
            fields: { confirmed: { type: "boolean" }, expected_generation: { type: "number" } },
          },
          csrfBinding: async (ctx) => session(ctx).sessionTokenHash,
          handler: async (ctx) => {
            const parsed = calendarMutationSchema.safeParse(ctx.body);
            if (!parsed.success)
              throw new ApiError("validation", {
                code: "validation",
                fields: [{ path: "body", reason: "invalid_calendar_mutation" }],
              });
            const actor = session(ctx);
            const operation = requireOperationKey(ctx.request);
            if (busy.has(actor.userId))
              throw new ApiError("rate_limited", { code: "rate_limited" });
            busy.add(actor.userId);
            try {
              return response(
                await mutateCalendar(
                  ctx.env.DB,
                  await keys(),
                  actor,
                  action,
                  parsed.data.expected_generation,
                  operation,
                  now(),
                ),
              );
            } finally {
              busy.delete(actor.userId);
            }
          },
        }) satisfies ShellRoute,
    ),
  ];
}
