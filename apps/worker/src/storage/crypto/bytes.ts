// 字节与文本编码工具（任务卡 P1-06）。
// 加密原语内部使用；hex 用于 D1 TEXT 列（email_key、OTP MAC），
// base64url（无填充）用于 URL 安全场景（退订 token、随机秘密的字符串形态）。

const HEX = "0123456789abcdef";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX.indexOf(hex[2 * i]);
    const lo = HEX.indexOf(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) {
      return null;
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)] : "";
    out += i + 2 < bytes.length ? B64URL[b2 & 0x3f] : "";
  }
  return out;
}

export function fromBase64Url(value: string): Uint8Array | null {
  if (value.includes("=") || !/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }
  const charCount = value.length;
  const byteCount = Math.floor((charCount * 3) / 4);
  const out = new Uint8Array(byteCount);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of value) {
    const v = B64URL.indexOf(char);
    if (v < 0) {
      return null;
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (index < byteCount) {
        out[index++] = (buffer >> bits) & 0xff;
      }
    }
  }
  // 无填充 base64url 的尾随位应全零（规范编码）；非零说明输入不是规范形态。
  if (buffer & ((1 << bits) - 1)) {
    return null;
  }
  return out;
}

/** 常数时间字节比较：长度不同直接 false（长度不是秘密——MAC/密文长度公开）。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
