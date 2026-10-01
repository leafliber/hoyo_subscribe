import { ADMIN_SESSION_TTL, SECRET_BITS } from "@hoyo/contracts";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../auth/preauth/cookie";
import {
  ApiError,
  CSRF_COOKIE_NAME,
  jsonResponse,
  mintCsrfToken,
  parseCookieHeader,
  type ShellRoute,
} from "../shell";
import { ADMIN_SESSION_COOKIE_NAME, type ShellAuth } from "../shell/domains";
import { generateSecretToken } from "../storage/crypto/random";
import { verifyAccess } from "./access";
import { issueAdminSession, verifyBootstrap } from "./session";
import type { AdminDependencies } from "./types";

export function requireAdmin(
  auth: ShellAuth,
): Extract<ShellAuth, { domain: "admin" }> & { sessionId: string; sessionTokenHash: string } {
  if (
    auth.kind !== "session" ||
    auth.domain !== "admin" ||
    !auth.sessionId ||
    !auth.sessionTokenHash
  )
    throw new ApiError("unauthorized");
  return { ...auth, sessionId: auth.sessionId, sessionTokenHash: auth.sessionTokenHash };
}

export function adminCsrfBinding({ auth }: { auth: ShellAuth }): Promise<string> {
  return Promise.resolve(requireAdmin(auth).sessionTokenHash);
}

/** 换会话先经现有 preauth 初始化取得浏览器 CSRF，登录操作也无免 CSRF 例外。 */
export function makeAdminSessionRoutes(deps: AdminDependencies): ShellRoute[] {
  return (["bootstrap", "access"] as const).map(
    (method): ShellRoute => ({
      method: "POST",
      pattern: `/api/v2/admin/session/${method}`,
      domain: "public",
      write: true,
      bodySchema: {
        fields:
          method === "bootstrap" ? { secret: { type: "string", maxLength: SECRET_BITS / 4 } } : {},
      },
      csrfBinding: async ({ request }) => {
        const value = parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
        if (value === undefined) throw new ApiError("unauthorized");
        const verified = await verifyPreauthCookieValue(
          (await deps.keys()).preauthCookie(),
          value,
          (deps.now ?? Date.now)(),
        );
        if (!verified.ok) throw new ApiError("unauthorized");
        return verified.context.preauthId;
      },
      handler: async (ctx) => {
        const now = (deps.now ?? Date.now)();
        if (ctx.url.protocol !== "https:" || ctx.url.search !== "")
          throw new ApiError("unauthorized");
        if (!(await deps.sourceGate.charge(ctx.request, now))) throw new ApiError("rate_limited");
        const keys = await deps.keys();
        let adminId: string;
        let deadline: number | undefined;
        if (method === "bootstrap") {
          if (
            !(await verifyBootstrap(
              keys,
              deps.config.ADMIN_BOOTSTRAP_SECRET,
              String(ctx.body?.secret ?? ""),
            ))
          )
            throw new ApiError("unauthorized");
          adminId = "owner";
        } else {
          const verified = await verifyAccess(ctx.request, deps.config, now, deps.fetchKeys);
          if (verified === null) throw new ApiError("unauthorized");
          adminId = verified.adminId;
          deadline = verified.expiresAt;
        }
        const issuedAt = (deps.now ?? Date.now)();
        if (deadline !== undefined && deadline <= issuedAt) throw new ApiError("unauthorized");
        const session = await issueAdminSession(
          ctx.env.DB,
          keys,
          adminId,
          `${method}_verified`,
          issuedAt,
          deadline,
        );
        const csrf = await mintCsrfToken(
          keys.csrf(),
          session.tokenHash,
          generateSecretToken().bytes,
        );
        const response = jsonResponse({ csrf_token: csrf, expires_at: session.expiresAt });
        response.headers.set("cache-control", "no-store");
        const maxAge = Math.min(ADMIN_SESSION_TTL, Math.floor((session.expiresAt - now) / 1_000));
        response.headers.append(
          "set-cookie",
          `${ADMIN_SESSION_COOKIE_NAME}=${session.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        );
        response.headers.append(
          "set-cookie",
          `${CSRF_COOKIE_NAME}=${csrf}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        );
        return response;
      },
    }),
  );
}
