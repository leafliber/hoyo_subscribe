import "./test-support";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";
import { cleanupTasks, runCleanup } from "../scheduled/cleanup";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../shell";
import { ADMIN_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext } from "../shell/test-support";
import { toHex } from "../storage/crypto/bytes";
import { generateSecretToken } from "../storage/crypto/random";

it("A-P3-ADMIN Worker 真实入口挂载会话与审核路由，日志不包含引导秘密/Cookie", async () => {
  const secret = toHex(generateSecretToken().bytes);
  const configured = {
    ...env,
    CRYPTO_MASTER_SECRET: toHex(generateSecretToken().bytes),
    CRYPTO_OTP_PEPPER: toHex(generateSecretToken().bytes),
    CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
    ADMIN_BOOTSTRAP_SECRET: secret,
  };
  const origin = "https://app.test";
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const preauth = await worker.fetch(
      new Request(`${origin}/api/v2/auth/preauth`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      }),
      configured,
      fakeExecutionContext,
    );
    const preauthBody = (await preauth.json()) as { csrf_token: string };
    const cookie = preauth.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const response = await worker.fetch(
      new Request(`${origin}/api/v2/admin/session/bootstrap`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie,
          [CSRF_HEADER_NAME]: preauthBody.csrf_token,
        },
        body: JSON.stringify({ secret }),
      }),
      configured,
      fakeExecutionContext,
    );
    expect(response.status).toBe(200);
    const adminCookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
    const adminCookie =
      adminCookies.find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)) ?? "";
    const queue = await worker.fetch(
      new Request(`${origin}/api/v2/admin/review/queue`, {
        headers: { cookie: adminCookies.join("; ") },
      }),
      configured,
      fakeExecutionContext,
    );
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({ candidates: [] });
    const privateRoute = await worker.fetch(
      new Request(`${origin}/api/v2/me`, { headers: { cookie: adminCookie } }),
      configured,
      fakeExecutionContext,
    );
    expect(privateRoute.status).toBe(401);
    expect(await privateRoute.text()).toContain("wrong_domain");
    const emitted = JSON.stringify(logs.mock.calls);
    expect(emitted).not.toContain(secret);
    expect(emitted).not.toContain(adminCookie.slice(ADMIN_SESSION_COOKIE_NAME.length + 1));
    expect(emitted).not.toContain(CSRF_COOKIE_NAME);
  } finally {
    logs.mockRestore();
  }
});

describe("A-P3-ADMIN 定时清理接线", () => {
  it("末尾审计清理失败只记固定项名，既有清理正常执行", async () => {
    const audit = vi
      .spyOn(cleanupTasks, "adminAudit")
      .mockRejectedValueOnce(new Error("synthetic-sensitive-value"));
    const registrations = vi.spyOn(cleanupTasks, "registrations").mockResolvedValueOnce();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCleanup(env.DB, 1, 2, () => 1);
      expect(audit).toHaveBeenCalledOnce();
      expect(registrations).toHaveBeenCalledOnce();
      const emitted = JSON.stringify(logs.mock.calls);
      expect(emitted).toContain("adminAudit");
      expect(emitted).not.toContain("synthetic-sensitive-value");
    } finally {
      audit.mockRestore();
      registrations.mockRestore();
      logs.mockRestore();
    }
  });
  it("审计热查询使用管理员 expiry 部分索引", async () => {
    const plan = (
      await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM audit_log INDEXED BY idx_audit_log_admin_expiry WHERE expires_at <= ? AND actor_type='admin' ORDER BY expires_at,id LIMIT ?",
      )
        .bind(1, 1)
        .all()
    ).results;
    expect(JSON.stringify(plan)).toContain("idx_audit_log_admin_expiry");
  });
});
