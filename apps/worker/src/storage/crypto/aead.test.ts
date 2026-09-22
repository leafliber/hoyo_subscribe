// A-P1-CRYPTO · 字段认证加密（任务卡 P1-06 交付物二；主方案 §8.3）。
// 重点：唯一 nonce（同明文两次加密互异、批量 nonce 不重复）、AAD 含记录类型与 ID
// （密文跨记录搬运认证失败）、篡改与畸形信封的明确报错。
import { CONTROLLED_CIPHERTEXT_STORAGE } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import {
  decryptField,
  decryptFieldText,
  encryptField,
  envelopeNonce,
  type FieldCryptoError,
} from "./aead";
import { Keyring } from "./keyring";

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

const OTP_RECORD = { type: "otp-mail-payload", id: "ch-0001" } as const;
const RECEIPT_RECORD = { type: "auth-completion-receipt", id: "ch-0001" } as const;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("A-P1-CRYPTO · 认证加密往返与信封形态", () => {
  it("字符串与字节明文均可往返；信封 = 版本 1 字节 + 12 字节 nonce + 密文‖16 字节 tag", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();

    const envelope = await encryptField(key, OTP_RECORD, "42771309");
    expect(await decryptFieldText(key, OTP_RECORD, envelope)).toBe("42771309");
    expect(envelope.length).toBe(1 + 12 + "42771309".length + 16);
    expect(envelope[0]).toBe(1);

    const payload = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const envelope2 = await encryptField(key, OTP_RECORD, payload);
    expect(await decryptField(key, OTP_RECORD, envelope2)).toEqual(payload);
  });

  it("记录类型取自受控密文登记表：四类记录各自可加密往返", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    for (const entry of CONTROLLED_CIPHERTEXT_STORAGE) {
      const record = { type: entry.id, id: `record-${entry.id}` };
      const envelope = await encryptField(key, record, "payload");
      expect(await decryptFieldText(key, record, envelope)).toBe("payload");
    }
  });
});

describe("A-P1-CRYPTO · 唯一 nonce（§8.3）", () => {
  it("同一明文两次加密产生不同信封与不同 nonce", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const a = await encryptField(key, OTP_RECORD, "42771309");
    const b = await encryptField(key, OTP_RECORD, "42771309");
    expect(a).not.toEqual(b);
    expect(toHex(envelopeNonce(a))).not.toBe(toHex(envelopeNonce(b)));
  });

  it("批量加密 nonce 不重复（10,000 次随机 96 位 nonce 零碰撞）", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const envelope = await encryptField(key, OTP_RECORD, "x");
      seen.add(toHex(envelopeNonce(envelope)));
    }
    expect(seen.size).toBe(10_000);
  });
});

describe("A-P1-CRYPTO · AAD 绑定记录类型与 ID（§8.3：密文跨记录搬运认证失败）", () => {
  it("同 key 下：换记录 ID 解密失败", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const envelope = await encryptField(key, OTP_RECORD, "42771309");
    await expect(
      decryptFieldText(key, { ...OTP_RECORD, id: "ch-0002" }, envelope),
    ).rejects.toMatchObject({
      reason: "auth-failed",
    } as Partial<FieldCryptoError>);
  });

  it("同 key 下：换记录类型解密失败（OTP 载荷搬不进完成回执）", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const envelope = await encryptField(key, OTP_RECORD, "42771309");
    await expect(decryptFieldText(key, RECEIPT_RECORD, envelope)).rejects.toMatchObject({
      reason: "auth-failed",
    } as Partial<FieldCryptoError>);
  });

  it("换 keyring（换根秘密）解密失败", async () => {
    const ringA = await testRing();
    const otherRing = await Keyring.create({
      masterSecret: randomBytes(32),
      otpPepper: randomBytes(32),
      unsubscribeMacCurrentKeyId: "k1",
    });
    const envelope = await encryptField(ringA.fieldEncryption(), OTP_RECORD, "42771309");
    await expect(
      decryptFieldText(otherRing.fieldEncryption(), OTP_RECORD, envelope),
    ).rejects.toMatchObject({
      reason: "auth-failed",
    } as Partial<FieldCryptoError>);
  });
});

describe("A-P1-CRYPTO · 篡改与畸形信封", () => {
  it("改动密文任一位、改动 nonce 任一位、截断、坏版本字节都明确报错", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const envelope = await encryptField(key, OTP_RECORD, "42771309");

    const tamperedCt = new Uint8Array(envelope);
    tamperedCt[tamperedCt.length - 1] ^= 0x01;
    await expect(decryptFieldText(key, OTP_RECORD, tamperedCt)).rejects.toMatchObject({
      reason: "auth-failed",
    });

    const tamperedNonce = new Uint8Array(envelope);
    tamperedNonce[5] ^= 0x80;
    await expect(decryptFieldText(key, OTP_RECORD, tamperedNonce)).rejects.toMatchObject({
      reason: "auth-failed",
    });

    // 截掉 3 字节仍 ≥ 最小信封长度（1+12+16），形状检查放行后由 GCM 认证拦截——
    // 截断不泄露与篡改的区别，统一报 auth-failed。
    await expect(
      decryptFieldText(key, OTP_RECORD, envelope.slice(0, envelope.length - 3)),
    ).rejects.toMatchObject({
      reason: "auth-failed",
    });
    await expect(decryptFieldText(key, OTP_RECORD, new Uint8Array(10))).rejects.toMatchObject({
      reason: "bad-envelope",
    });

    const badVersion = new Uint8Array(envelope);
    badVersion[0] = 2;
    await expect(decryptFieldText(key, OTP_RECORD, badVersion)).rejects.toMatchObject({
      reason: "bad-version",
    });
  });

  it("错误以 FieldCryptoError 抛出且消息不泄露明文", async () => {
    const ring = await testRing();
    const key = ring.fieldEncryption();
    const secret = "42771309";
    const envelope = await encryptField(key, OTP_RECORD, secret);
    const tampered = new Uint8Array(envelope);
    tampered[tampered.length - 2] ^= 0x40;
    let message = "";
    try {
      await decryptFieldText(key, OTP_RECORD, tampered);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).toContain("auth-failed");
  });
});
