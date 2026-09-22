// A-P1-SHELL：存在性折叠的公开模板合同（§4.2 末段、§8.2 末段）。
import { describe, expect, it } from "vitest";
import {
  AUTH_INTENT_PUBLIC_BODY,
  AUTH_INTENT_PUBLIC_STATUS,
  assertResponsesFolded,
} from "./existence";

describe("A-P1-SHELL 存在性折叠公开模板（contracts 单一来源）", () => {
  it("模板是固定常量：状态 202，正文只有 message 一个键，文案即 §4.2 原文语义", () => {
    expect(AUTH_INTENT_PUBLIC_STATUS).toBe(202);
    expect(Object.keys(AUTH_INTENT_PUBLIC_BODY)).toEqual(["message"]);
    expect(AUTH_INTENT_PUBLIC_BODY.message).toContain("验证码");
  });

  it("模板序列化字节稳定（两次 JSON.stringify 完全一致）", () => {
    expect(JSON.stringify(AUTH_INTENT_PUBLIC_BODY)).toBe(JSON.stringify(AUTH_INTENT_PUBLIC_BODY));
  });

  it("assertResponsesFolded：状态与正文全同 → 不抛；状态差或正文差 → 抛错", () => {
    const base = { status: 202, bodyText: '{"message":"符合条件的请求将发送验证码。"}' };
    expect(() => assertResponsesFolded(base, { ...base })).not.toThrow();
    expect(() => assertResponsesFolded(base, { ...base, status: 400 })).toThrow(/状态码不同/);
    expect(() =>
      assertResponsesFolded(base, { status: 202, bodyText: '{"message":"该邮箱不存在"}' }),
    ).toThrow(/响应体不一致/);
    // 字节级：一字节之差也算破坏（响应大小不可泄露）。
    expect(() =>
      assertResponsesFolded(base, { status: 202, bodyText: `${base.bodyText} ` }),
    ).toThrow(/响应体不一致/);
  });
});
