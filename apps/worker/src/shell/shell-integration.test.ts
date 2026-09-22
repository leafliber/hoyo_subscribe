// A-P1-SHELL：外壳在真实 Worker 入口（SELF）上的集成行为（index.ts 挂载后的默认形态）。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CSP_STRICT, REFERRER_POLICY } from "./headers";

describe("A-P1-SHELL 挂载后的默认外壳（SELF 集成）", () => {
  it("未挂载的 /api/v2 路径 → 404 统一信封 + 安全头（不暴露路径枚举差异）", async () => {
    const res = await SELF.fetch("https://app.test/api/v2/not-mounted-yet");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(res.headers.get("content-security-policy")).toBe(CSP_STRICT);
    expect(res.headers.get("referrer-policy")).toBe(REFERRER_POLICY);
  });

  it("★ /feeds/u/* GET 无 Cookie 无 Origin 不被登录墙拦截（此处无业务 handler → 404 信封，但绝不是 401/302）", async () => {
    const res = await SELF.fetch("https://app.test/feeds/u/S0meT0ken123.ics");
    expect([401, 302, 403]).not.toContain(res.status);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("/feeds/u/* POST → 405（协议校验仍生效）", async () => {
    const res = await SELF.fetch("https://app.test/feeds/u/S0meT0ken123.ics", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("OPTIONS 预检 → 204 且无 Access-Control-Allow-Origin（严格同源）", async () => {
    const res = await SELF.fetch("https://app.test/api/v2/anything", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("非 API 未知路径 → 404 统一信封（与 /api/v2 未知路径同形）", async () => {
    const res = await SELF.fetch("https://app.test/nope");
    expect(res.status).toBe(404);
    const apiShape = await (await SELF.fetch("https://app.test/api/v2/nope")).json();
    const body = (await res.json()) as unknown;
    expect(body).toEqual(apiShape);
  });
});
