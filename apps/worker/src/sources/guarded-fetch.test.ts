// 受限 fetch 的拒绝面（任务卡 P3-01，验收 ID A-P3-FETCH）。
// 覆盖：非白名单域名 / userinfo / 非 https / 重定向不跟随 / 403 访问控制 / 429 /
// 非 JSON 类型 / 超大响应 / 超时 / 网络错误。全部用替身 fetch，不发真实网络请求。

import { describe, expect, it } from "vitest";
import {
  classifyRestriction,
  type GuardedFetchLimits,
  guardedSourceFetch,
  SOURCE_COLLECTOR_USER_AGENT,
} from "./guarded-fetch";

const LIMITS: GuardedFetchLimits = {
  allowedHosts: ["hk4e-ann-api.mihoyo.com"],
  // 测试操作性数值（探针同款做法）：非业务参数，业务上限在 registry.test.ts 锁定登记值。
  timeoutMs: 25,
  maxResponseBytes: 4096,
};

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** 记录调用并按序回放的 fetch 替身；未消费的断言供"不重试"验证。 */
function recordingFetch(responses: Response[]): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("A-P3-FETCH 受限 fetch：请求限制与失败分类", () => {
  it("非 https、userinfo、非白名单主机在发请求之前被拒绝（fetch 替身零调用）", async () => {
    const { fetchFn, calls } = recordingFetch([jsonResponse("{}")]);
    const scheme = await guardedSourceFetch("http://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(scheme).toMatchObject({ kind: "guard-rejected", code: "scheme_not_allowed" });
    const userinfo = await guardedSourceFetch(
      "https://user:pass@hk4e-ann-api.mihoyo.com/x",
      LIMITS,
      fetchFn,
    );
    expect(userinfo).toMatchObject({ kind: "guard-rejected", code: "userinfo_not_allowed" });
    const host = await guardedSourceFetch("https://evil.example.com/x", LIMITS, fetchFn);
    expect(host).toMatchObject({ kind: "guard-rejected", code: "host_not_in_allowlist" });
    expect(calls.length).toBe(0);
  });

  it("3xx 重定向：记录 location、不跟随、不重试（fetch 恰好一次）", async () => {
    const { fetchFn, calls } = recordingFetch([
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/x" } }),
    ]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({
      kind: "redirect-not-followed",
      status: 302,
      location: "https://elsewhere.example.com/x",
    });
    expect(calls.length).toBe(1);
  });

  it("403 是访问控制信号：restricted 分类（停用并标维护的依据），同样不重试", async () => {
    const { fetchFn, calls } = recordingFetch([
      jsonResponse("forbidden", { status: 403, headers: { "content-type": "text/plain" } }),
    ]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "restricted", status: 403 });
    expect(calls.length).toBe(1);
  });

  it("429 单列为 rate-limited（退避，而非停用）", async () => {
    const { fetchFn } = recordingFetch([new Response(null, { status: 429 })]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "rate-limited", status: 429 });
  });

  it("非 JSON 内容类型被拒绝（类型限制）", async () => {
    const { fetchFn } = recordingFetch([
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "bad-content-type", contentType: "text/html" });
  });

  it("响应体超过上限：response-too-large（截断的 JSON 宁弃勿用）", async () => {
    const { fetchFn } = recordingFetch([jsonResponse("x".repeat(LIMITS.maxResponseBytes + 1))]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "response-too-large", cap: LIMITS.maxResponseBytes });
  });

  it("超时中止：受限时限内未完成即 timeout，不等待", async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test double")));
      });
    }) as typeof fetch;
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "timeout" });
  });

  it("网络错误原样分类", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "network-error", name: "TypeError" });
  });

  it("正常路径：GET、redirect manual、诚实 UA、JSON 头，读体返回文本", async () => {
    const { fetchFn, calls } = recordingFetch([jsonResponse('{"retcode":0}')]);
    const outcome = await guardedSourceFetch("https://hk4e-ann-api.mihoyo.com/x", LIMITS, fetchFn);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, bodyText: '{"retcode":0}' });
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.headers["user-agent"]).toBe(SOURCE_COLLECTOR_USER_AGENT);
    expect(SOURCE_COLLECTOR_USER_AGENT).not.toMatch(/mozilla|chrome|safari/i);
  });

  it("classifyRestriction：401/403/407 与信封 message 的访问限制标记", () => {
    expect(classifyRestriction(403, null)).toContain("http_status_403");
    expect(classifyRestriction(200, "请登录后重试")).toContain("message_marker:请登录");
    expect(classifyRestriction(200, "正常公告标题含登录二字")).toEqual([]);
    expect(classifyRestriction(500, "server error")).toEqual([]);
  });
});
