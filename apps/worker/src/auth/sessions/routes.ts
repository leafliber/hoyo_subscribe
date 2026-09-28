// P2-04 · 会话路由（§4.5）。设备列表是 pending 唯一可读的 user 路由，并为
// 当前会话签发绑定 token hash 的 CSRF；激活本身仍需同源 + 双提交 + MAC 验证。

import {
  API_BODY_MAX_BYTES,
  buildApiErrorBody,
  SESSION_IDLE_TTL,
  SESSION_RENEW_INTERVAL,
} from "@hoyo/contracts";
import {
  ApiError,
  CSRF_COOKIE_NAME,
  jsonResponse,
  mintCsrfToken,
  parseCookieHeader,
} from "../../shell";
import { type ShellAuth, USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import type { ShellRoute } from "../../shell/router";
import type { Keyring } from "../../storage/crypto/keyring";
import { generateSecretToken } from "../../storage/crypto/random";
import {
  activateSession,
  coarsePlatform,
  expiryNotice,
  listSessions,
  parseSelectedSessionIds,
  renewSession,
  revokeSession,
} from "./lifecycle";

const SECOND = 1_000;

function userAuth(auth: ShellAuth): Extract<ShellAuth, { domain: "user" }> {
  if (auth.kind !== "session" || auth.domain !== "user") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  return auth;
}

function sessionCsrfBinding({ auth }: { auth: ShellAuth }): Promise<string> {
  return Promise.resolve(userAuth(auth).sessionTokenHash);
}

function csrfSetCookie(value: string): string {
  return `${CSRF_COOKIE_NAME}=${value}; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_IDLE_TTL}`;
}

function activeSessionSetCookie(value: string, now: number, expiresAt: number): string {
  const maxAge = Math.max(0, Math.ceil((expiresAt - now) / SECOND));
  return `${USER_SESSION_COOKIE_NAME}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearCookies(response: Response): void {
  response.headers.append(
    "set-cookie",
    `${USER_SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
  response.headers.append(
    "set-cookie",
    `${CSRF_COOKIE_NAME}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function sessionCookie(request: Request): string {
  const value = parseCookieHeader(request.headers.get("cookie"), USER_SESSION_COOKIE_NAME);
  if (value === undefined)
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return value;
}

function validation(path: string, reason: string): ApiError {
  return new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}

export function makeSessionRoutes(
  keys: () => Promise<Keyring>,
  now: () => number = Date.now,
): readonly ShellRoute[] {
  return [
    {
      method: "GET",
      pattern: "/api/v2/me/sessions",
      domain: "user",
      allowPending: true,
      write: false,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        const currentTime = now();
        const sessions = await listSessions(ctx.env.DB, auth.userId, auth.sessionId, currentTime);
        const csrfToken = await mintCsrfToken(
          (await keys()).csrf(),
          auth.sessionTokenHash,
          generateSecretToken().bytes,
        );
        const response = jsonResponse({
          sessions,
          current_session_state: auth.sessionState,
          current_needs_reverification: await expiryNotice(ctx.env.DB, auth.sessionId, currentTime),
          renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * SECOND,
          renewed_at_note: "renewed_at 最多滞后一个续期间隔",
          csrf_token: csrfToken,
        });
        response.headers.append("set-cookie", csrfSetCookie(csrfToken));
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/activate",
      domain: "user",
      allowPending: true,
      write: true,
      bodySchema: {
        fields: {
          label: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          revoke_session_ids: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
        },
      },
      csrfBinding: sessionCsrfBinding,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        if (auth.sessionState !== "pending") throw new ApiError("conflict", { code: "conflict" });
        const rawSelection = ctx.body?.revoke_session_ids;
        const rawLabel = ctx.body?.label;
        let selectedIds: string[];
        try {
          selectedIds = parseSelectedSessionIds(
            typeof rawSelection === "string" ? rawSelection : undefined,
          );
        } catch {
          throw validation("revoke_session_ids", "invalid_selection");
        }
        const customLabel = typeof rawLabel === "string" ? rawLabel : undefined;
        if (customLabel !== undefined && customLabel.trim().length === 0) {
          throw validation("label", "empty_label");
        }
        const currentTime = now();
        const outcome = await activateSession({
          db: ctx.env.DB,
          userId: auth.userId,
          sessionId: auth.sessionId,
          selectedIds,
          label: customLabel,
          platform: coarsePlatform(ctx.request.headers.get("user-agent")),
          now: currentTime,
        });
        if (outcome === "conflict") {
          const sessions = await listSessions(ctx.env.DB, auth.userId, auth.sessionId, currentTime);
          const response = jsonResponse(
            {
              ...buildApiErrorBody("conflict", { code: "conflict" }),
              selection_required: true,
              sessions,
              renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * SECOND,
            },
            409,
          );
          response.headers.set("cache-control", "no-store");
          return response;
        }
        const csrfToken = await mintCsrfToken(
          (await keys()).csrf(),
          auth.sessionTokenHash,
          generateSecretToken().bytes,
        );
        const response = jsonResponse({ activated: true, csrf_token: csrfToken });
        response.headers.append("set-cookie", csrfSetCookie(csrfToken));
        response.headers.append(
          "set-cookie",
          activeSessionSetCookie(
            sessionCookie(ctx.request),
            currentTime,
            (
              await ctx.env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?")
                .bind(auth.sessionId)
                .first<{ expires_at: number }>()
            )?.expires_at ?? currentTime,
          ),
        );
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/renew",
      domain: "user",
      write: true,
      bodySchema: { fields: {} },
      csrfBinding: sessionCsrfBinding,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        const currentTime = now();
        const result = await renewSession(ctx.env.DB, auth.userId, auth.sessionId, currentTime);
        if (result === null)
          throw new ApiError("unauthorized", { code: "unauthorized", reason: "session_expired" });
        const response = jsonResponse({ renewed: result.renewed, expires_at: result.expiresAt });
        if (result.renewed)
          response.headers.append(
            "set-cookie",
            activeSessionSetCookie(sessionCookie(ctx.request), currentTime, result.expiresAt),
          );
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "DELETE",
      pattern: "/api/v2/me/sessions/*",
      domain: "user",
      write: true,
      bodySchema: { fields: {} },
      csrfBinding: sessionCsrfBinding,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        const id = (ctx.params.rest ?? "").replace(/^\//, "");
        if (id.includes("/")) throw validation("id", "invalid_session_id");
        const outcome = await revokeSession(ctx.env.DB, auth.userId, id, now());
        if (outcome === "not_found") throw validation("id", "not_found");
        const response = jsonResponse({ revoked: true });
        if (id === auth.sessionId) clearCookies(response);
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/logout",
      domain: "user",
      write: true,
      bodySchema: { fields: {} },
      csrfBinding: sessionCsrfBinding,
      handler: async (ctx) => {
        const auth = userAuth(ctx.auth);
        await revokeSession(ctx.env.DB, auth.userId, auth.sessionId, now());
        const response = jsonResponse({ logged_out: true });
        clearCookies(response);
        response.headers.set("cache-control", "no-store");
        return response;
      },
    },
  ];
}
