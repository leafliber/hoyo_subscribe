// 验证码的实际投递地址解析（任务卡 P2-02；主方案 §4.1 全段）。
//
// ★ 安全要害（§4.1 原文）：已有身份再次请求登录时，验证码只发到数据库中**已验证的实际
// 投递地址**，不按请求中不同大小写的地址改投——极少数邮箱服务商的本地部分确实大小写
// 敏感，按请求地址投递会把验证码发给另一个人。身份键（canonicalizeEmail）折叠大小写，
// 投递地址不折叠。
//
// 因此投递串有两个来源，按用途固定：
// - login：解密 users.email_ciphertext（受控密文 delivery-email-address；AAD 记录 ID
//   采用 users.id——P2-03 建号写入时须用同一约定加密，本文件是读取侧的定义点）。
// - signup：请求原文的投递形态（去两端空白、域名小写去尾点、**本地部分保留原大小写**）。
//   首版 ASCII（canonicalizeEmail 已在准入侧拒绝非 ASCII，此处不再复判）。
//
// 投递形态派生是服务端新逻辑：contracts 的 canonicalizeEmail 只产身份键（折叠大小写），
// 不存在可复用的投递形态函数；本函数不与任何既有合同函数重复（报告「已知问题」登记
// 上移 contracts 的建议）。

import type { FieldEncryptionKey } from "@hoyo/contracts";
import { decryptFieldText } from "../../storage/crypto/aead";

/** 受控密文类别（contracts 唯一登记表）中「已验证实际投递地址」的记录类型。 */
const DELIVERY_ADDRESS_RECORD_TYPE = "delivery-email-address" as const;

/**
 * 请求原文 → 投递形态：去两端空白，域名小写并去尾点；本地部分原样保留（含大小写）。
 * 与 canonicalizeEmail 共享「按最后一个 @ 切分、域名规范化」的语义；形状合法性已在
 * 准入侧由 canonicalizeEmail 判过（调用方保证两者来自同一输入），本函数不抛错。
 */
export function deliveryAddressForm(rawEmail: string): string {
  const trimmed = rawEmail.trim();
  const atIndex = trimmed.lastIndexOf("@");
  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed
    .slice(atIndex + 1)
    .replace(/\.$/, "")
    .toLowerCase();
  return `${localPart}@${domain}`;
}

/**
 * 解出已有身份的已验证投递地址（§4.1：唯一投递来源，不看请求串）。
 * 密文解不开（密钥轮换事故 / 数据损坏）抛 FieldCryptoError → 路由折叠 503，失败关闭，
 * 绝不回退到请求地址改投。
 */
export async function decryptDeliveryAddress(
  key: FieldEncryptionKey,
  userId: string,
  ciphertext: Uint8Array,
): Promise<string> {
  return decryptFieldText(key, { type: DELIVERY_ADDRESS_RECORD_TYPE, id: userId }, ciphertext);
}

export { DELIVERY_ADDRESS_RECORD_TYPE };
