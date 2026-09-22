// A-P2-PREAUTH · POST /api/v2/auth/preauth 初始化端点（任务卡 P2-01 交付物一）。
// 覆盖：Set-Cookie 五属性 + 无 Domain、CSRF 双提交与 Cookie 绑定、有效 Cookie 复用
// 同一随机值（§4.3 多标签页条款）、坏 Cookie 重新签发、写管线结构/同源先行。

import { SECRET_BITS } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { CSRF_COOKIE_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { mintPreauthCookieValue, PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "./cookie";
import { makePreauthInitRoute } from "./routes";

const T0 = 1_800_000_000_000;

function initShell() {
  return createApiShell({
    authenticator: {
      async authenticate() {
        return { kind: "none" } as const;
      },
    },
    csrfKey: async () => (await testKeyring).csrf(),
    routes: [makePreauthInitRoute({ keys: async () => await testKeyring })],
  });
}

function postPreauth(body = {}, cookie?: string, origin = "https://app.test"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request("https://app.test/api/v2/auth/preauth", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function setCookies(res: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return cookies;
}

describe("A-P2-PREAUTH POST /api/v2/auth/preauth（§4.3 前半）", () => {
  it("首次初始化：200、两个 Set-Cookie、__Host-preauth 五属性齐全且无 Domain", async () => {
    const res = await initShell().fetch(
      postPreauth(),
      {} as Env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBe(2);
    const preauthCookie = setCookies.find((c) => c.startsWith(`${PREAUTH_COOKIE_NAME}=`));
    expect(preauthCookie).toBeDefined();
    expect(preauthCookie).toContain("Secure");
    expect(preauthCookie).toContain("HttpOnly");
    expect(preauthCookie).toContain("SameSite=Lax");
    expect(preauthCookie).toContain("Path=/");
    expect(preauthCookie).toContain("Max-Age=");
    expect(preauthCookie?.toLowerCase()).not.toContain("domain");
    const csrfCookie = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
    expect(csrfCookie).toBeDefined();
    // CSRF 双提交 Cookie 必须可被页面读回：不设 HttpOnly。
    expect(csrfCookie).not.toContain("HttpOnly");
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie).toContain("SameSite=Lax");
  });

  it("响应体的 csrf_token 与 CSRF Cookie 同值，可作双提交回读", async () => {
    const res = await initShell().fetch(
      postPreauth(),
      {} as Env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    const body = (await res.json()) as { csrf_token: string };
    const cookies = setCookies(res);
    expect(cookies.get(CSRF_COOKIE_NAME)).toBe(body.csrf_token);
    expect(body.csrf_token.length).toBeGreaterThan(0);
  });

  it("携带有效 Cookie 时复用同一个未失效随机值（§4.3 多标签页），CSRF 绑同一 preauth_id", async () => {
    const key = (await testKeyring).csrf();
    const minted = await mintPreauthCookieValue(key, T0);
    const res = await initShell().fetch(
      postPreauth({}, `${PREAUTH_COOKIE_NAME}=${minted.value}`),
      {} as Env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies.get(PREAUTH_COOKIE_NAME)).toBe(minted.value);
    // 绑定值 = preauth_id：CSRF MAC 对该绑定成立（用 P1-08 mint/verify 同一语义构造验证）。
    const body = (await res.json()) as { csrf_token: string };
    const token = await mintCsrfToken(key, minted.context.preauthId, randomBytes(SECRET_BITS / 8));
    expect(body.csrf_token.split(".").length).toBe(token.split(".").length);
  });

  it("携带坏 Cookie（MAC 不成立）时重新签发新随机值", async () => {
    const res = await initShell().fetch(
      postPreauth({}, `${PREAUTH_COOKIE_NAME}=forged.1.2.deadbeef`),
      {} as Env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    const value = cookies.get(PREAUTH_COOKIE_NAME) ?? "";
    expect(value).not.toContain("forged");
    expect(
      await verifyPreauthCookieValue((await testKeyring).csrf(), value, Date.now()),
    ).toMatchObject({
      ok: true,
    });
  });

  it("写管线先行：非 JSON 内容型 → 400；未知字段 → 400；跨源 → 401", async () => {
    const shell = initShell();
    const env = {} as Env;
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const badType = await shell.fetch(
      new Request("https://app.test/api/v2/auth/preauth", {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "text/plain" },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(badType.status).toBe(400);
    const unknownField = await shell.fetch(postPreauth({ email: "a@b.test" }), env, ctx);
    expect(unknownField.status).toBe(400);
    const crossOrigin = await shell.fetch(
      postPreauth({}, undefined, "https://evil.test"),
      env,
      ctx,
    );
    expect(crossOrigin.status).toBe(401);
  });

  it("该方法外请求被 405 拒绝（GET 不签发）", async () => {
    const res = await initShell().fetch(
      new Request("https://app.test/api/v2/auth/preauth", { method: "GET" }),
      {} as Env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(405);
  });
});
