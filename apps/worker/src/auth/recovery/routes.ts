// P2-05 · /api/v2/auth/recovery 路径组。public 动作绑 preauth + CSRF；
// 新码 GET 状态/POST 生成或确认由 active 用户会话持有，P2-07 的
// /api/v2/me/recovery-code 则是确认后须最近认证的轮换，语义不同。
// ADR-0026：生成可附 proof_id（recovery_code_rotate 用途证明），供登录较久的会话首次创建。
import { API_BODY_MAX_BYTES } from "@hoyo/contracts";
import { ApiError, jsonResponse, parseCookieHeader } from "../../shell";
import type { ShellAuth } from "../../shell/domains";
import type { ShellRoute } from "../../shell/router";
import type { Keyring } from "../../storage/crypto/keyring";
import { PREAUTH_COOKIE_NAME } from "../preauth/cookie";
import { runRecoveryAction } from "./action";
import { confirmRecoveryCode, currentRecoveryCodeSaved, generateRecoveryCode } from "./credential";
import type { SafetyPauseEffectHook } from "./pause";
import { InMemoryRecoverySourceGate, type RecoverySourceGate } from "./rate";

export interface RecoveryRouteDeps {
  readonly keys: () => Promise<Keyring>;
  readonly sourceGate?: RecoverySourceGate;
  readonly now?: () => number;
  readonly pauseHooks?: readonly SafetyPauseEffectHook[];
  readonly beforeCommit?: () => Promise<void>;
}

function userAuth(auth: ShellAuth): Extract<ShellAuth, { domain: "user" }> {
  if (auth.kind !== "session" || auth.domain !== "user") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  return auth;
}

function bodyString(body: Record<string, unknown> | undefined, name: string): string {
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

function validation(name: string): ApiError {
  return new ApiError("validation", {
    code: "validation",
    fields: [{ path: name, reason: "invalid_action" }],
  });
}

export function makeRecoveryRoutes(deps: RecoveryRouteDeps): readonly ShellRoute[] {
  const sourceGate = deps.sourceGate ?? new InMemoryRecoverySourceGate();
  const now = deps.now ?? Date.now;
  return [
    {
      method: "POST",
      pattern: "/api/v2/auth/recovery",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          action: { type: "string" },
          recovery_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          secret: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
        },
      },
      csrfBinding: async ({ request }) =>
        parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME)?.split(".")[0] ?? "",
      handler: async (ctx) => {
        const action = bodyString(ctx.body, "action");
        if (action !== "emergency_stop" && action !== "recover_login") throw validation("action");
        return runRecoveryAction(
          {
            db: ctx.env.DB,
            keys: await deps.keys(),
            sourceGate,
            now,
            pauseHooks: deps.pauseHooks,
            beforeCommit: deps.beforeCommit,
          },
          {
            request: ctx.request,
            action,
            recoveryId: bodyString(ctx.body, "recovery_id"),
            secret: bodyString(ctx.body, "secret"),
          },
        );
      },
    },
    {
      method: "GET",
      pattern: "/api/v2/auth/recovery/code",
      domain: "user",
      write: false,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        const row = await ctx.env.DB.prepare(
          "SELECT id, saved_confirmed_at FROM recovery_credentials WHERE user_id = ? AND consumed_at IS NULL",
        )
          .bind(auth.userId)
          .first<{ id: string; saved_confirmed_at: number | null }>();
        const response = jsonResponse({
          has_current_code: row !== null,
          saved_confirmed: await currentRecoveryCodeSaved(ctx.env.DB, auth.userId),
        });
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/recovery/code",
      domain: "user",
      write: true,
      allowRecoveryWrite: true,
      bodySchema: {
        fields: {
          action: { type: "string" },
          recovery_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          secret: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          proof_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
        },
      },
      csrfBinding: async ({ auth }) => userAuth(auth).sessionTokenHash,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        const session = {
          userId: auth.userId,
          sessionId: auth.sessionId,
          sessionTokenHash: auth.sessionTokenHash,
        };
        const action = bodyString(ctx.body, "action");
        if (action === "generate") {
          const result = await generateRecoveryCode(
            ctx.env.DB,
            session,
            now(),
            bodyString(ctx.body, "proof_id"),
          );
          const response = jsonResponse(result);
          response.headers.set("cache-control", "no-store");
          return response;
        }
        if (action === "confirm") {
          await confirmRecoveryCode(
            ctx.env.DB,
            session,
            bodyString(ctx.body, "recovery_id"),
            bodyString(ctx.body, "secret"),
            now(),
          );
          const response = jsonResponse({ saved_confirmed: true });
          response.headers.set("cache-control", "no-store");
          return response;
        }
        throw validation("action");
      },
    },
  ];
}
