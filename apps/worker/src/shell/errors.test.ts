// A-P1-SHELL：七类错误经外壳的真实响应 + 未预期异常折叠（§8.2 末段；前端 §11.3）。
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  DEFAULT_API_ERROR_MESSAGES,
  isApiErrorBody,
} from "@hoyo/contracts";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Authenticator, ShellAuth } from "./domains";
import { ApiError, jsonResponse } from "./errors";
import { createApiShell, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl } from "./test-support";

const authNone: Authenticator = {
  async authenticate(): Promise<ShellAuth> {
    return { kind: "none" };
  },
};

/** 公开读路由：handler 按 case 抛错或返回，用来驱动错误映射。 */
function shellWithHandler(handler: (ctx: unknown) => Promise<Response>) {
  const route: ShellRoute = {
    method: "GET",
    pattern: "/api/v2/probe",
    domain: "public",
    write: false,
    handler: handler as ShellRoute["handler"],
  };
  return createApiShell({ authenticator: authNone, routes: [route] });
}

describe("A-P1-SHELL 七类错误经外壳输出 contracts 形状", () => {
  it.each([...API_ERROR_CODES])("错误码 %s → 状态/信封/文案与 contracts 一致", async (code) => {
    const shell = shellWithHandler(async () => {
      throw new ApiError(code);
    });
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(API_ERROR_STATUS[code]);
    const body = (await res.json()) as unknown;
    expect(isApiErrorBody(body)).toBe(true);
    const parsed = body as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe(DEFAULT_API_ERROR_MESSAGES[code]);
  });

  it("handler 正常返回 JSON 时原样透传（200）", async () => {
    const shell = shellWithHandler(async () => jsonResponse({ ok: true }));
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe("A-P1-SHELL 未预期异常折叠为 temporarily_unavailable", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("抛普通 Error → 503 统一响应；日志只记 error.name，不落 message", async () => {
    const poisonMessage = "boom user@example.com /feeds/u/abcdefghijklmnop.ics";
    const shell = shellWithHandler(async () => {
      throw new TypeError(poisonMessage);
    });
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("temporarily_unavailable");

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    const errorLine = lines.find((line) => line.includes("handler_error"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("TypeError");
    // 错误 message 可能携带库内部串/秘密形态：不落盘（§8.3）。
    expect(errorLine).not.toContain("user@example.com");
    expect(errorLine).not.toContain(poisonMessage);
  });

  it("抛非 Error 值 → 同样折叠为 503，不炸穿外壳", async () => {
    const shell = shellWithHandler(async () => {
      throw "plain string failure";
    });
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(503);
  });
});
