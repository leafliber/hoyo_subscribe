// P6-01 · Push 路由（主方案 §8.2；ADR-0025）。
//
// 本人管理（user 域：active 会话 + 绑定会话的 CSRF；恢复受限会话按外壳默认拒绝写）：
//   GET    /api/v2/me/push-bindings              事实视图（D3 §2.8）
//   POST   /api/v2/me/push-bindings              登记本浏览器（pending）并发可见激活通知
//   PATCH  /api/v2/me/push-bindings/{id}         { action: pause | activate, expected_version }
//   DELETE /api/v2/me/push-bindings/{id}         删除（终止路径、幂等）
//   POST   /api/v2/me/push-bindings/{id}/test    测试通知
//   POST   /api/v2/me/push-bindings/{id}/renew   账号操作续租
// receipt 窄能力（capability 域：不读 Cookie、不做 CSRF——没有环境凭据可被借用；
// 请求体里的 receipt token 就是授权，且只能确认本浏览器接收）：
//   POST   /api/v2/push-bindings/{id}/activate   { receipt_token, challenge }
//   POST   /api/v2/push-bindings/{id}/processed  { receipt_token, message_id }
// 所有响应 no-store；receipt token 只出现在 POST 登记的响应体里，从不出现在 URL。
import { API_ERROR_STATUS } from "@hoyo/contracts";
import type { ShellAuth } from "../shell/domains";
import { ApiError, errorResponse, jsonResponse } from "../shell/errors";
import { logAnomalySampled } from "../shell/logger";
import type { RouteContext, ShellRoute } from "../shell/router";
import type { Keyring } from "../storage/crypto/keyring";
import type { PushTransport } from "./client";
import type { PushConfig } from "./config";
import { activateReceipt, processedReceipt, ReceiptNotFoundError } from "./receipts";
import {
  createPushBinding,
  deletePushBinding,
  type PushDeps,
  PushRefusalError,
  type PushSession,
  patchPushBinding,
  readPushChannel,
  renewPushBinding,
  testPushBinding,
} from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function session(auth: ShellAuth): PushSession {
  if (auth.kind !== "session" || auth.domain !== "user")
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    sessionTokenHash: auth.sessionTokenHash,
  };
}
function noStore(body: unknown, status = 200): Response {
  const response = jsonResponse(body, status);
  response.headers.set("cache-control", "no-store");
  return response;
}
function notFound(): Response {
  const response = errorResponse(
    "validation",
    { code: "validation", fields: [{ path: "$path", reason: "not_found" }] },
    404,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}
/** 尾通配捕获的 "/{id}" 或 "/{id}/{action}"；ID 必须是小写 UUID，不接受其他路径形状。 */
function pathParts(ctx: RouteContext): { id: string; action: string | null } | null {
  const parts = (ctx.params.rest ?? "").replace(/^\//, "").split("/");
  if (parts.length > 2 || !UUID.test(parts[0] ?? "")) return null;
  return { id: parts[0] as string, action: parts[1] ?? null };
}
async function refusals(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PushRefusalError)
      return noStore(error.body, API_ERROR_STATUS[error.body.error.code]);
    throw error;
  }
}

export interface PushRouteDeps {
  readonly keys: () => Promise<Keyring>;
  readonly config: (env: Env) => Promise<PushConfig | null>;
  readonly transport?: PushTransport;
  readonly now?: () => number;
}

export function makePushRoutes(deps: PushRouteDeps): readonly ShellRoute[] {
  const now = deps.now ?? Date.now;
  const transport: PushTransport = deps.transport ?? ((input, init) => fetch(input, init));
  const pushDeps = (ctx: RouteContext): PushDeps => ({
    db: ctx.env.DB,
    keys: deps.keys,
    config: () => deps.config(ctx.env),
    transport,
  });
  const csrfBinding = ({ auth }: { auth: ShellAuth }) =>
    Promise.resolve(session(auth).sessionTokenHash);
  const versionSchema = { fields: { expected_version: { type: "number" as const } } };
  return [
    {
      method: "GET",
      pattern: "/api/v2/me/push-bindings",
      domain: "user",
      write: false,
      handler: async (ctx) =>
        noStore(await readPushChannel(pushDeps(ctx), session(ctx.auth), now())),
    },
    {
      method: "POST",
      pattern: "/api/v2/me/push-bindings",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          endpoint: { type: "string", minLength: 1 },
          keys: {
            type: "object",
            fields: {
              p256dh: { type: "string", minLength: 1 },
              auth: { type: "string", minLength: 1 },
            },
          },
        },
      },
      handler: (ctx) =>
        refusals(async () => {
          const result = await createPushBinding(pushDeps(ctx), session(ctx.auth), ctx.body, now());
          return noStore(result, result.result === "created" ? 201 : 200);
        }),
    },
    {
      method: "PATCH",
      pattern: "/api/v2/me/push-bindings/*",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: { action: { type: "string" }, expected_version: { type: "number" } },
      },
      handler: (ctx) =>
        refusals(async () => {
          const path = pathParts(ctx);
          if (path === null || path.action !== null) return notFound();
          return noStore(
            await patchPushBinding(pushDeps(ctx), session(ctx.auth), path.id, ctx.body, now()),
          );
        }),
    },
    {
      method: "DELETE",
      pattern: "/api/v2/me/push-bindings/*",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: { fields: {} },
      handler: (ctx) =>
        refusals(async () => {
          const path = pathParts(ctx);
          if (path === null || path.action !== null) return notFound();
          return noStore(await deletePushBinding(pushDeps(ctx), session(ctx.auth), path.id, now()));
        }),
    },
    {
      method: "POST",
      pattern: "/api/v2/me/push-bindings/*",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: versionSchema,
      handler: (ctx) =>
        refusals(async () => {
          const path = pathParts(ctx);
          if (path === null) return notFound();
          if (path.action === "test")
            return noStore(
              await testPushBinding(pushDeps(ctx), session(ctx.auth), path.id, ctx.body, now()),
            );
          if (path.action === "renew")
            return noStore(
              await renewPushBinding(pushDeps(ctx), session(ctx.auth), path.id, ctx.body, now()),
            );
          return notFound();
        }),
    },
    {
      method: "POST",
      pattern: "/api/v2/push-bindings/*",
      domain: "capability",
      write: true,
      // receipt 端点不读 Cookie：没有可被跨站借用的环境凭据，CSRF 不适用；同源 Origin 校验照常。
      csrf: false,
      bodySchema: {
        fields: {
          receipt_token: { type: "string", minLength: 1, maxLength: 128 },
          challenge: { type: "string", optional: true, minLength: 1, maxLength: 128 },
          message_id: { type: "string", optional: true, minLength: 1, maxLength: 64 },
        },
      },
      handler: async (ctx) => {
        const path = pathParts(ctx);
        if (path === null || (path.action !== "activate" && path.action !== "processed"))
          return notFound();
        try {
          const result =
            path.action === "activate"
              ? await activateReceipt(ctx.env.DB, path.id, ctx.body, now())
              : await processedReceipt(ctx.env.DB, path.id, ctx.body, now());
          return noStore(result);
        } catch (error) {
          if (error instanceof ReceiptNotFoundError) {
            // 凭证不符、挑战不符、期限已过一律同一个 404；采样记录，不落凭证。
            logAnomalySampled("push_receipt_rejected", "/api/v2/push-bindings/*", ctx.requestId);
            return notFound();
          }
          throw error;
        }
      },
    },
  ];
}
