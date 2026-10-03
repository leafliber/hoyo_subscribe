import "../../admin/test-support";
import { env } from "cloudflare:test";
import { RECLAIM_TELEMETRY_STALE_HOURS, utcDayPeriod } from "@hoyo/contracts";
import { beforeEach, expect, it } from "vitest";
import { combinedAuthenticator, issueAdminSession } from "../../admin/session";
import worker from "../../index";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { ADMIN_SESSION_COOKIE_NAME, USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { fakeExecutionContext, testKeyring } from "../../shell/test-support";
import { toHex } from "../../storage/crypto/bytes";
import { generateSecretToken } from "../../storage/crypto/random";
import { makeReclaimRoutes } from "./routes";

const T = 1900000000000,
  origin = "https://app.test";
const shell = createApiShell({
  authenticator: combinedAuthenticator(
    env.DB,
    () => testKeyring,
    () => T,
  ),
  csrfKey: async () => (await testKeyring).csrf(),
  routes: makeReclaimRoutes([], () => T),
});
async function admin() {
  const s = await issueAdminSession(env.DB, await testKeyring, "synthetic-owner", "synthetic", T);
  const csrf = await mintCsrfToken(
    (await testKeyring).csrf(),
    s.tokenHash,
    generateSecretToken().bytes,
  );
  return {
    origin,
    "content-type": "application/json",
    [CSRF_HEADER_NAME]: csrf,
    cookie: `${ADMIN_SESSION_COOKIE_NAME}=${s.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
  };
}
const request = (path: string, headers: Record<string, string>, body?: unknown) =>
  shell.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    fakeExecutionContext,
  );
const resume = {
  expected_updated_at: 0,
  last_success_at: T,
  reason: "synthetic verification and repair",
};
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM admin_sessions;DELETE FROM audit_log;DELETE FROM system_state;DELETE FROM activity_write_failures;",
  );
  await env.DB.prepare(
    "INSERT INTO activity_write_failures(metric,utc_day,failures,last_success_at,updated_at) VALUES('feed_poll_merge',?,0,?,?)",
  )
    .bind(utcDayPeriod(T).key, T, T)
    .run();
});
it("A-P5-RECLAIM 管理清单拒绝普通会话，管理写绑定当前管理员 CSRF", async () => {
  expect((await request("/api/v2/admin/reclaim", {})).status).toBe(401);
  expect(
    (await request("/api/v2/admin/reclaim", { cookie: `${USER_SESSION_COOKIE_NAME}=synthetic` }))
      .status,
  ).toBe(401);
  const a = await admin(),
    b = await admin();
  for (const headers of [
    { ...a, [CSRF_HEADER_NAME]: "" },
    { ...a, origin: "https://other.example" },
    { ...b, cookie: a.cookie },
  ]) {
    expect((await request("/api/v2/admin/reclaim/resume", headers, resume)).status).toBe(401);
    expect(
      (
        await request("/api/v2/admin/reclaim/confirm/synthetic", headers, {
          activity_at: 1,
          grace_until: 1,
          channel_revision: 0,
          kind: "seat",
          reason: "synthetic",
        })
      ).status,
    ).toBe(401);
  }
  const list = await request("/api/v2/admin/reclaim", a);
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(await list.json()).toMatchObject({
    telemetry: null,
    gate: { accounts_paused: true, seats_paused: true, last_success_at: T },
  });
});
it("A-P5-RECLAIM 解除暂停须新鲜水位、版本与理由，成功只写一次审计，不自动打开独立开关", async () => {
  const a = await admin();
  expect(
    (await request("/api/v2/admin/reclaim/resume", a, { ...resume, reason: "   " })).status,
  ).toBe(400);
  expect(
    (
      await request("/api/v2/admin/reclaim/resume", a, {
        ...resume,
        last_success_at: T - RECLAIM_TELEMETRY_STALE_HOURS * 3600000 - 1,
      })
    ).status,
  ).toBe(409);
  const r = await Promise.all([
    request("/api/v2/admin/reclaim/resume", a, resume),
    request("/api/v2/admin/reclaim/resume", a, resume),
  ]);
  expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM audit_log WHERE action='reclaim_resume' AND reason=?",
    )
      .bind(resume.reason)
      .first("n"),
  ).toBe(1);
  expect(await (await request("/api/v2/admin/reclaim", a)).json()).toMatchObject({
    telemetry: { paused: "false", updated_at: T },
    gate: { accounts_paused: true, seats_paused: true },
  });
});
it("A-P5-RECLAIM 真实 Worker 入口挂载三条管理路由，保留管理鉴权和绑定 CSRF", async () => {
  const secret = toHex(generateSecretToken().bytes);
  const configured = {
    ...env,
    CRYPTO_MASTER_SECRET: toHex(generateSecretToken().bytes),
    CRYPTO_OTP_PEPPER: toHex(generateSecretToken().bytes),
    CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
    ADMIN_BOOTSTRAP_SECRET: secret,
  };
  const fetch = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
    worker.fetch(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      configured,
      fakeExecutionContext,
    );
  const pre = await fetch(
    "/api/v2/auth/preauth",
    { origin, "content-type": "application/json" },
    {},
  );
  const prebody = (await pre.json()) as { csrf_token: string };
  const login = await fetch(
    "/api/v2/admin/session/bootstrap",
    {
      origin,
      "content-type": "application/json",
      cookie: pre.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
      [CSRF_HEADER_NAME]: prebody.csrf_token,
    },
    { secret },
  );
  expect(login.status).toBe(200);
  const auth = {
    origin,
    "content-type": "application/json",
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    [CSRF_HEADER_NAME]: ((await login.json()) as { csrf_token: string }).csrf_token,
  };
  expect((await fetch("/api/v2/admin/reclaim", auth)).status).toBe(200);
  expect(
    (
      await fetch("/api/v2/admin/reclaim/resume", auth, {
        ...resume,
        last_success_at: Date.now() + 1e9,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch("/api/v2/admin/reclaim/confirm/synthetic", auth, {
        activity_at: 1,
        grace_until: 1,
        channel_revision: 0,
        kind: "seat",
        reason: "synthetic",
      })
    ).status,
  ).toBe(503);
});
