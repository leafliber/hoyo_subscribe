import { createExecutionContext, env } from "cloudflare:test";
import { API_BODY_MAX_BYTES } from "@hoyo/contracts";
import { describe, expect, it, vi } from "vitest";
import { CSP_HTML_SAME_ORIGIN, CSP_STRICT } from "./headers";
import { createApiShell, type ShellRoute } from "./router";

const origin = "https://synthetic.example";
const path = "/email/one-click/synthetic-secret";
function harness(overrides: Partial<ShellRoute> = {}) {
  const handler = vi.fn<ShellRoute["handler"]>(async () => new Response(null, { status: 204 }));
  const authenticate = vi.fn(async () => ({ kind: "none" as const }));
  const route: ShellRoute = {
    method: "POST",
    pattern: "/email/one-click/*",
    domain: "capability",
    write: true,
    protocol: "unsubscribe",
    bodySchema: { fields: { "List-Unsubscribe": { type: "string" } } },
    handler,
    ...overrides,
  };
  const shell = createApiShell({ routes: [route], authenticator: { authenticate } });
  return {
    handler,
    authenticate,
    fetch: (request: Request) => shell.fetch(request, env, createExecutionContext()),
  };
}
const request = (
  body: BodyInit = "List-Unsubscribe=One-Click",
  type = "application/x-www-form-urlencoded",
  suffix = path,
  extra: Record<string, string> = {},
) =>
  new Request(origin + suffix, {
    method: "POST",
    headers: { "content-type": type, ...extra },
    body,
  });

