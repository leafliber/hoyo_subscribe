import "./test-support";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashSessionToken } from "../auth/consume/session";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createApiShell,
  jsonResponse,
  mintCsrfToken,
} from "../shell";
import { ADMIN_SESSION_COOKIE_NAME, USER_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext, testKeyring } from "../shell/test-support";
import { generateSecretToken } from "../storage/crypto/random";
import { makeAdminReviewRoutes } from "./review";
import { combinedAuthenticator, issueAdminSession } from "./session";
import { makeAdminSessionRoutes } from "./session-routes";

const now = 1_900_000_000_000;
const origin = "https://app.test";
const shell = createApiShell({
  authenticator: combinedAuthenticator(
    env.DB,
    () => testKeyring,
    () => now,
  ),
  csrfKey: async () => (await testKeyring).csrf(),
  routes: [
    ...makeAdminSessionRoutes({
      keys: () => testKeyring,
      config: {},
      sourceGate: { charge: async () => true },
      now: () => now,
    }),
    ...makeAdminReviewRoutes(() => now),
    {
      method: "GET",
      pattern: "/api/v2/me",
      domain: "user",
      write: false,
      handler: async () => jsonResponse({ ok: true }),
    },
  ],
});
async function session() {
  const issued = await issueAdminSession(env.DB, await testKeyring, "owner", "synthetic", now);
  const csrf = await mintCsrfToken(
    (await testKeyring).csrf(),
    issued.tokenHash,
    generateSecretToken().bytes,
  );
  return {
    ...issued,
    headers: {
      origin,
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrf,
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${issued.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
    },
  };
}
function dispatch(path: string, headers: Record<string, string>, method = "POST") {
  return shell.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
    env,
    fakeExecutionContext,
  );
}
const logout = "/api/v2/admin/session/logout";
const queue = "/api/v2/admin/review/queue";

describe("A-F6-REVIEW 管理员退出", () => {
  it("撤销当前会话，旧 Cookie 访问审核为 401；重复和并发退出成功且只写一次审计", async () => {
    const issued = await session();
    const another = await session();
    expect((await dispatch(queue, issued.headers, "GET")).status).toBe(200);
    const responses = await Promise.all([
      dispatch(logout, issued.headers),
      dispatch(logout, issued.headers),
    ]);
    responses.push(await dispatch(logout, issued.headers));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ logged_out: true });
      expect(response.headers.getSetCookie()).toEqual([
        `${ADMIN_SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      ]);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await dispatch(queue, issued.headers, "GET")).status).toBe(401);
    expect((await dispatch(queue, another.headers, "GET")).status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT id, revoked_at FROM admin_sessions WHERE token_hash = ?",
    )
      .bind(issued.tokenHash)
      .first<{ id: string; revoked_at: number }>();
    expect(row?.revoked_at).toBe(now);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action='session_logout' AND target_id=?",
      )
        .bind(row?.id)
        .first("n"),
    ).toBe(1);
  });
  it("缺少 CSRF、错会话 CSRF、跨源、伪造和到期凭证均拒绝且不撤销", async () => {
    const issued = await session();
    const other = await session();
    const missing = { ...issued.headers, [CSRF_HEADER_NAME]: "" };
    const wrong = {
      ...other.headers,
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${issued.token}; ${CSRF_COOKIE_NAME}=${other.headers[CSRF_HEADER_NAME]}`,
    };
    const fakeToken = generateSecretToken().base64url;
    const fakeCsrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      await hashSessionToken(fakeToken),
      generateSecretToken().bytes,
    );
    for (const headers of [
      missing,
      wrong,
      { ...issued.headers, origin: "https://other.test" },
      {
        ...issued.headers,
        [CSRF_HEADER_NAME]: fakeCsrf,
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${fakeToken}; ${CSRF_COOKIE_NAME}=${fakeCsrf}`,
      },
    ])
      expect((await dispatch(logout, headers)).status).toBe(401);
    expect((await dispatch(queue, issued.headers, "GET")).status).toBe(200);
    await env.DB.prepare("UPDATE admin_sessions SET expires_at=? WHERE token_hash=?")
      .bind(now, issued.tokenHash)
      .run();
    expect((await dispatch(logout, issued.headers)).status).toBe(401);
    expect(
      await env.DB.prepare("SELECT revoked_at FROM admin_sessions WHERE token_hash=?")
        .bind(issued.tokenHash)
        .first("revoked_at"),
    ).toBeNull();
  });
  it("用户会话不能退出管理员；双 Cookie 只撤销管理员且用户会话不变", async () => {
    const issued = await session();
    const id = crypto.randomUUID();
    const token = generateSecretToken().base64url;
    await env.DB.prepare(
      `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,auth_epoch,recovery_epoch,created_at,updated_at) VALUES (?,1,'active',?,?,?,1,0,0,?,?)`,
    )
      .bind(id, id, id, new Uint8Array([1]), now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at) VALUES (?,?,?,'active','synthetic','unknown',?,?,?,0,0,0,?,?)`,
    )
      .bind(
        id,
        id,
        await hashSessionToken(token),
        now,
        issued.expiresAt,
        issued.expiresAt,
        now,
        now,
      )
      .run();
    const userCsrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      await hashSessionToken(token),
      generateSecretToken().bytes,
    );
    const userHeaders = {
      ...issued.headers,
      [CSRF_HEADER_NAME]: userCsrf,
      cookie: `${USER_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${userCsrf}`,
    };
    expect((await dispatch(logout, userHeaders)).status).toBe(401);
    const before = await env.DB.prepare("SELECT * FROM sessions WHERE id=?").bind(id).first();
    expect(
      (
        await dispatch(logout, {
          ...issued.headers,
          cookie: `${issued.headers.cookie}; ${USER_SESSION_COOKIE_NAME}=${token}`,
        })
      ).status,
    ).toBe(200);
    expect(await env.DB.prepare("SELECT * FROM sessions WHERE id=?").bind(id).first()).toEqual(
      before,
    );
    expect((await dispatch("/api/v2/me", userHeaders, "GET")).status).toBe(200);
  });
  it("审计失败整批回滚，不清 Cookie、不假退出", async () => {
    const issued = await session();
    await env.DB.exec(
      "CREATE TRIGGER logout_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='session_logout' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    );
    try {
      const response = await dispatch(logout, issued.headers);
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect((await dispatch(queue, issued.headers, "GET")).status).toBe(200);
    } finally {
      await env.DB.exec("DROP TRIGGER logout_audit_failure;");
    }
  });
});
