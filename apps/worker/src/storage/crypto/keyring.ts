// 密钥环：按用途隔离的密钥句柄（任务卡 P1-06 交付物一；主方案 §8.3）。
//
// 结构：
// - 两份根秘密：masterSecret（派生除 OTP MAC 外的七个用途）与 otpPepper（**独立 pepper**，
//   §4.3——OTP 验证 MAC 不与任何其他用途共根，改一个不影响另一个，也禁止配成同一串）。
// - 每用途经 HKDF-SHA-256 以不同 info 派生 256 位子钥（用途隔离的密码学面）：
//   info = "hoyo-crypto:v1:<purpose>"，退订 MAC 再拼 key_id（轮换）。
// - 句柄是**不透明对象**：类型上带 PurposeTag 品牌（contracts/crypto-types/purposes.ts），
//   运行时密钥材料存在模块私有 WeakMap 里，句柄本身不可读出 CryptoKey。
//   用途混用在类型层面不可能——编译错误证明见 purpose-isolation.types.ts。
// - 根秘密长度下限 = SECRET_BITS（注册表，不写字面量）。
//
// 根秘密如何进入环境（Wrangler secret 等）属后续任务卡；本模块只负责从配置构造。

import {
  type AdminKey,
  type CsrfKey,
  type EmailLookupKey,
  type FieldEncryptionKey,
  isValidUnsubscribeKeyId,
  type KeyPurpose,
  type OtpMacKey,
  type RecoveryEpochKey,
  SECRET_BITS,
  type UnsubscribeMacKeys,
  type VapidKey,
} from "@hoyo/contracts";
import { constantTimeEqual, utf8Encode } from "./bytes";

/** HKDF info 前缀：版本化域分隔，跨用途、跨项目不撞车。 */
const HKDF_INFO_PREFIX = "hoyo-crypto:v1";

/** 密钥环配置。masterSecret 与 otpPepper 必须互相独立且各 ≥ SECRET_BITS。 */
export interface KeyringConfig {
  readonly masterSecret: Uint8Array;
  readonly otpPepper: Uint8Array;
  /** 退订 MAC 当前签发 key_id（§7.6：token 明文携带 key_id）。 */
  readonly unsubscribeMacCurrentKeyId: string;
  /** 验证时接受的 key_id 集合（含当前）；默认仅当前。正常轮换保留旧 id，灾难性撤销移出。 */
  readonly unsubscribeMacAcceptedKeyIds?: readonly string[];
}

// 句柄 → 密钥材料的模块私有注册表。句柄对外只是不透明品牌对象。
const macMaterials = new WeakMap<object, CryptoKey>();
const aeadMaterials = new WeakMap<object, CryptoKey>();
const unsubscribeMaterials = new WeakMap<object, UnsubscribeMaterial>();

interface UnsubscribeMaterial {
  readonly currentKeyId: string;
  readonly keysById: ReadonlyMap<string, CryptoKey>;
}

function requireSecretBits(name: string, secret: Uint8Array): void {
  if (secret.byteLength * 8 < SECRET_BITS) {
    throw new Error(
      `${name} 强度不足：${secret.byteLength * 8} 位 < SECRET_BITS(${SECRET_BITS})，拒绝构造密钥环`,
    );
  }
}

async function deriveRaw(master: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", toArrayBuffer(master), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8Encode(info) },
    base,
    SECRET_BITS,
  );
  return new Uint8Array(bits);
}

async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function importAeadKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function purposeInfo(purpose: KeyPurpose): string {
  return `${HKDF_INFO_PREFIX}:${purpose}`;
}

// WebCrypto 接口收 ArrayBufferView 时类型上要求 ArrayBuffer 背景（TS 7 严格化），
// 统一复制到独立 ArrayBuffer 再交给 subtle（密钥材料尺寸都很小，复制无感）。
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * 密钥环：八个用途的句柄工厂。异步构造一次，随请求/环境复用；
 * 句柄本身不可变，内部 CryptoKey 均不可导出（extractable=false）。
 */
export class Keyring {
  private constructor() {
    // 句柄经静态 create 构造；字段在 create 中注入。
  }

