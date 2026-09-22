// `__Host-preauth` 预认证 Cookie（任务卡 P2-01 交付物一；主方案 §4.3 前半）。
//
// 合同约束（§4.3 第一段 + 任务卡交付物一）：
// - 首次同源 POST 生成 `__Host-preauth`：Secure、HttpOnly、SameSite=Lax、Path=/、
//   **不设置 Domain**（__Host- 前缀本身就要求这三条，序列化仍逐条写出以便测试钉住）。
// - Cookie 携带**服务端认证的签发/截止信息**：值 = `<preauth_id>.<issued_ms>.<expires_ms>.<MAC>`，
//   MAC 覆盖三元组。MAC 用 P1-06 的 computePurposeMac / verifyPurposeMac（CsrfKey 句柄 +
//   独立域标签 "preauth:v1"），不自拼 HMAC。
// - 不同标签页复用同一个未失效随机值（§4.3）：验证通过且未过期的 Cookie 不换新随机值；
//   preauth_id 是稳定身份，CSRF 与挑战都绑它。续期（同值延截止）属 P2-02 挑战创建。
//
// 密钥用途说明：contracts/crypto-types 的八个用途清单没有单独的 preauth 槽；CsrfKey 的
// 注释（purposes.ts）写明它覆盖「预认证/正式会话的 CSRF 绑定 MAC」——预认证 Cookie 的
// 签发/截止认证与 CSRF 绑定同属预认证安全面，这里以独立域标签 "preauth:v1" 复用该句柄，
// 域分隔保证密码学上不与 "csrf:v1" 混用。此推断列入交付报告待确认项。

import { type CsrfKey, PREAUTH_MIN_TTL, SECRET_BITS } from "@hoyo/contracts";
import { computePurposeMac, verifyPurposeMac } from "../../storage/crypto/mac";
import { generateSecretToken } from "../../storage/crypto/random";

/** 预认证 Cookie 名（§4.3）。__Host- 前缀：仅 HTTPS、无 Domain、Path=/。 */
export const PREAUTH_COOKIE_NAME = "__Host-preauth";

/** preauth Cookie MAC 的域分隔标签（与 "csrf:v1" 不同域，签发与验证固定一致）。 */
export const PREAUTH_COOKIE_MAC_DOMAIN = "preauth:v1";

/** 秒转毫秒（本模块内 PREAUTH_MIN_TTL 的单位换算，不引入第二份常量）。 */
const MS_PER_SECOND = 1_000;

/** 已认证的预认证上下文（由验证方重建；不信任 Cookie 内任何未认证字段）。 */
export interface PreauthContext {
  readonly preauthId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** 预认证 Cookie 验证失败的闭合原因（进入 unauthorized.no_session，§7.2 前端映射为重新建立流程）。 */
export type PreauthCookieFailure = "missing" | "malformed" | "bad_mac" | "expired";

export type PreauthCookieResult =
  | { readonly ok: true; readonly context: PreauthContext }
  | { readonly ok: false; readonly reason: PreauthCookieFailure };

/** 初始签发的有效期：PREAUTH_MIN_TTL（A.5 等式已保证下限本身覆盖完成交付余量）。 */
export function initialPreauthExpiry(now: number): number {
  return now + PREAUTH_MIN_TTL * MS_PER_SECOND;
}

function cookieMaterial(preauthId: string, issuedAt: number, expiresAt: number): string {
  return `${preauthId}\n${issuedAt}\n${expiresAt}`;
}

/** 签发新的预认证 Cookie 值（随机值达 SECRET_BITS；MAC 认证签发/截止）。 */
export async function mintPreauthCookieValue(
  key: CsrfKey,
  now: number,
): Promise<{ value: string; context: PreauthContext }> {
  const preauthId = generateSecretToken().base64url;
  const issuedAt = now;
  const expiresAt = initialPreauthExpiry(now);
  const mac = await computePurposeMac(
    key,
    PREAUTH_COOKIE_MAC_DOMAIN,
    cookieMaterial(preauthId, issuedAt, expiresAt),
  );
  return {
    value: `${preauthId}.${issuedAt}.${expiresAt}.${mac}`,
    context: { preauthId, issuedAt, expiresAt },
  };
}

/**
 * 验证预认证 Cookie 值：结构 → MAC → 截止。MAC 成立后才判定过期，
 * 避免对未认证数据形成过期时间侧信道。
 */
export async function verifyPreauthCookieValue(
  key: CsrfKey,
  value: string,
  now: number,
): Promise<PreauthCookieResult> {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return { ok: false, reason: "malformed" };
  }
  const [preauthId, issuedText, expiresText, mac] = parts;
  const issuedAt = Number(issuedText);
  const expiresAt = Number(expiresText);
  if (
    preauthId.length < PREAUTH_ID_MIN_LENGTH ||
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= issuedAt
  ) {
    return { ok: false, reason: "malformed" };
  }
  const macOk = await verifyPurposeMac(
    key,
    PREAUTH_COOKIE_MAC_DOMAIN,
    cookieMaterial(preauthId, issuedAt, expiresAt),
    mac,
  );
  if (!macOk) {
    return { ok: false, reason: "bad_mac" };
  }
  if (now >= expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, context: { preauthId, issuedAt, expiresAt } };
}

/**
 * 序列化 Set-Cookie（__Host-preauth）：五个安全属性逐条写出、无 Domain；
 * Max-Age 与服务端认证的截止一致（HttpOnly 值本身携带截止，Max-Age 只是浏览器侧同步）。
 */
export function serializePreauthSetCookie(value: string, maxAgeSeconds: number): string {
  return `${PREAUTH_COOKIE_NAME}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** preauth_id 的熵下限（SECRET_BITS/8 字节的 base64url 长度；验证时拒绝短随机段）。 */
export const PREAUTH_ID_MIN_LENGTH = Math.ceil((SECRET_BITS / 8) * (4 / 3));
