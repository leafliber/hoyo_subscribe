// P4-06 开工阻塞探针：只刻画现有外壳缺口，不表示 A-P4-UNSUB 已通过。
// 扩展获准后应替换为标准表单成功、免会话、HTML 确认与实际退订的验收测试。
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CSP_HTML_SAME_ORIGIN, CSP_STRICT } from "../../shell/headers";
import { createApiShell, type ShellRoute } from "../../shell/router";

function probe(route: ShellRoute) {
  const authenticate = vi.fn(async () => ({ kind: "none" as const }));
  const shell = createApiShell({ authenticator: { authenticate }, routes: [route] });
  return {
    authenticate,
    fetch: (request: Request) => shell.fetch(request, env, createExecutionContext()),
  };
}

function oneClickRoute(handler: ShellRoute["handler"]): ShellRoute {
  return {
    method: "POST",
    pattern: "/email/one-click/*",
    domain: "capability",
    write: true,
    // 即使临时允许 false，仍无法通过 JSON 与 Origin 两道前置校验。
    csrf: false,
    bodySchema: { fields: { "List-Unsubscribe": { type: "string" } } },
    handler,
  };
}

describe("P4-06 外壳阻塞复现（非 A-P4-UNSUB 验收通过）", () => {
  it.each(["urlencoded", "multipart"])(
    "标准 %s POST 被外壳拒绝，业务 handler 未执行",
    async (encoding) => {
      const handler = vi.fn(async () => new Response(null, { status: 204 }));
      const shell = probe(oneClickRoute(handler));
      const body = encoding === "multipart" ? new FormData() : new URLSearchParams();
      body.set("List-Unsubscribe", "One-Click");
      // synthetic 路径标记不是签发 token；不含 Cookie / Origin / CSRF。
      const response = await shell.fetch(
        new Request("https://app.test/email/one-click/synthetic-probe", { method: "POST", body }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "validation",
          details: { fields: [{ reason: "content_type_must_be_json" }] },
        },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(shell.authenticate).not.toHaveBeenCalled();
    },
  );

  it("诊断性 JSON 对照：csrf:false 仍要求 Origin，handler 未执行", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const shell = probe(oneClickRoute(handler));
    const response = await shell.fetch(
      new Request("https://app.test/email/one-click/synthetic-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized", details: { reason: "origin_missing" } },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(shell.authenticate).not.toHaveBeenCalled();
  });

  it("HTML handler 的同源 CSP 被外壳覆写为 form-action none", async () => {
    const handler = vi.fn(
      async () =>
        new Response(
          '<!doctype html><html lang="zh-CN"><title>合成探针</title><form method="post"><button>确认退订</button></form></html>',
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": CSP_HTML_SAME_ORIGIN,
            },
          },
        ),
    );
    const shell = probe({
      method: "GET",
      pattern: "/unsubscribe/*",
      domain: "capability",
      write: false,
      handler,
    });
    const response = await shell.fetch(new Request("https://app.test/unsubscribe/synthetic-probe"));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(response.headers.get("content-security-policy")).toBe(CSP_STRICT);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