  /** 从根秘密构造密钥环；任何一项不满足合同约束即抛错（拒绝带病启动）。 */
  static async create(config: KeyringConfig): Promise<Keyring> {
    requireSecretBits("masterSecret", config.masterSecret);
    requireSecretBits("otpPepper", config.otpPepper);
    if (constantTimeEqual(config.masterSecret, config.otpPepper)) {
      throw new Error("otpPepper 必须独立于 masterSecret（§4.3 独立 pepper），不得配置为同一串");
    }

    const ring = new Keyring();

    // OTP MAC：独立 pepper 派生，不走 masterSecret。
    ring.#otpMac = brandHandle();
    macMaterials.set(
      ring.#otpMac,
      await importHmacKey(await deriveRaw(config.otpPepper, purposeInfo("otp-mac"))),
    );

    // masterSecret 派生的其余六 + 1 个用途。
    ring.#emailLookup = brandHandle();
    macMaterials.set(
      ring.#emailLookup,
      await importHmacKey(await deriveRaw(config.masterSecret, purposeInfo("email-lookup"))),
    );

    ring.#fieldEncryption = brandHandle();
    aeadMaterials.set(
      ring.#fieldEncryption,
      await importAeadKey(await deriveRaw(config.masterSecret, purposeInfo("field-encryption"))),
    );

    ring.#csrf = brandHandle();
    macMaterials.set(
      ring.#csrf,
      await importHmacKey(await deriveRaw(config.masterSecret, purposeInfo("csrf"))),
    );

    ring.#vapid = brandHandle();
    macMaterials.set(
      ring.#vapid,
      await importHmacKey(await deriveRaw(config.masterSecret, purposeInfo("vapid"))),
    );

    ring.#admin = brandHandle();
    macMaterials.set(
      ring.#admin,
      await importHmacKey(await deriveRaw(config.masterSecret, purposeInfo("admin"))),
    );

    ring.#recoveryEpoch = brandHandle();
    macMaterials.set(
      ring.#recoveryEpoch,
      await importHmacKey(await deriveRaw(config.masterSecret, purposeInfo("recovery-epoch"))),
    );

    // 退订 MAC：每个 key_id 独立派生（info 拼 key_id）。
    const currentKeyId = config.unsubscribeMacCurrentKeyId;
    if (!isValidUnsubscribeKeyId(currentKeyId)) {
      throw new Error(`退订 MAC 当前 key_id 形状非法：${currentKeyId}`);
    }
    const accepted = config.unsubscribeMacAcceptedKeyIds ?? [currentKeyId];
    if (!accepted.includes(currentKeyId)) {
      throw new Error(
        "unsubscribeMacAcceptedKeyIds 必须包含当前 key_id（否则无法验证自己签发的 token）",
      );
    }
    const seen = new Set<string>();
    const keysById = new Map<string, CryptoKey>();
    for (const keyId of accepted) {
      if (!isValidUnsubscribeKeyId(keyId)) {
        throw new Error(`退订 MAC key_id 形状非法：${keyId}`);
      }
      if (seen.has(keyId)) {
        continue;
      }
      seen.add(keyId);
      keysById.set(
        keyId,
        await importHmacKey(
          await deriveRaw(config.masterSecret, `${purposeInfo("unsubscribe-mac")}:key:${keyId}`),
        ),
      );
    }
    ring.#unsubscribeMac = brandHandle();
    ring.#unsubscribeCurrentKeyId = currentKeyId;
    ring.#unsubscribeAcceptedKeyIds = [...seen];
    unsubscribeMaterials.set(ring.#unsubscribeMac, { currentKeyId, keysById });

    return ring;
  }

  #otpMac!: OtpMacKey;
  #emailLookup!: EmailLookupKey;
  #fieldEncryption!: FieldEncryptionKey;
  #unsubscribeMac!: UnsubscribeMacKeys;
  #csrf!: CsrfKey;
  #vapid!: VapidKey;
  #admin!: AdminKey;
  #recoveryEpoch!: RecoveryEpochKey;
  #unsubscribeCurrentKeyId!: string;
  #unsubscribeAcceptedKeyIds!: readonly string[];

  /** OTP MAC 密钥（独立 pepper，§4.3）。 */
  otpMac(): OtpMacKey {
    return this.#otpMac;
  }

  /** 邮箱 lookup HMAC 密钥（§4.1）。 */
  emailLookup(): EmailLookupKey {
    return this.#emailLookup;
  }

  /** 字段加密密钥（认证加密，§8.3）。 */
  fieldEncryption(): FieldEncryptionKey {
    return this.#fieldEncryption;
  }

  /** 退订 MAC 密钥组（带 key_id 轮换，§7.6）。 */
  unsubscribeMac(): UnsubscribeMacKeys {
    return this.#unsubscribeMac;
  }

  /** CSRF 密钥（§8.3）。 */
  csrf(): CsrfKey {
    return this.#csrf;
  }

  /** VAPID 用途隔离槽（§8.3；协议密钥对属 Push 任务卡）。 */
  vapid(): VapidKey {
    return this.#vapid;
  }

  /** 管理员域密钥（§8.3）。 */
  admin(): AdminKey {
    return this.#admin;
  }

  /** 恢复 epoch 密钥（§4.5、§8.3）。 */
  recoveryEpoch(): RecoveryEpochKey {
    return this.#recoveryEpoch;
  }

  /** 当前退订 MAC 签发 key_id（§7.6：随 token 明文携带）。 */
  get unsubscribeMacCurrentKeyId(): string {
    return this.#unsubscribeCurrentKeyId;
  }

  /** 验证接受的退订 MAC key_id 集合（含当前）。 */
  get unsubscribeMacAcceptedKeyIds(): readonly string[] {
    return this.#unsubscribeAcceptedKeyIds;
  }
}

// —— 模块内共享的材料访问（仅本目录的 mac/aead/unsubscribe 模块 import） ——

/** 造一个不透明品牌句柄：运行时无属性，类型上带 PurposeTag。 */
function brandHandle<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

/** 取 HMAC 密钥材料（仅 mac.ts / unsubscribe.ts 使用）。 */
export function macMaterial(handle: object): CryptoKey {
  const key = macMaterials.get(handle);
  if (!key) {
    throw new Error("句柄不属于本密钥环或用途不是 HMAC 类（内部一致性错误）");
  }
  return key;
}

/** 取 AES-GCM 密钥材料（仅 aead.ts 使用）。 */
export function aeadMaterial(handle: object): CryptoKey {
  const key = aeadMaterials.get(handle);
  if (!key) {
    throw new Error("句柄不属于本密钥环或用途不是字段加密（内部一致性错误）");
  }
  return key;
}

/** 取退订 MAC 材料（仅 unsubscribe.ts 使用）。 */
export function unsubscribeMaterial(handle: object): UnsubscribeMaterial {
  const material = unsubscribeMaterials.get(handle);
  if (!material) {
    throw new Error("句柄不是退订 MAC 密钥组（内部一致性错误）");
  }
  return material;
}