describe("A-P4-UNSUB 封闭外壳协议", () => {
  it.each(["urlencoded", "multipart"])(
    "%s 无 Cookie/Origin/CSRF 正常进入能力 handler",
    async (encoding) => {
      const h = harness();
      const body = encoding === "multipart" ? new FormData() : new URLSearchParams();
      body.set("List-Unsubscribe", "One-Click");
      const res = await h.fetch(new Request(origin + path, { method: "POST", body }));
      expect(res.status).toBe(204);
      expect(h.authenticate).not.toHaveBeenCalled();
      expect(h.handler).toHaveBeenCalledOnce();
      expect(h.handler.mock.calls[0]?.[0]).toMatchObject({
        body: { "List-Unsubscribe": "One-Click" },
        params: { token: "synthetic-secret" },
        auth: { kind: "capability" },
        ownerUserId: null,
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    },
  );
  it("无视 Cookie/Authorization 与跨站 Origin，能力目标只来自路径", async () => {
    const h = harness();
    expect(
      (
        await h.fetch(
          request(undefined, undefined, path, {
            cookie: "synthetic",
            authorization: "synthetic",
            origin: "https://elsewhere.test",
          }),
        )
      ).status,
    ).toBe(204);
    expect(h.authenticate).not.toHaveBeenCalled();
  });
  it.each([
    "/email/one-click-suffix/synthetic-secret",
    "/email/one-click/synthetic-secret/extra",
    "/email/one-click/",
    "/email/one-click",
    "/email/one-click//",
    "/prefix/email/one-click/synthetic-secret",
    "/email/one-click/%2f",
    "/email/one-click/%5C",
    "/email/one-click/%252f",
    "/email/one-click/a%2Fb",
    "/unsubscribe-suffix/synthetic-secret",
    "/unsubscribe/synthetic-secret/extra",
    "/unsubscribe/",
    "/unsubscribe/%2f",
  ])("实际路径 %s 不得抵达 handler", async (candidate) => {
    const h = harness(candidate.startsWith("/unsubscribe") ? { pattern: "/unsubscribe/*" } : {});
    expect((await h.fetch(request(undefined, undefined, candidate))).status).toBe(404);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each<Partial<ShellRoute>>([
    { domain: "user" },
    { domain: "admin" },
    { domain: "public" },
    { write: false },
    { method: "GET", write: false },
    { method: "DELETE" },
    { pattern: "/api/v2/x/*" },
    { allowPending: true },
    { allowRecoveryWrite: true },
    { csrf: false },
  ])("错误协议声明失败关闭 %j", async (overrides) => {
    const h = harness(overrides);
    const url = overrides.pattern ? `${origin}/api/v2/x/synthetic-secret` : origin + path;
    const method = overrides.method ?? "POST";
    const res = await h.fetch(
      new Request(url, {
        method,
        ...(method === "GET"
          ? {}
          : { body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }),
      }),
    );
    expect(res.status).toBe(503);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });
  it("GET one-click、PUT 确认路由不授权；GET 确认不读请求体", async () => {
    const h = harness();
    expect((await h.fetch(new Request(origin + path))).status).toBe(405);
    const get = harness({ pattern: "/unsubscribe/*", method: "GET", write: false });
    expect((await get.fetch(new Request(`${origin}/unsubscribe/synthetic-secret`))).status).toBe(
      204,
    );
    expect(get.handler.mock.calls[0]?.[0]).not.toHaveProperty("body", expect.anything());
    expect(
      (await get.fetch(new Request(`${origin}/unsubscribe/synthetic-secret`, { method: "PUT" })))
        .status,
    ).toBe(405);
  });
  it("仅显式确认页有同源 CSP，普通 API 即使返回 HTML 也保持严格 CSP", async () => {
    const handler = async () =>
      new Response("<form method=post></form>", {
        headers: { "content-type": "text/html", "content-security-policy": "default-src *" },
      });
    const h = harness({ method: "GET", write: false, pattern: "/unsubscribe/*", handler });
    const res = await h.fetch(new Request(`${origin}/unsubscribe/synthetic-secret`));
    expect(res.headers.get("content-security-policy")).toBe(CSP_HTML_SAME_ORIGIN);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const api = harness({
      method: "GET",
      write: false,
      protocol: undefined,
      pattern: "/api/v2/x",
      handler,
    });
    expect(
      (await api.fetch(new Request(`${origin}/api/v2/x`))).headers.get("content-security-policy"),
    ).toBe(CSP_STRICT);
  });
  it("普通 JSON 写路由仍拒表单、缺 Origin、缺 CSRF", async () => {
    const h = harness({ protocol: undefined, domain: "public" });
    expect((await h.fetch(request())).status).toBe(400);
    expect(
      (await h.fetch(request('{"List-Unsubscribe":"One-Click"}', "application/json"))).status,
    ).toBe(401);
    expect(
      (
        await h.fetch(
          request('{"List-Unsubscribe":"One-Click"}', "application/json", path, { origin }),
        )
      ).status,
    ).toBe(503);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("one-click 防御性去 Cookie，拒绝 handler 重定向", async () => {
    const h = harness({
      handler: async () =>
        new Response(null, {
          status: 302,
          headers: { location: origin, "set-cookie": "synthetic=1" },
        }),
    });
    const res = await h.fetch(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });
  it("畸形字段、路径、异常名均不泄漏 token 或完整 URL 到错误和日志", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const h = harness();
      const res = await h.fetch(request("synthetic-secret=synthetic-secret"));
      const bad = harness({
        handler: async () => {
          const error = new Error(origin + path);
          error.name = "synthetic-secret";
          throw error;
        },
      });
      const error = await bad.fetch(request());
      await h.fetch(request(undefined, undefined, `${path}/extra`));
      expect(await res.text()).not.toContain("synthetic-secret");
      expect(await error.text()).not.toContain("synthetic-secret");
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(log.mock.calls)).not.toContain(origin);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      log.mockRestore();
    }
  });
});

describe("A-P4-UNSUB 有界表单结构", () => {
  it.each([
    "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click",
    "List-Unsubscribe=One-Click&user_id=other",
    "List-Unsubscribe=One-Click&unknown=value",
    "List-Unsubscribe=One-Click&",
    "List-Unsubscribe",
    "List-Unsubscribe=%ZZ",
    "List-Unsubscribe=%C0%AF",
    "List-Unsubscribe=One-Click&%4cist-Unsubscribe=One-Click",
    "",
    "=One-Click",
    "owner_user_id=other",
  ])("拒绝 urlencoded 畸形、重复与非协议字段 %s", async (body) => {
    const h = harness();
    expect((await h.fetch(request(body))).status).toBe(400);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "unknown", "owner", "file"])("拒绝 multipart %s", async (kind) => {
    const h = harness();
    const body = new FormData();
    body.set("List-Unsubscribe", "One-Click");
    if (kind === "duplicate") body.append("List-Unsubscribe", "One-Click");
    if (kind === "unknown") body.set("unknown", "x");
    if (kind === "owner") body.set("userId", "x");
    if (kind === "file") body.set("List-Unsubscribe", new Blob(["One-Click"]), "synthetic.txt");
    expect((await h.fetch(new Request(origin + path, { method: "POST", body }))).status).toBe(400);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each([
    '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click',
    '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--x--\r\ntrailing',
    '--x\nContent-Disposition: form-data; name="List-Unsubscribe"\n\nOne-Click\n--x--',
    '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\nContent-Disposition: form-data; name="other"\r\n\r\nOne-Click\r\n--x--',
  ])("拒绝畸形 multipart 结构", async (body) => {
    const h = harness();
    expect((await h.fetch(request(body, "multipart/form-data; boundary=x"))).status).toBe(400);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each([undefined, "1"])("无/伪造 Content-Length=%s 时在流超限即取消读取", async (declared) => {
    const h = harness();
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(API_BODY_MAX_BYTES));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = await h.fetch(
      request(stream, undefined, path, declared ? { "content-length": declared } : {}),
    );
    expect(res.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(reads).toBe(2);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("实际字节上限含边界、UTF-8，非法 UTF-8 拒绝", async () => {
    const h = harness();
    const prefix = "List-Unsubscribe=";
    expect(
      (await h.fetch(request(prefix + "x".repeat(API_BODY_MAX_BYTES - prefix.length)))).status,
    ).toBe(204);
    expect(
      (await h.fetch(request(prefix + "x".repeat(API_BODY_MAX_BYTES - prefix.length + 1)))).status,
    ).toBe(400);
    expect((await h.fetch(request(new Uint8Array([0xff])))).status).toBe(400);
    expect((await h.fetch(request(prefix + "界".repeat(API_BODY_MAX_BYTES)))).status).toBe(400);
  });
});
