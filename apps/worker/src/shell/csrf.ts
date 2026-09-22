// CSRF 双提交 + MAC 绑定（任务卡 P1-08 交付物三；主方案 §8.2、§8.3；P1-06 预留的
// CsrfKey 用途在此落地绑定语义）。
//
// 机制：Cookie 与请求头各携带同一值，值 = `<base64url(random)>.<MAC>`；
// MAC = purposeMac(csrf 密钥, "csrf:v1", `<random>.<bindingContext>`)，
// 把 token 绑定到持有人身份上下文（预认证阶段绑 preauth、会话阶段绑会话 token 的
// 散列——具体绑定值由 P2 路由提供，本模块只定义机制与信息流）。
// 验证三步全部通过才算 ok：双提交**常数时间**相等；随机段长度达标（SECRET_BITS）；
// MAC 对绑定上下文成立。缺 Cookie/头、值不等、MAC 不符分别是闭合枚举里的
// csrf_missing / csrf_mismatch，进入 unauthorized details（contracts）。
import { type CsrfKey, SECRET_BITS } from "@hoyo/contracts";
import { constantTimeEqual, fromBase64Url, toBase64Url, utf8Encode } from "../storage/crypto/bytes";
import { computePurposeMac, verifyPurposeMac } from "../storage/crypto/mac";

/** CSRF MAC 的域分隔标签（与验证方固定一致；P1-06 computePurposeMac 的 domain 约定）。 */
export const CSRF_DOMAIN = "csrf:v1";

/** 双提交 Cookie 名。__Host- 前缀：仅 HTTPS、无 Domain、Path=/。 */
export const CSRF_COOKIE_NAME = "__Host-hoyo_csrf";

/** 双提交请求头名。 */
export const CSRF_HEADER_NAME = "x-csrf-token";

export type CsrfCheckResult = "ok" | "csrf_missing" | "csrf_mismatch";

function bindingMaterial(randomPart: string, bindingContext: string): string {
  return `${randomPart}\n${bindingContext}`;
}

/**
 * 签发 CSRF token（供 P2 预认证/会话建立时使用，测试直接调用）。
 * random 必须达 SECRET_BITS 强度；返回值同时写 Cookie 与由页面回读放头。
 */
export async function mintCsrfToken(
  key: CsrfKey,
  bindingContext: string,
  random: Uint8Array,
): Promise<string> {
  if (random.byteLength * 8 < SECRET_BITS) {
    throw new Error(`CSRF 随机段强度不足：需要 SECRET_BITS(${SECRET_BITS}) 位`);
  }
  const randomPart = toBase64Url(random);
  const mac = await computePurposeMac(
    key,
    CSRF_DOMAIN,
    bindingMaterial(randomPart, bindingContext),
  );
  return `${randomPart}.${mac}`;
}

/** 从 Cookie 头解析指定名字的值（简单 split；本站 Cookie 值不含分号/等号歧义字符）。 */
export function parseCookieHeader(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** 验证请求的 CSRF 双提交：Cookie 与头都存在、常数时间相等、MAC 绑定成立。 */
export async function verifyCsrf(
  key: CsrfKey,
  request: Request,
  bindingContext: string,
): Promise<CsrfCheckResult> {
  const cookieValue = parseCookieHeader(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  const headerValue = request.headers.get(CSRF_HEADER_NAME);
  if (cookieValue === undefined || headerValue === null || headerValue.length === 0) {
    return "csrf_missing";
  }
  if (!constantTimeEqual(utf8Encode(cookieValue), utf8Encode(headerValue))) {
    return "csrf_mismatch";
  }
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) {
    return "csrf_mismatch";
  }
  const randomPart = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const randomBytes = fromBase64Url(randomPart);
  if (randomBytes === null || randomBytes.byteLength * 8 < SECRET_BITS) {
    return "csrf_mismatch";
  }
  const macOk = await verifyPurposeMac(
    key,
    CSRF_DOMAIN,
    bindingMaterial(randomPart, bindingContext),
    mac,
  );
  return macOk ? "ok" : "csrf_mismatch";
}
