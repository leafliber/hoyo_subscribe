// 退订 MAC token（任务卡 P1-06 交付物一之「退订 MAC（带 key_id）」；主方案 §7.6）。
//
// 合同要点：
// - token = 版本前缀 + key_id + 高熵 MAC，绑定**不可变 email_binding_id 与 list_scope**；
//   token 中**没有邮箱明文**，也不逐邮件存 token 行（无状态验证）。
// - 同一绑定仍是当前绑定时，旧邮件里的有效 token 关闭**当前**业务邮件（跨重新订阅有效）。
// - 正常密钥轮换保留旧 key_id 验证能力；灾难性撤销把 key_id 移出接受集合后明确失效，
//   不静默成功。
// 端点行为（GET 只展示 / POST 确认 / one-click）属 P4-06；本文件只交付原语。

import type { UnsubscribeMacKeys } from "@hoyo/contracts";
import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { unsubscribeMaterial } from "./keyring";

/** token 版本前缀（§7.6「不再支持的 token 返回明确失效响应」——版本不认识即 unsupported）。 */
const TOKEN_VERSION = "v1";

/** MAC 域分隔标签：绑定不可变 email_binding_id 与 list_scope（§7.6）。 */
const UNSUBSCRIBE_MAC_LABEL = "unsubscribe-mac:v1";

/** 退订绑定（§7.6）：email_binding_id 不可变；list_scope 的精确取值属 P4-06。 */
export interface UnsubscribeBinding {
  readonly emailBindingId: string;
  readonly listScope: string;
}

/** 验证失败原因（P4-06 据此返回明确失效响应，不以成功冒充当前退订）。 */
export type UnsubscribeVerifyFailure =
  | "malformed" // 不是三段 token 形状 / base64url 非法
  | "unsupported-version" // 版本前缀不认识
  | "unknown-key-id" // key_id 不在接受集合（灾难性撤销或过旧）
  | "bad-mac"; // MAC 不匹配（绑定不符或伪造）

export type UnsubscribeVerifyResult =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: UnsubscribeVerifyFailure };

function macMessage(binding: UnsubscribeBinding): Uint8Array {
  return utf8Encode(
    JSON.stringify([UNSUBSCRIBE_MAC_LABEL, binding.emailBindingId, binding.listScope]),
  );
}

// WebCrypto 类型收 ArrayBuffer 背景；统一小复制（同 keyring.ts 说明）。
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * 签发退订 token（§7.6）：以密钥组的**当前 key_id** 签。
 * 输出形态 `<version>.<key_id>.<base64url(MAC)>`——URL 路径段安全。
 */
export async function signUnsubscribeToken(
  keys: UnsubscribeMacKeys,
  binding: UnsubscribeBinding,
): Promise<string> {
  const material = unsubscribeMaterial(keys);
  const key = material.keysById.get(material.currentKeyId);
  if (!key) {
    throw new Error("退订 MAC 当前 key_id 缺少派生密钥（内部一致性错误）");
  }
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(macMessage(binding)));
  return `${TOKEN_VERSION}.${material.currentKeyId}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * 验证退订 token（§7.6）：按 token 携带的 key_id 选钥（每个 key_id 独立 HKDF 派生），
 * 不在集合内明确失效。恒时比较由 WebCrypto verify 保证。
 */
export async function verifyUnsubscribeToken(
  keys: UnsubscribeMacKeys,
  token: string,
  binding: UnsubscribeBinding,
): Promise<UnsubscribeVerifyResult> {
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0].length === 0 ||
    parts[1].length === 0 ||
    parts[2].length === 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  const [version, keyId, macPart] = parts;
  if (version !== TOKEN_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  const mac = fromBase64Url(macPart);
  if (!mac) {
    return { ok: false, reason: "malformed" };
  }
  const material = unsubscribeMaterial(keys);
  const key = material.keysById.get(keyId);
  if (!key) {
    return { ok: false, reason: "unknown-key-id" };
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(mac),
    toArrayBuffer(macMessage(binding)),
  );
  return valid ? { ok: true, keyId } : { ok: false, reason: "bad-mac" };
}
