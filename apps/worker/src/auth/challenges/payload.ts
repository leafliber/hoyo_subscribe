// 验证码发信载荷的短期受控密文（任务卡 P2-02；主方案 §4.3、§8.3、A.5）。
//
// ★ 合同表述纪律：验证码原值**只存在于短期加密发信载荷中**；服务器在发送阶段**能解密**
// 该载荷——这是「短期受控密文」（otp-mail-payload 类别），不是「不可读取」。代码注释、
// 文档与报告一律不得写「不可读取 / 服务器无法知道验证码」。接受、消费、过期或终止后
// 清除（本模块提供清除原语；到期兜底清理由清理任务调用，见 clearExpiredOtpPayloads）。
//
// 载荷内容：challenge_id、generation、验证码原值、实际投递地址。发送阶段（P4）以
// decryptOtpPayload 解出后渲染邮件。AAD 记录 = [v, "otp-mail-payload", outbox 行 id]，
// 密文跨行搬运认证失败（P1-06 aead）。

import type { CiphertextRecordType, FieldEncryptionKey } from "@hoyo/contracts";
import { decryptFieldText, encryptField } from "../../storage/crypto/aead";

/** mail_outbox.payload_kind 的取值：受控密文类别 id 即种类标记（单一来源）。 */
export const OTP_PAYLOAD_KIND: CiphertextRecordType = "otp-mail-payload";

/**
 * D1 BLOB 列读回归一化：workerd 把 BLOB 返回为 ArrayBuffer，而加解密接口收
 * Uint8Array——统一在此转换（两种形态都接受，返回视图不复制底层数据时安全）。
 */
export function asEnvelopeBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** 载荷明文形状（发送阶段渲染所需的最小字段）。 */
export interface OtpMailPayload {
  readonly challengeId: string;
  readonly generation: number;
  readonly code: string;
  readonly address: string;
}

/** 加密一条验证码载荷（记录 ID = 承载它的 mail_outbox 行 id）。 */
export async function encryptOtpPayload(
  key: FieldEncryptionKey,
  outboxId: string,
  payload: OtpMailPayload,
): Promise<Uint8Array> {
  return encryptField(key, { type: OTP_PAYLOAD_KIND, id: outboxId }, JSON.stringify(payload));
}

/**
 * 解密一条验证码载荷（发送阶段使用；服务器可解密——短期受控密文，非不可读取）。
 * 信封损坏 / 跨行搬运 / 密钥不符抛 FieldCryptoError，由调用方决定失败关闭。
 */
export async function decryptOtpPayload(
  key: FieldEncryptionKey,
  outboxId: string,
  envelope: Uint8Array,
): Promise<OtpMailPayload> {
  const text = await decryptFieldText(key, { type: OTP_PAYLOAD_KIND, id: outboxId }, envelope);
  const parsed = JSON.parse(text) as Partial<OtpMailPayload>;
  if (
    typeof parsed.challengeId !== "string" ||
    typeof parsed.generation !== "number" ||
    typeof parsed.code !== "string" ||
    typeof parsed.address !== "string"
  ) {
    throw new Error("验证码载荷字段不完整（内部一致性错误）");
  }
  return {
    challengeId: parsed.challengeId,
    generation: parsed.generation,
    code: parsed.code,
    address: parsed.address,
  };
}
