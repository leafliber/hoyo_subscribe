// A-P1-CRYPTO · 退订 MAC token（任务卡 P1-06；主方案 §7.6）。
// 重点：绑定不可变 email_binding_id 与 list_scope、token 无邮箱明文、
// key_id 轮换保留旧 token 验证、灾难性撤销明确失效。
import { describe, expect, it } from "vitest";
import { Keyring } from "./keyring";
import {
  signUnsubscribeToken,
  type UnsubscribeBinding,
  verifyUnsubscribeToken,
} from "./unsubscribe";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const MASTER = randomBytes(32);
const PEPPER = randomBytes(32);

const BINDING: UnsubscribeBinding = { emailBindingId: "eb-000123", listScope: "routine" };

describe("A-P1-CRYPTO · 退订 token 基本形态（§7.6）", () => {
  it("签发/验证往返：v1.<key_id>.<base64url MAC>，验证回报 keyId", async () => {
    const ring = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(ring.unsubscribeMac(), BINDING);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("k1");
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{43}$/); // HMAC-SHA-256 的 base64url
    const result = await verifyUnsubscribeToken(ring.unsubscribeMac(), token, BINDING);
    expect(result).toEqual({ ok: true, keyId: "k1" });
  });

  it("token 中没有邮箱明文（§7.6：不在 token 中放邮箱明文）", async () => {
    const ring = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(ring.unsubscribeMac(), BINDING);
    expect(token).not.toContain("example");
    expect(token).not.toContain("@");
    expect(token.toLowerCase()).not.toContain(BINDING.emailBindingId.toLowerCase());
  });

  it("绑定不符返回 bad-mac：换 emailBindingId 或 listScope 都失败", async () => {
    const ring = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(ring.unsubscribeMac(), BINDING);
    expect(
      (
        await verifyUnsubscribeToken(ring.unsubscribeMac(), token, {
          ...BINDING,
          emailBindingId: "eb-999",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyUnsubscribeToken(ring.unsubscribeMac(), token, {
          ...BINDING,
          listScope: "urgent",
        })
      ).ok,
    ).toBe(false);
  });

  it("畸形 token 明确失效不抛错：形状 / 版本 / 编码 / 未知 key_id / 伪造 MAC", async () => {
    const ring = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "", BINDING)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "v1.k1", BINDING)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "v2.k1.AAAA", BINDING)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "v1.k1.###", BINDING)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "v1.kx.AAAA", BINDING)).toEqual({
      ok: false,
      reason: "unknown-key-id",
    });
    expect(await verifyUnsubscribeToken(ring.unsubscribeMac(), "v1.k1.AAAA", BINDING)).toEqual({
      ok: false,
      reason: "bad-mac",
    });
  });
});

describe("A-P1-CRYPTO · 退订 token 的 key_id 轮换（§7.6）", () => {
  it("正常轮换：旧 key_id 签的 token 在新配置下仍可验证（保留验证能力）", async () => {
    const oldRing = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(oldRing.unsubscribeMac(), BINDING);

    const newRing = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k2",
      unsubscribeMacAcceptedKeyIds: ["k2", "k1"],
    });
    // 旧 token：跨重新订阅仍关闭当前业务邮件
    expect(await verifyUnsubscribeToken(newRing.unsubscribeMac(), token, BINDING)).toEqual({
      ok: true,
      keyId: "k1",
    });
    // 新 token 用当前 key_id 签发
    const newToken = await signUnsubscribeToken(newRing.unsubscribeMac(), BINDING);
    expect(await verifyUnsubscribeToken(newRing.unsubscribeMac(), newToken, BINDING)).toEqual({
      ok: true,
      keyId: "k2",
    });
  });

  it("灾难性撤销：key_id 移出接受集合后明确失效，不静默成功", async () => {
    const oldRing = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(oldRing.unsubscribeMac(), BINDING);

    const revokedRing = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k2",
    });
    expect(await verifyUnsubscribeToken(revokedRing.unsubscribeMac(), token, BINDING)).toEqual({
      ok: false,
      reason: "unknown-key-id",
    });
  });

  it("换根秘密后旧 token 不再有效（MAC 不匹配，不以成功冒充）", async () => {
    const oldRing = await Keyring.create({
      masterSecret: MASTER,
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const token = await signUnsubscribeToken(oldRing.unsubscribeMac(), BINDING);
    const otherRing = await Keyring.create({
      masterSecret: randomBytes(32),
      otpPepper: PEPPER,
      unsubscribeMacCurrentKeyId: "k1",
    });
    expect(await verifyUnsubscribeToken(otherRing.unsubscribeMac(), token, BINDING)).toEqual({
      ok: false,
      reason: "bad-mac",
    });
  });
});
