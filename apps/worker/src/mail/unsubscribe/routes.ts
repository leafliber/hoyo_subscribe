import type { UnsubscribeMacKeys } from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import { closeBusinessMail, currentBinding } from "./service";
import { resolveUnsubscribeToken } from "./token";

function page(message: string, status: number, confirm = false) {
  // 固定文本；form 不回显 token，默认提交到当前 URL；没有脚本、第三方资源和身份信息。
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HoYo日历 · 邮件退订</title><main><h1>邮件退订</h1><p>${message}</p>${confirm ? '<form method="post"><button type="submit" name="confirm" value="unsubscribe">确认关闭业务邮件</button></form><p>将关闭常规提醒及取消、更正等业务邮件；验证码邮件不受影响。</p>' : ""}</main></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
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
        const invalid = (message: string) =>
          oneClick
            ? new Response(message, {
                status: 410,
                headers: { "content-type": "text/plain; charset=utf-8" },
              })
            : page(message, 410);
        if (!binding) return invalid("退订链接已失效。");
        if (!write)
          return (await currentBinding(ctx.env.DB, binding))
            ? page("确认后将关闭此邮箱绑定当前的业务邮件。", 200, true)
            : invalid("旧绑定已失效，不影响新地址的邮件设置。");
        if (!(await closeBusinessMail(ctx.env.DB, binding, (deps.now ?? Date.now)())))
          return invalid("旧绑定已失效，不影响新地址的邮件设置。");
        return oneClick
          ? new Response(null, { status: 204 })
          : page("此邮箱绑定的当前业务邮件已关闭。", 200);
      },
    }),
  );
}
