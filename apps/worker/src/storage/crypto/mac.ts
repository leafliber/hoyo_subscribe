// HMAC-SHA-256 用途操作（任务卡 P1-06；主方案 §4.1、§4.3、§8.3）。
//
// 每个操作的签名只收**自己用途**的品牌句柄——拿 OTP 密钥调这里的其他函数是编译错误
// （purpose-isolation.types.ts）。消息构造全部带域分隔标签并按定长结构编码，
// 字段间无拼接歧义。

import type {
  AdminKey,
  CsrfKey,
  EmailLookupKey,
  OtpMacKey,
  RecoveryEpochKey,
  VapidKey,
} from "@hoyo/contracts";
import { OTP_DIGITS } from "@hoyo/contracts";
import { fromBase64Url, fromHex, toBase64Url, toHex, utf8Encode } from "./bytes";
import { macMaterial } from "./keyring";

/**
 * §4.3 验证码 MAC 的绑定字段：用途、challenge_id、email_key、地址版本、generation、验证码。
 * purpose 的精确取值属 P2-02（migration 0005：登录 / 新注册 / 换邮箱 / 恢复登录）。
 */
export interface OtpMacBinding {
  readonly purpose: string;
  readonly challengeId: string;
  readonly emailKey: string;
  readonly addressVersion: number;
  readonly generation: number;
  readonly code: string;
}

/** §4.3 验证表只存这个 MAC（HASH_ONLY_SECRET_STORAGE 的 otp-verification-mac 类别）。 */
const OTP_MAC_LABEL = "otp-verification-mac:v1";

function otpMacMessage(binding: OtpMacBinding): Uint8Array {
  return utf8Encode(
    JSON.stringify([
      OTP_MAC_LABEL,
      binding.purpose,
      binding.challengeId,
      binding.emailKey,
      binding.addressVersion,
      binding.generation,
      binding.code,
    ]),
  );
}

/** 校验绑定里的验证码形状：OTP_DIGITS 位纯数字（注册表参数，不写字面量）。 */
function requireOtpCodeShape(code: string): void {
  const shape = new RegExp(`^\\d{${OTP_DIGITS}}$`);
  if (!shape.test(code)) {
    throw new Error(`验证码形状非法：须为 ${OTP_DIGITS} 位数字（OTP_DIGITS）`);
  }
}

// WebCrypto 类型收 ArrayBuffer 背景；消息与 MAC 都是小对象，统一小复制。
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function hmacSign(handle: object, message: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign("HMAC", macMaterial(handle), toArrayBuffer(message));
  return new Uint8Array(signature);
}

async function hmacVerify(handle: object, message: Uint8Array, mac: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    macMaterial(handle),
    toArrayBuffer(mac),
    toArrayBuffer(message),
  );
}

/**
 * 计算验证码 MAC（§4.3）：带独立 pepper，绑定六元组。
 * 返回 hex（auth_challenges.mac 列，TEXT）。
 */
export async function macOtpVerification(key: OtpMacKey, binding: OtpMacBinding): Promise<string> {
  requireOtpCodeShape(binding.code);
  return toHex(await hmacSign(key, otpMacMessage(binding)));
}

/** 验证验证码 MAC（§4.3）：MAC 格式非法或不匹配返回 false，不抛错。 */
export async function verifyOtpMac(
  key: OtpMacKey,
  binding: OtpMacBinding,
  macHex: string,
): Promise<boolean> {
  requireOtpCodeShape(binding.code);
  const mac = fromHex(macHex);
  if (!mac) {
    return false;
  }
  return hmacVerify(key, otpMacMessage(binding), mac);
}

/**
 * §4.1：email_key = HMAC(lookup_key, canonical_email)。
 * 入参必须是 canonicalizeEmail（contracts）的产物——本函数不复判规范化，
 * 以免出现第二份规范化实现。返回 hex（64 字符，users.email_key 列）。
 */
export async function computeEmailKey(
  key: EmailLookupKey,
  canonicalEmail: string,
): Promise<string> {
  return toHex(await hmacSign(key, utf8Encode(canonicalEmail)));
}

/** CSRF / VAPID / 管理员 / 恢复 epoch 四个用途共用的键控 MAC（§8.3）。 */
export type GeneralMacKey = CsrfKey | VapidKey | AdminKey | RecoveryEpochKey;

/** 通用用途 MAC 的消息构造：域标签长度前缀 + 数据，字符串路径以换行分隔。 */
function generalMacMessage(domain: string, data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return utf8Encode(`${domain}\n${data}`);
  }
  const label = utf8Encode(domain);
  const out = new Uint8Array(4 + label.length + data.length);
  new DataView(out.buffer).setUint32(0, label.length);
  out.set(label, 4);
  out.set(data, 4 + label.length);
  return out;
}

/**
 * 通用用途 MAC：调用方以 domain 做子域分隔（如 "csrf:v1"、"recovery-epoch:v1"），
 * domain 属于调用方的合同，须固定并与其验证方一致。返回 base64url。
 * 绑定语义（绑定哪个会话、哪个目标摘要）属 P1-08/P2，本函数只提供键控原语。
 */
export async function computePurposeMac(
  key: GeneralMacKey,
  domain: string,
  data: Uint8Array | string,
): Promise<string> {
  return toBase64Url(await hmacSign(key, generalMacMessage(domain, data)));
}

/** 验证通用用途 MAC（见 computePurposeMac）：格式非法或不匹配返回 false。 */
export async function verifyPurposeMac(
  key: GeneralMacKey,
  domain: string,
  data: Uint8Array | string,
  macBase64Url: string,
): Promise<boolean> {
  const mac = fromBase64Url(macBase64Url);
  if (!mac) {
    return false;
  }
  return hmacVerify(key, generalMacMessage(domain, data), mac);
}
