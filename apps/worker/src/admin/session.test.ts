import "./test-support";
import { env } from "cloudflare:test";
import {
  ADMIN_AUDIT_TTL,
  ADMIN_SESSION_TTL,
  MATCH_PAGE,
  RECOVERY_ATTEMPTS_HOUR,
  SECRET_BITS,
} from "@hoyo/contracts";
import { describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../auth/consume/session";
import { mintPreauthCookieValue, PREAUTH_COOKIE_NAME } from "../auth/preauth/cookie";
import { InMemoryRecoverySourceGate } from "../auth/recovery/rate";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createApiShell,
  jsonResponse,
  mintCsrfToken,
} from "../shell";
import { ADMIN_SESSION_COOKIE_NAME, USER_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext, testKeyring } from "../shell/test-support";
import { toHex } from "../storage/crypto/bytes";
import { generateSecretToken } from "../storage/crypto/random";
import { auditStatement, cleanupAdminAuditPage } from "./audit";
import {
  adminAuthenticator,
  combinedAuthenticator,
  issueAdminSession,
  verifyBootstrap,
} from "./session";
import { adminCsrfBinding, makeAdminSessionRoutes } from "./session-routes";

const now = 1_900_000_000_000;
const origin = "https://app.test";
const secret = toHex(generateSecretToken().bytes);
const keys = () => testKeyring;
const gate = { charge: vi.fn(async () => true) };
const shell = createApiShell({
  authenticator: combinedAuthenticator(env.DB, keys, () => now),
  csrfKey: async () => (await keys()).csrf(),
  feedHandler: async () => new Response("synthetic feed"),
  routes: [
    ...makeAdminSessionRoutes({
      keys,
      config: { ADMIN_BOOTSTRAP_SECRET: secret },
      sourceGate: gate,
      now: () => now,
    }),
    {
      method: "GET",
      pattern: "/api/v2/me",
      domain: "user",
      write: false,
      handler: async () => jsonResponse({ ok: true }),
    },
    {
      method: "GET",
      pattern: "/api/v2/admin/test",
      domain: "admin",
      write: false,
      handler: async () => jsonResponse({ ok: true }),
    },
    {
      method: "POST",
      pattern: "/api/v2/admin/test",
      domain: "admin",
      write: true,
      bodySchema: { fields: {} },
      csrfBinding: adminCsrfBinding,
      handler: async () => jsonResponse({ ok: true }),
    },
  ],
});
async function preauthHeaders() {
  const ring = await keys();
  const preauth = await mintPreauthCookieValue(ring.preauthCookie(), now);
  const csrf = await mintCsrfToken(
    ring.csrf(),
    preauth.context.preauthId,
    generateSecretToken().bytes,
  );
  return {
    origin,
    "content-type": "application/json",
    cookie: `${PREAUTH_COOKIE_NAME}=${preauth.value}; ${CSRF_COOKIE_NAME}=${csrf}`,
    [CSRF_HEADER_NAME]: csrf,
  };
}
async function dispatch(path: string, init?: RequestInit) {
  return shell.fetch(new Request(`${origin}${path}`, init), env, fakeExecutionContext);
}

