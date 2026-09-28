// P2-06 云配置路由（§8.2）：active user 域、会话散列 CSRF 绑定、所有者只从会话派生。
import { buildApiErrorBody } from "@hoyo/contracts";
import type { ShellAuth } from "../../shell/domains";
import { ApiError, jsonResponse } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import { readSubscription, saveSubscription } from "./service";

function sessionCsrfBinding({ auth }: { auth: ShellAuth }): Promise<string> {
  if (auth.kind !== "session" || auth.domain !== "user") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  return Promise.resolve(auth.sessionTokenHash);
}

const configFields = {
  schema_version: { type: "number" },
  scope: {
    type: "object",
    fields: {
      games: { type: "array", items: { type: "string" } },
      regions: { type: "array", items: { type: "string" } },
    },
  },
  calendar: {
    type: "object",
    fields: {
      event_types: { type: "array", items: { type: "string" } },
      node_types: { type: "array", items: { type: "string" } },
      alarms_enabled: { type: "boolean" },
    },
  },
  notifications: {
    type: "object",
    fields: {
      rule_ids: { type: "array", items: { type: "string" } },
      new_event: { type: "boolean" },
      important_change: { type: "boolean" },
      cancelled_or_retracted: { type: "boolean" },
      late_discovery: { type: "boolean" },
    },
  },
} as const;

function owner(userId: string | null): string {
  if (userId === null)
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return userId;
}

export function makeSubscriptionRoutes(now: () => number = Date.now): readonly ShellRoute[] {
  return [
    {
      method: "GET",
      pattern: "/api/v2/me/subscription",
      domain: "user",
      write: false,
      handler: async (ctx) => {
        const response = jsonResponse(await readSubscription(ctx.env.DB, owner(ctx.ownerUserId)));
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "PATCH",
      pattern: "/api/v2/me/subscription",
      domain: "user",
      write: true,
      bodySchema: {
        fields: {
          expected_revision: { type: "number" },
          config: { type: "object", fields: configFields },
        },
      },
      csrfBinding: sessionCsrfBinding,
      handler: async (ctx) => {
        const result = await saveSubscription(
          ctx.env.DB,
          owner(ctx.ownerUserId),
          ctx.body?.expected_revision as number,
          ctx.body?.config,
          now(),
        );
        if (result.kind === "rate_limited") {
          throw new ApiError("rate_limited");
        }
        const response =
          result.kind === "conflict"
            ? jsonResponse(
                { ...buildApiErrorBody("conflict", { code: "conflict" }), current: result.current },
                409,
              )
            : jsonResponse({ ...result.snapshot, saved: result.kind === "saved" });
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
  ];
}
