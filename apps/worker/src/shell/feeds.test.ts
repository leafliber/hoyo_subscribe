// A-P1-SHELL：Feed 能力端点协议（§8.2 /feeds/u/{token}.ics；§8.3 不进交互登录墙）。
import { describe, expect, it } from "vitest";
import type { Authenticator, ShellAuth } from "./domains";
import { jsonResponse } from "./errors";
import { createApiShell, type RouteContext } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl } from "./test-support";

const authNone: Authenticator = {
  async authenticate(): Promise<ShellAuth> {
    return { kind: "none" };
  },
};

let feedCalls = 0;
let lastFeedContext: RouteContext | null = null;

function makeShell(feedHandler?: ((ctx: RouteContext) => Promise<Response>) | null) {
  feedCalls = 0;
  lastFeedContext = null;
  const stub = async (ctx: RouteContext): Promise<Response> => {
    feedCalls++;
    lastFeedContext = ctx;
    return jsonResponse({ served: true, token_shape: ctx.params.token.length });
  };
  return createApiShell({
    authenticator: authNone,
    // null 显式表示"不挂业务 handler"；省略表示用默认桩。
    feedHandler: feedHandler === null ? undefined : (feedHandler ?? stub),
  });
}

describe("A-P1-SHELL /feeds/u/*：无 Cookie、无 Origin、无登录墙，仍受协议校验", () => {
  it("★ GET 不带任何 Cookie/Origin 直达 feed handler（无 401/302 交互挑战）", async () => {
    const res = await makeShell().fetch(
      new Request(siteUrl("/feeds/u/AbCdEf0123.ics")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(feedCalls).toBe(1);
    expect(lastFeedContext?.params.token).toBe("AbCdEf0123");
    expect(lastFeedContext?.auth.kind).toBe("capability");
  });

  it("HEAD 同样放行", async () => {
    const res = await makeShell().fetch(
      new Request(siteUrl("/feeds/u/AbCdEf0123.ics"), { method: "HEAD" }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(feedCalls).toBe(1);
  });

  it("POST 被协议拒绝：405 + Allow: GET, HEAD；handler 不被调用", async () => {
    const res = await makeShell().fetch(
      new Request(siteUrl("/feeds/u/AbCdEf0123.ics"), { method: "POST" }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(feedCalls).toBe(0);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("token 段形状非法（非法字符 / 缺 .ics / 空段）→ 404 信封，而非 401/重定向", async () => {
    const shell = makeShell();
    for (const path of [
      "/feeds/u/bad~token.ics", // 非法字符
      "/feeds/u/AbCdEf0123", // 缺 .ics
      "/feeds/u/.ics", // 空 token
      "/feeds/u/", // 只有前缀
    ]) {
      const res = await shell.fetch(new Request(siteUrl(path)), fakeEnv, fakeExecutionContext);
      expect(res.status).toBe(404);
      expect(feedCalls).toBe(0);
    }
  });

  it("未挂载 feedHandler 时协议校验后返回 404（不是登录墙）", async () => {
    const res = await makeShell(null).fetch(
      new Request(siteUrl("/feeds/u/AbCdEf0123.ics")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });
});
