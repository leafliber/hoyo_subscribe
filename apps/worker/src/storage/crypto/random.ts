// 随机生成器（任务卡 P1-06 交付物四；主方案 §4.3、§4.5、附录 A.2）。
//
// - SECRET_BITS（注册表，256 位）强随机秘密：会话 token、Feed token、恢复码秘密等。
// - 验证码另按 OTP_DIGITS 均匀随机生成：每位数字用**拒绝采样**从随机字节映射，
//   上界 = floor(256/10)*10（运行时推导，不写字面量），拒绝 250–255，
//   使每位在 0–9 上严格均匀——直接 `byte % 10` 会给 0–5 多 1/256 的偏置（有卡方测试防回退）。

import { OTP_DIGITS, SECRET_BITS } from "@hoyo/contracts";
import { toBase64Url } from "./bytes";

/** 一次生成的秘密：字节形态与 URL 安全的 base64url 字符串形态。 */
export interface SecretToken {
  readonly bytes: Uint8Array;
  readonly base64url: string;
}

/** 生成 SECRET_BITS 强度的高熵秘密（§4.5：会话 token 等）。 */
export function generateSecretToken(): SecretToken {
  if (SECRET_BITS % 8 !== 0) {
    throw new Error(`SECRET_BITS(${SECRET_BITS}) 不是 8 的倍数，无法按字节生成`);
  }
  const bytes = new Uint8Array(SECRET_BITS / 8);
  crypto.getRandomValues(bytes);
  return { bytes, base64url: toBase64Url(bytes) };
}

/** 单个均匀十进制数字：拒绝采样消除取模偏置（§4.3「均匀随机生成」）。 */
function uniformDecimalDigit(): number {
  // 256（字节值域）内 10 的最大整数倍；接受 [0, limit) 再取模才是均匀的。
  const limit = Math.floor(256 / 10) * 10;
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) {
      return buffer[0] % 10;
    }
  }
}

/** 生成 OTP_DIGITS 位纯数字验证码（§4.3；均匀性有卡方测试）。 */
export function generateOtpCode(): string {
  let code = "";
  for (let i = 0; i < OTP_DIGITS; i++) {
    code += uniformDecimalDigit().toString();
  }
  return code;
}
