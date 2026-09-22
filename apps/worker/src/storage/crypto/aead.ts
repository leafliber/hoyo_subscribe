// 字段加密（认证加密，任务卡 P1-06 交付物二；主方案 §8.3）。
//
// 合同要点："认证加密使用唯一 nonce 和记录类型/ID 的认证数据"。
// - 算法 AES-256-GCM（密钥经 HKDF 以 field-encryption 用途派生，keyring.ts）。
// - nonce：每次加密 12 字节强随机。随机 nonce 的唯一性上界为单钥 2^32 次加密
//   （NIST SP 800-38D §8.2.2）；本项目单钥加密量（认证载荷/回执/Feed 密文/地址）远低于
//   该量级，且密钥可随根秘密轮换。**同一明文两次加密产生不同 nonce 与密文**（有测试）。
// - AAD：JSON 数组 [版本, 记录类型, 记录 ID]。记录类型取自 contracts 的
//   CONTROLLED_CIPHERTEXT_STORAGE（受控密文类别即记录类型），**密文跨记录搬运因 AAD
//   不匹配而认证失败**（有测试）。
// - 信封：0x01 版本字节 + 12 字节 nonce + 密文‖16 字节 tag，整体作 BLOB 存
//   （token_ciphertext / receipt_ciphertext 列）。

import type { CiphertextRecordType, FieldEncryptionKey } from "@hoyo/contracts";
import { utf8Decode, utf8Encode } from "./bytes";
import { aeadMaterial } from "./keyring";

/** 信封版本字节（当前 0x01）。 */
const ENVELOPE_VERSION = 1;

/** AES-GCM nonce 长度（字节）：96 位是硬件加速与安全性的标准取舍。 */
const NONCE_BYTES = 12;

/** GCM tag 长度（字节）。 */
const TAG_BYTES = 16;

/** 解密失败原因；不区分"密文损坏"与"密钥不符"以外的细节，避免成为探测面。 */
export type FieldCryptoFailure = "bad-envelope" | "bad-version" | "auth-failed";

export class FieldCryptoError extends Error {
  constructor(
    readonly reason: FieldCryptoFailure,
    detail: string,
  ) {
    super(`字段加密失败（${reason}）：${detail}`);
    this.name = "FieldCryptoError";
  }
}

/** 一条受控密文记录的定位：类型（受控密文类别）+ 记录 ID（如 challenge_id / feed namespace）。 */
export interface EncryptedRecordRef {
  readonly type: CiphertextRecordType;
  readonly id: string;
}

function aadBytes(record: EncryptedRecordRef): Uint8Array {
  return utf8Encode(JSON.stringify([ENVELOPE_VERSION, record.type, record.id]));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * 加密一条受控密文（§8.3）。plaintext 为字节或 UTF-8 字符串；
 * 返回信封字节（BLOB 列直接可存）。同一输入两次调用产生不同信封（随机 nonce）。
 */
export async function encryptField(
  key: FieldEncryptionKey,
  record: EncryptedRecordRef,
  plaintext: Uint8Array | string,
): Promise<Uint8Array> {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plain = typeof plaintext === "string" ? utf8Encode(plaintext) : plaintext;
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aadBytes(record)),
      tagLength: TAG_BYTES * 8,
    },
    aeadMaterial(key),
    toArrayBuffer(plain),
  );
  const envelope = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(nonce, 1);
  envelope.set(new Uint8Array(sealed), 1 + NONCE_BYTES);
  return envelope;
}

/**
 * 解密一条受控密文（§8.3）。信封形状非法 / 版本不认识 / 认证失败（含跨记录搬运、
 * 密文或 AAD 被改动）抛 FieldCryptoError。
 */
export async function decryptField(
  key: FieldEncryptionKey,
  record: EncryptedRecordRef,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new FieldCryptoError("bad-envelope", `信封过短：${envelope.length} 字节`);
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new FieldCryptoError("bad-version", `信封版本 ${envelope[0]} 不被支持`);
  }
  const nonce = envelope.slice(1, 1 + NONCE_BYTES);
  const sealed = envelope.slice(1 + NONCE_BYTES);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(aadBytes(record)),
        tagLength: TAG_BYTES * 8,
      },
      aeadMaterial(key),
      toArrayBuffer(sealed),
    );
    return new Uint8Array(plain);
  } catch {
    throw new FieldCryptoError("auth-failed", "认证失败：密文/AAD/密钥不匹配或被改动");
  }
}

/** decryptField 的字符串便捷形态（UTF-8 明文）。 */
export async function decryptFieldText(
  key: FieldEncryptionKey,
  record: EncryptedRecordRef,
  envelope: Uint8Array,
): Promise<string> {
  return utf8Decode(await decryptField(key, record, envelope));
}

/** 从信封中读出 nonce（测试与运维核对用；nonce 不是秘密）。 */
export function envelopeNonce(envelope: Uint8Array): Uint8Array {
  if (envelope.length < 1 + NONCE_BYTES) {
    throw new FieldCryptoError("bad-envelope", "信封过短，无 nonce 段");
  }
  return envelope.slice(1, 1 + NONCE_BYTES);
}
