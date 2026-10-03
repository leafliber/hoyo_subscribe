import { afterEach, describe, expect, it, vi } from "vitest";
import { siteverifyTurnstileVerifier } from "./turnstile";

const origin = "https://configured.example.invalid";
const valid = { success: true, hostname: "configured.example.invalid", action: "login" };
const input = { token: "synthetic-token", expectedAction: "login" } as const;
afterEach(() => vi.restoreAllMocks());

describe("A-P2-PREAUTH 生产 Siteverify 校验器（仅替身 fetch）", () => {
  it("绑定配置 hostname 和用途；仅提交 secret/response，不收集 IP", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(valid));
    expect(await siteverifyTurnstileVerifier("synthetic-secret", `${origin}/`).verify(input)).toBe(
      "passed",
    );
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    expect(Array.from((body as FormData).entries())).toEqual([
      ["secret", "synthetic-secret"],
      ["response", "synthetic-token"],
    ]);
  });
  it.each([
    null,
    [],
    [valid],
    true,
    "ok",
    1,
    {},
    { ...valid, success: false },
    { ...valid, success: "true" },
    { ...valid, success: 1 },
    { ...valid, success: null },
    { hostname: valid.hostname, action: valid.action },
    { success: true, action: valid.action },
    { success: true, hostname: valid.hostname },
    ...[null, true, 123, [], {}, "wrong.example.invalid", "localhost", "127.0.0.1"].map(
      (hostname) => ({ ...valid, hostname }),
    ),
    ...[null, true, 123, [], {}, "signup", "account_delete_current", "Login"].map((action) => ({
      ...valid,
      action,
    })),
  ])("响应形状/域名/用途不匹配失败关闭 %#", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    expect(await siteverifyTurnstileVerifier("synthetic-secret", origin).verify(input)).toBe(
      "failed",
    );
  });
  it.each([302, 400, 500])("非 2xx %i 即使载荷有效也拒绝", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(valid, { status }));
    expect(await siteverifyTurnstileVerifier("synthetic-secret", origin).verify(input)).toBe(
      "failed",
    );
  });
  it("网络失败、无效 JSON 和重放失败均返回 failed", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("synthetic network failure"))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(
        Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      );
    const verifier = siteverifyTurnstileVerifier("synthetic-secret", origin);
    for (let i = 0; i < 3; i++) expect(await verifier.verify(input)).toBe("failed");
  });
  it.each([
    "",
    "invalid",
    "http://configured.example.invalid",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://a.localhost",
    `${origin}/path`,
    `${origin}?q=1`,
    `${origin}#x`,
    "https://user@configured.example.invalid",
  ])("缺失/非法/本地域名配置失败关闭 %#", (siteOrigin) => {
    const upstream = vi.spyOn(globalThis, "fetch");
    expect(() => siteverifyTurnstileVerifier("synthetic-secret", siteOrigin)).toThrow();
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["", " "])("Secret 缺失不触网 %#", (secret) => {
    const upstream = vi.spyOn(globalThis, "fetch");
    expect(() => siteverifyTurnstileVerifier(secret, origin)).toThrow();
    expect(upstream).not.toHaveBeenCalled();
  });
});
