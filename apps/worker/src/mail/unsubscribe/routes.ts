import type { UnsubscribeMacKeys } from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import { unsubscribePage } from "./page";
import { readUnsubscribePageState } from "./page-state";
import { closeBusinessMail } from "./service";
import { resolveUnsubscribeToken } from "./token";

export function makeUnsubscribeRoutes(deps: {
  keys: () => Promise<UnsubscribeMacKeys>;
  now?: () => number;
}): readonly ShellRoute[] {
  return (
    [
      { method: "GET", pattern: "/unsubscribe/*", write: false, oneClick: false },
      { method: "POST", pattern: "/unsubscribe/*", write: true, oneClick: false },
      { method: "POST", pattern: "/email/one-click/*", write: true, oneClick: true },
    ] as const
  ).map(
    ({ method, pattern, write, oneClick }): ShellRoute => ({
      method,
      pattern,
      write,
      domain: "capability",
      protocol: "unsubscribe",
      ...(write
        ? {
            bodySchema: {
              fields: oneClick
                ? { "List-Unsubscribe": { type: "string" as const } }
                : { confirm: { type: "string" as const } },
            },
          }
        : {}),
      handler: async (ctx) => {
        if (
          write &&
          (oneClick
            ? ctx.body?.["List-Unsubscribe"] !== "One-Click"
            : ctx.body?.confirm !== "unsubscribe")
        ) {
          throw new ApiError("validation", {
            code: "validation",
            fields: [{ path: "$body", reason: "invalid_confirmation" }],
          });
        }
        const binding = await resolveUnsubscribeToken(await deps.keys(), ctx.params.token ?? "");
        const invalid = (state: "stale" | "invalid") =>
          oneClick
            ? new Response(
                state === "stale" ? "旧绑定已失效，不影响新地址的邮件设置。" : "退订链接已失效。",
                {
                  status: 410,
                  headers: { "content-type": "text/plain; charset=utf-8" },
                },
              )
            : unsubscribePage(state);
        if (!binding) return invalid("invalid");
        if (!write) return unsubscribePage(await readUnsubscribePageState(ctx.env.DB, binding));
        if (!(await closeBusinessMail(ctx.env.DB, binding, (deps.now ?? Date.now)())))
          return invalid("stale");
        return oneClick ? new Response(null, { status: 204 }) : unsubscribePage("closed");
      },
    }),
  );
}