describe("A-P3-ADMIN 管理员会话与审计边界", () => {
  it("HTTPS 引导换 ADMIN_SESSION_TTL 会话，仅保存 SHA-256 与有期限审计，不返回秘密", async () => {
    const response = await dispatch("/api/v2/admin/session/bootstrap", {
      method: "POST",
      headers: await preauthHeaders(),
      body: JSON.stringify({ secret }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict; Path=/");
    const token = cookie?.split(";")[0].slice(ADMIN_SESSION_COOKIE_NAME.length + 1) ?? "";
    const row = await env.DB.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?")
      .bind(await hashSessionToken(token))
      .first<{ id: string; issued_at: number; expires_at: number }>();
    expect(row).toMatchObject({ issued_at: now, expires_at: now + ADMIN_SESSION_TTL * 1_000 });
    const audit = await env.DB.prepare("SELECT * FROM audit_log WHERE target_id = ?")
      .bind(row?.id)
      .first<{ created_at: number; expires_at: number }>();
    expect(audit?.expires_at).toBe(now + ADMIN_AUDIT_TTL * 1_000);
    for (const value of [JSON.stringify(row), JSON.stringify(audit), await response.text()]) {
      expect(value).not.toContain(secret);
      expect(value).not.toContain(token);
    }
  });
  it("缺失、错误、弱配置秘密统一拒绝；通过 admin 用途验证", async () => {
    const ring = await keys();
    expect(await verifyBootstrap(ring, secret, secret)).toBe(true);
    expect(await verifyBootstrap(ring, secret, toHex(generateSecretToken().bytes))).toBe(false);
    expect(await verifyBootstrap(ring, undefined, secret)).toBe(false);
    expect(await verifyBootstrap(ring, "weak", "weak")).toBe(false);
    const outputs: string[] = [];
    for (const submitted of ["", toHex(generateSecretToken().bytes)]) {
      const response = await dispatch("/api/v2/admin/session/bootstrap", {
        method: "POST",
        headers: await preauthHeaders(),
        body: JSON.stringify({ secret: submitted }),
      });
      expect(response.status).toBe(401);
      outputs.push(await response.text());
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });
  it("合法 hex 但不足 SECRET_BITS/4 的配置秘密一律拒绝引导", async () => {
    const shortSecret = secret.slice(0, SECRET_BITS / 4 - 2);
    expect(shortSecret).toMatch(/^(?:[0-9a-f]{2})+$/);
    expect(shortSecret.length).toBeLessThan(SECRET_BITS / 4);
    const weakShell = createApiShell({
      authenticator: combinedAuthenticator(env.DB, keys, () => now),
      csrfKey: async () => (await keys()).csrf(),
      routes: makeAdminSessionRoutes({
        keys,
        config: { ADMIN_BOOTSTRAP_SECRET: shortSecret },
        sourceGate: gate,
        now: () => now,
      }),
    });
    const snapshot = async () =>
      Promise.all(
        ["admin_sessions", "audit_log"].map(
          async (table) =>
            (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
        ),
      );
    const before = await snapshot();
    for (const submitted of [shortSecret, secret]) {
      const response = await weakShell.fetch(
        new Request(`${origin}/api/v2/admin/session/bootstrap`, {
          method: "POST",
          headers: await preauthHeaders(),
          body: JSON.stringify({ secret: submitted }),
        }),
        env,
        fakeExecutionContext,
      );
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("不接受 URL 携带秘密、HTTP、跨源与缺少 CSRF", async () => {
    for (const [url, headers] of [
      [`${origin}/api/v2/admin/session/bootstrap?secret=synthetic`, await preauthHeaders()],
      [
        `http://app.test/api/v2/admin/session/bootstrap`,
        { ...(await preauthHeaders()), origin: "http://app.test" },
      ],
      [
        `${origin}/api/v2/admin/session/bootstrap`,
        { ...(await preauthHeaders()), origin: "https://other.test" },
      ],
      [`${origin}/api/v2/admin/session/bootstrap`, { origin, "content-type": "application/json" }],
    ] as const) {
      const response = await shell.fetch(
        new Request(url, { method: "POST", headers, body: JSON.stringify({ secret }) }),
        env,
        fakeExecutionContext,
      );
      expect(response.status).toBe(401);
    }
  });
  it("限速门在比较秘密前拒绝，失败请求不写持久审计", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first("n");
    gate.charge.mockResolvedValueOnce(false);
    const response = await dispatch("/api/v2/admin/session/bootstrap", {
      method: "POST",
      headers: await preauthHeaders(),
      body: JSON.stringify({ secret }),
    });
    expect(response.status).toBe(429);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first("n")).toBe(before);
    const rate = new InMemoryRecoverySourceGate();
    const request = new Request(origin, { headers: { "cf-connecting-ip": "192.0.2.1" } });
    for (let i = 0; i < RECOVERY_ATTEMPTS_HOUR; i++)
      expect(await rate.charge(request, now)).toBe(true);
    expect(await rate.charge(request, now)).toBe(false);
  });
  it("管理员无法打开 me，用户不能打开 admin；双 Cookie 按目标域解析", async () => {
    const session = await issueAdminSession(env.DB, await keys(), "owner", "synthetic", now);
    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`;
    const response = await dispatch("/api/v2/me", { headers: { cookie: adminCookie } });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("wrong_domain");
    const id = crypto.randomUUID();
    const userToken = generateSecretToken().base64url;
    await env.DB.prepare(
      `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,auth_epoch,recovery_epoch,created_at,updated_at) VALUES (?,1,'active',?,?,?,1,0,0,?,?)`,
    )
      .bind(id, id, id, new Uint8Array([1]), now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at) VALUES (?,?,?,'active','synthetic','unknown',?,?,?,0,0,0,?,?)`,
    )
      .bind(
        crypto.randomUUID(),
        id,
        await hashSessionToken(userToken),
        now,
        now + 1_000,
        now + 1_000,
        now,
        now,
      )
      .run();
    const userCookie = `${USER_SESSION_COOKIE_NAME}=${userToken}`;
    const rejected = await dispatch("/api/v2/admin/test", { headers: { cookie: userCookie } });
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toContain("wrong_domain");
    for (const path of ["/api/v2/me", "/api/v2/admin/test"])
      expect(
        (await dispatch(path, { headers: { cookie: `${userCookie}; ${adminCookie}` } })).status,
      ).toBe(200);
  });
  it("会话到期边界、撤销、篡改均拒绝；读取不续期", async () => {
    const issued = await issueAdminSession(env.DB, await keys(), "owner", "synthetic", now);
    const req = new Request(origin, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${issued.token}` },
    });
    expect(
      (
        await adminAuthenticator(env.DB, keys, () => issued.expiresAt - 1).authenticate(
          req,
          "admin",
        )
      ).kind,
    ).toBe("session");
    expect(
      (await adminAuthenticator(env.DB, keys, () => issued.expiresAt).authenticate(req, "admin"))
        .kind,
    ).toBe("none");
    await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?")
      .bind(now, issued.tokenHash)
      .run();
    expect(
      (await adminAuthenticator(env.DB, keys, () => now).authenticate(req, "admin")).kind,
    ).toBe("none");
    const bad = new Request(origin, {
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${generateSecretToken().base64url}.${issued.token.split(".")[1]}`,
      },
    });
    expect(
      (await adminAuthenticator(env.DB, keys, () => now).authenticate(bad, "admin")).kind,
    ).toBe("none");
  });
  it("admin 写 CSRF 绑定当前管理员会话散列，旧会话 CSRF 不可移用", async () => {
    const one = await issueAdminSession(env.DB, await keys(), "owner", "synthetic", now);
    const two = await issueAdminSession(env.DB, await keys(), "owner", "synthetic", now);
    const csrf = await mintCsrfToken(
      (await keys()).csrf(),
      one.tokenHash,
      generateSecretToken().bytes,
    );
    for (const session of [one, two]) {
      const response = await dispatch("/api/v2/admin/test", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          [CSRF_HEADER_NAME]: csrf,
          cookie: `${ADMIN_SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
        },
        body: "{}",
      });
      expect(response.status).toBe(session === one ? 200 : 401);
    }
  });
  it("只删到期管理员审计，每轮 MATCH_PAGE；不碰系统审计与未来记录", async () => {
    const statements = Array.from({ length: MATCH_PAGE + 1 }, (_, i) =>
      auditStatement(env.DB, {
        actorId: "owner",
        action: "synthetic",
        targetType: "candidate",
        targetId: String(i),
        reason: "synthetic",
        createdAt: now - ADMIN_AUDIT_TTL * 1_000,
      }),
    );
    await env.DB.batch(statements);
    await env.DB.prepare(
      `INSERT INTO audit_log (id,actor_type,actor_id,action,target_type,created_at,expires_at) VALUES ('system-test','system','system','synthetic','system',0,0)`,
    ).run();
    await cleanupAdminAuditPage(env.DB, now);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE actor_type='admin' AND expires_at <= ?",
      )
        .bind(now)
        .first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT id FROM audit_log WHERE id='system-test'").first(),
    ).not.toBeNull();
    expect(
      Number(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_log WHERE actor_type='admin' AND expires_at > ?",
        )
          .bind(now)
          .first("n"),
      ),
    ).toBeGreaterThan(0);
    await cleanupAdminAuditPage(env.DB, now);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE actor_type='admin' AND expires_at <= ?",
      )
        .bind(now)
        .first("n"),
    ).toBe(0);
  });
  it("缺少 Access 配置时入口关闭，伪造邮箱头无效；Feed 无登录墙", async () => {
    const response = await dispatch("/api/v2/admin/session/access", {
      method: "POST",
      headers: {
        ...(await preauthHeaders()),
        "cf-access-authenticated-user-email": "synthetic@example.test",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect((await dispatch("/feeds/u/synthetic.ics")).status).toBe(200);
  });
  it("审计写入失败时签发整批回滚", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM admin_sessions").first("n");
    await env.DB.exec(
      "CREATE TRIGGER admin_audit_test BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;",
    );
    try {
      await expect(
        issueAdminSession(env.DB, await keys(), "owner", "synthetic", now),
      ).rejects.toThrow();
    } finally {
      await env.DB.exec("DROP TRIGGER admin_audit_test;");
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM admin_sessions").first("n")).toBe(
      before,
    );
  });
});
