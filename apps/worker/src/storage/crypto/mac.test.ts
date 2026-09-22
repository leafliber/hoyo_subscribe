// A-P1-CRYPTO · MAC 用途操作（任务卡 P1-06；主方案 §4.1、§4.3）。
// 重点：OTP MAC 六元组绑定的完整性（任一字段变化必须得到不同 MAC）、
// 验证失败路径不抛错、email_key 的确定性与形态。
import { OTP_DIGITS } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { Keyring } from "./keyring";
import {
  computeEmailKey,
  computePurposeMac,
  macOtpVerification,
  type OtpMacBinding,
  verifyOtpMac,
  verifyPurposeMac,
} from "./mac";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

let ringPromise: Promise<Keyring> | null = null;
function testRing(): Promise<Keyring> {
  ringPromise ??= Keyring.create({
    masterSecret: randomBytes(32),
    otpPepper: randomBytes(32),
    unsubscribeMacCurrentKeyId: "k1",
  });
  return ringPromise;
}

const BASE_BINDING: OtpMacBinding = {
  purpose: "login",
  challengeId: "ch-0001",
  emailKey: "ab".repeat(32),
  addressVersion: 1,
  generation: 0,
  code: "87654321",
};

describe("A-P1-CRYPTO · OTP 验证 MAC（§4.3 六元组绑定）", () => {
  it("确定性：同绑定同 MAC，hex 64 字符", async () => {
    const ring = await testRing();
    const a = await macOtpVerification(ring.otpMac(), BASE_BINDING);
    const b = await macOtpVerification(ring.otpMac(), BASE_BINDING);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("绑定完整性：六元组任一字段变化都得到不同 MAC（§4.3）", async () => {
    const ring = await testRing();
    const base = await macOtpVerification(ring.otpMac(), BASE_BINDING);
    const variants: OtpMacBinding[] = [
      { ...BASE_BINDING, purpose: "register" },
      { ...BASE_BINDING, challengeId: "ch-0002" },
      { ...BASE_BINDING, emailKey: "cd".repeat(32) },
      { ...BASE_BINDING, addressVersion: 2 },
      { ...BASE_BINDING, generation: 1 },
      { ...BASE_BINDING, code: "87654322" },
    ];
    for (const variant of variants) {
      const mac = await macOtpVerification(ring.otpMac(), variant);
      expect(mac).not.toBe(base);
    }
  });

  it("验证：正确绑定通过；任一字段不符或 MAC 损坏返回 false（不抛错）", async () => {
    const ring = await testRing();
    const mac = await macOtpVerification(ring.otpMac(), BASE_BINDING);
    expect(await verifyOtpMac(ring.otpMac(), BASE_BINDING, mac)).toBe(true);
    expect(await verifyOtpMac(ring.otpMac(), { ...BASE_BINDING, code: "87654322" }, mac)).toBe(
      false,
    );
    expect(await verifyOtpMac(ring.otpMac(), { ...BASE_BINDING, generation: 3 }, mac)).toBe(false);
    expect(await verifyOtpMac(ring.otpMac(), BASE_BINDING, `0${mac.slice(1)}`)).toBe(false);
    expect(await verifyOtpMac(ring.otpMac(), BASE_BINDING, "not-hex!")).toBe(false);
  });

  it("验证码形状由 OTP_DIGITS 约束：位数不符或非数字直接抛错（注册表参数）", async () => {
    const ring = await testRing();
    await expect(
      macOtpVerification(ring.otpMac(), { ...BASE_BINDING, code: "1234567" }),
    ).rejects.toThrow(/OTP_DIGITS/);
    await expect(
      macOtpVerification(ring.otpMac(), { ...BASE_BINDING, code: "123456789" }),
    ).rejects.toThrow(/OTP_DIGITS/);
    await expect(
      macOtpVerification(ring.otpMac(), { ...BASE_BINDING, code: "1234567a" }),
    ).rejects.toThrow(/OTP_DIGITS/);
    expect(String(OTP_DIGITS)).toBe("8"); // 与注册表对账（防测试自身漂移）
  });
});

describe("A-P1-CRYPTO · email_key（§4.1：HMAC(lookup_key, canonical_email)）", () => {
  it("确定性：同规范邮箱同 key；hex 64 字符", async () => {
    const ring = await testRing();
    const a = await computeEmailKey(ring.emailLookup(), "user@example.com");
    const b = await computeEmailKey(ring.emailLookup(), "user@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不同规范邮箱得到不同 key（身份不可碰撞）", async () => {
    const ring = await testRing();
    const a = await computeEmailKey(ring.emailLookup(), "user@example.com");
    const b = await computeEmailKey(ring.emailLookup(), "other@example.com");
    const c = await computeEmailKey(ring.emailLookup(), "user@example.org");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("A-P1-CRYPTO · 通用用途 MAC（csrf / vapid / admin / recovery-epoch，§8.3）", () => {
  it("同域同数据可验证；数据或域变化验证失败", async () => {
    const ring = await testRing();
    const mac = await computePurposeMac(ring.csrf(), "csrf:probe", "session-1");
    expect(await verifyPurposeMac(ring.csrf(), "csrf:probe", "session-1", mac)).toBe(true);
    expect(await verifyPurposeMac(ring.csrf(), "csrf:probe", "session-2", mac)).toBe(false);
    expect(await verifyPurposeMac(ring.csrf(), "csrf:other", "session-1", mac)).toBe(false);
  });

  it("字节数据与字符串数据走不同编码路径，均能验证", async () => {
    const ring = await testRing();
    const data = new Uint8Array([1, 2, 3, 250, 0]);
    const mac = await computePurposeMac(ring.admin(), "admin:probe", data);
    expect(await verifyPurposeMac(ring.admin(), "admin:probe", data, mac)).toBe(true);
    const text = await computePurposeMac(ring.recoveryEpoch(), "epoch:probe", "user-1");
    expect(await verifyPurposeMac(ring.recoveryEpoch(), "epoch:probe", "user-1", text)).toBe(true);
  });

  it("MAC 非法 base64url 返回 false（不抛错）", async () => {
    const ring = await testRing();
    expect(await verifyPurposeMac(ring.csrf(), "csrf:probe", "x", "??invalid??")).toBe(false);
    expect(await verifyPurposeMac(ring.csrf(), "csrf:probe", "x", "a=b")).toBe(false);
  });
});
