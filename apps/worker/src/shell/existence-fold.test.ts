// A-P1-SHELL：认证存在性敏感结果的折叠（任务卡交付物二；§4.2 末段、§8.2 末段）。
//
// 用一个形如 P2 /auth/challenges 的演示路由驱动真实折叠机制：已注册走真校验、
// 未注册走等成本必败校验，公开响应一律出自 contracts 固定模板。
// 反向验证的变异点就在 runExistenceFold（去掉未注册分支的工作量配平）——
// "未注册分支执行 dummy 恰好一次"与"字节同形"两条用例必须红。
import { assertResponsesFolded } from "@hoyo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Authenticator, ShellAuth } from "./domains";
import { dummyOtpMacVerify, publicAuthIntentResponse, runExistenceFold } from "./existence-fold";
import { createApiShell, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl, testKeyring } from "./test-support";

const CHALLENGES_PATH = "/api/v2/auth/challenges";
const KNOWN_EMAIL = "known.user@example.com";
const UNKNOWN_EMAIL = "never.registered@example.net";

const authNone: Authenticator = {
  async authenticate(): Promise<ShellAuth> {
    return { kind: "none" };
  },
};

describe("A-P1-SHELL 存在性折叠机制（runExistenceFold）", () => {
  it("exists=true 走 real、不跑 dummy；exists=false 走 dummy、不跑 real；返回值恒 void", async () => {
    let realCalls = 0;
    let dummyCalls = 0;
    const result1 = await runExistenceFold(true, {
      real: async () => {
        realCalls++;
      },
      dummy: async () => {
        dummyCalls++;
      },
    });
    expect([realCalls, dummyCalls]).toEqual([1, 0]);
    const result2 = await runExistenceFold(false, {
      real: async () => {
        realCalls++;
      },
      dummy: async () => {
        dummyCalls++;
      },
    });
    expect([realCalls, dummyCalls]).toEqual([1, 1]);
    // 分支信息不外泄：两条路径的返回值无差别，调用方无法据此分化响应。
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  it("dummyOtpMacVerify 恰好触发一次底层 HMAC verify（等成本的一单元）", async () => {
    const verifySpy = vi.spyOn(crypto.subtle, "verify");
    try {
      await dummyOtpMacVerify((await testKeyring).otpMac());
      expect(verifySpy).toHaveBeenCalledTimes(1);
    } finally {
      verifySpy.mockRestore();
    }
  });

  it("publicAuthIntentResponse 字节恒定：两次构造状态与正文完全一致", async () => {
    const a = publicAuthIntentResponse();
    const b = publicAuthIntentResponse();
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

describe("A-P1-SHELL 已注册 vs 未注册邮箱：响应体/状态码/大小一致（演示路由）", () => {
  let realCalls = 0;
  let dummyCalls = 0;

  function buildShell() {
    const route: ShellRoute = {
      method: "POST",
      pattern: CHALLENGES_PATH,
      domain: "public",
      write: true,
      csrf: false,
      bodySchema: {
        fields: { email: { type: "string", minLength: 3, maxLength: 320 } },
      },
      handler: async (ctx) => {
        const email = String(ctx.body?.email ?? "");
        const exists = email === KNOWN_EMAIL;
        await runExistenceFold(exists, {
          real: async () => {
            realCalls++;
            await dummyOtpMacVerify((await testKeyring).otpMac());
          },
          dummy: async () => {
            dummyCalls++;
            await dummyOtpMacVerify((await testKeyring).otpMac());
          },
        });
        return publicAuthIntentResponse();
      },
    };
    return createApiShell({ authenticator: authNone, routes: [route] });
  }

  async function applyFor(email: string): Promise<Response> {
    return buildShell().fetch(
      new Request(siteUrl(CHALLENGES_PATH), {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.test" },
        body: JSON.stringify({ email }),
      }),
      fakeEnv,
      fakeExecutionContext,
    );
  }

  it("★ 同一输入形状 → 同一响应：状态、正文、字节长度全一致；不回显存在性", async () => {
    const known = await applyFor(KNOWN_EMAIL);
    const unknown = await applyFor(UNKNOWN_EMAIL);

    const knownText = await known.text();
    const unknownText = await unknown.text();
    assertResponsesFolded(
      { status: known.status, bodyText: knownText },
      {
        status: unknown.status,
        bodyText: unknownText,
      },
    );
    // 响应大小不可泄露：字节级一致。
    expect(new TextEncoder().encode(knownText).byteLength).toBe(
      new TextEncoder().encode(unknownText).byteLength,
    );
    // 不回显邮箱、不出现存在性表述（§4.2"不能回显该邮箱不存在"）。
    for (const text of [knownText, unknownText]) {
      expect(text).not.toContain(KNOWN_EMAIL);
      expect(text).not.toContain(UNKNOWN_EMAIL);
      expect(text).not.toContain("不存在");
      expect(text).not.toContain("未注册");
      expect(text).not.toContain("已注册");
    }
  });

  it("★ 时序配平：已注册走 real、未注册走 dummy，各恰好一次（无提前返回）", async () => {
    const realBefore = realCalls;
    const dummyBefore = dummyCalls;
    await applyFor(KNOWN_EMAIL);
    expect(realCalls).toBe(realBefore + 1);
    expect(dummyCalls).toBe(dummyBefore);

    await applyFor(UNKNOWN_EMAIL);
    expect(realCalls).toBe(realBefore + 1); // real 未增加
    expect(dummyCalls).toBe(dummyBefore + 1); // dummy 恰好一次——变异（提前返回）会在这里失败
  });

  it("两条路径的 HMAC verify 次数一致（每请求恰好一次底层 verify）", async () => {
    const verifySpy = vi.spyOn(crypto.subtle, "verify");
    try {
      await applyFor(KNOWN_EMAIL);
      const knownVerifies = verifySpy.mock.calls.length;
      verifySpy.mockClear();
      await applyFor(UNKNOWN_EMAIL);
      const unknownVerifies = verifySpy.mock.calls.length;
      expect(knownVerifies).toBe(unknownVerifies);
      expect(knownVerifies).toBe(1);
    } finally {
      verifySpy.mockRestore();
    }
  });
});
