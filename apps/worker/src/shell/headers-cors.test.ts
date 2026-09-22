// A-P1-SHELL：安全响应头与严格同源 CORS（§8.3；任务卡交付物四）。
import { describe, expect, it } from "vitest";
import type { Authenticator, ShellAuth } from "./domains";
import { jsonResponse } from "./errors";
import { CSP_HTML_SAME_ORIGIN, CSP_STRICT, REFERRER_POLICY } from "./headers";
import { createApiShell, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl } from "./test-support";

const authNone: Authenticator = {
  async authenticate(): Promise<ShellAuth> {
    return { kind: "none" };
  },
};

const readRoute: ShellRoute = {
  method: "GET",
  pattern: "/api/v2/catalog",
  domain: "public",
  write: false,
  handler: async () => jsonResponse({ items: [] }),
};

const shell = createApiShell({ authenticator: authNone, routes: [readRoute] });

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy")).toBe(CSP_STRICT);
  expect(res.headers.get("referrer-policy")).toBe(REFERRER_POLICY);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("vary")).toContain("Origin");
  // ★ 严格同源 CORS：任何响应都不带 Access-Control-Allow-Origin。
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
}

describe("A-P1-SHELL 安全响应头（CSP、no-referrer、nosniff、Vary）", () => {
  it("正常 JSON 响应带全套安全头", async () => {
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/catalog")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it("错误响应（404/405/400）同样带安全头——错误页不吃更弱的策略", async () => {
    const notFound = await shell.fetch(
      new Request(siteUrl("/api/v2/nope")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(notFound.status).toBe(404);
    expectSecurityHeaders(notFound);

    const badMethod = await shell.fetch(
      new Request(siteUrl("/api/v2/catalog"), { method: "DELETE" }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(badMethod.status).toBe(405);
    expectSecurityHeaders(badMethod);

    const badFeed = await shell.fetch(
      new Request(siteUrl("/feeds/u/bad~token.ics"), { method: "POST" }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(badFeed.status).toBe(405);
    expectSecurityHeaders(badFeed);
  });
});

describe("A-P1-SHELL 严格同源 CORS（预检与跨源不可读）", () => {
  it("OPTIONS 预检：204、放行方法/头清单，但不输出 ACAO", async () => {
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/catalog"), {
        method: "OPTIONS",
        headers: { origin: "https://app.test" },
      }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-csrf-token");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("跨源预检同样拿不到 ACAO（浏览器层面即拦截，服务端不协助跨源）", async () => {
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/catalog"), {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("跨源 GET 也拿不到 ACAO：公开读对浏览器跨源不可读", async () => {
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/catalog"), {
        headers: { origin: "https://evil.example" },
      }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("A-P1-SHELL CSP 常量合同（认证/退订页不加载第三方脚本）", () => {
  it("API/Feed 用 CSP_STRICT：无任何执行源", () => {
    expect(CSP_STRICT).toContain("default-src 'none'");
    expect(CSP_STRICT).toContain("frame-ancestors 'none'");
  });

  it("HTML 页面 CSP 只允许同源脚本，不含任何第三方源（§8.3）", () => {
    expect(CSP_HTML_SAME_ORIGIN).toContain("script-src 'self'");
    // 不出现任何外部协议源（http/https 的 scheme-source 即第三方加载口）。
    expect(CSP_HTML_SAME_ORIGIN).not.toMatch(/src\s+https?:/);
    expect(CSP_HTML_SAME_ORIGIN).not.toContain("unsafe-inline");
    expect(CSP_HTML_SAME_ORIGIN).not.toContain("unsafe-eval");
  });
});
