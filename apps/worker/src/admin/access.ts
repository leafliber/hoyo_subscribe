// P3-10：只信任已配置团队公钥验证的 RS256 应用 JWT，不读取 Email 身份头。
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
import { API_BODY_MAX_BYTES, EXECUTOR_BATCH_WALL_LIMIT, PUBLIC_READ_LIMITS } from "@hoyo/contracts";
import { hashSessionToken } from "../auth/consume/session";
import { fromBase64Url, utf8Decode, utf8Encode } from "../storage/crypto/bytes";
import type { AdminConfiguration } from "./types";

function decodeObject(encoded: string): Record<string, unknown> | null {
  const bytes = fromBase64Url(encoded);
  if (bytes === null) return null;
  const value: unknown = JSON.parse(utf8Decode(bytes));
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function verifyAccess(
  request: Request,
  config: AdminConfiguration,
  now: number,
  fetchKeys: typeof fetch = fetch,
): Promise<{ adminId: string; expiresAt: number } | null> {
  const issuer = config.ADMIN_ACCESS_ISSUER;
  const audience = config.ADMIN_ACCESS_AUD;
  if (!issuer || !audience) return null;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > API_BODY_MAX_BYTES) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeObject(parts[0]);
    const claims = decodeObject(parts[1]);
    const signature = fromBase64Url(parts[2]);
    if (
      !header ||
      !claims ||
      !signature ||
      header.alg !== "RS256" ||
      typeof header.kid !== "string"
    )
      return null;
    // 不支持 JWT critical extensions；不允许令牌控制公钥地址。
    if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined)
      return null;
    if (
      claims.iss !== issuer ||
      !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience))) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1_000 <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf * 1_000 > now)) ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      claims.type !== "app"
    )
      return null;
    const response = await fetchKeys(`${issuer}/cdn-cgi/access/certs`, {
      redirect: "error",
      signal: AbortSignal.timeout(EXECUTOR_BATCH_WALL_LIMIT * 1_000),
    });
    if (!response.ok || response.body === null) return null;
    // 公钥响应含证书链，复用公共响应保护上界；令牌本身仍使用较小的 API_BODY_MAX_BYTES。
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > PUBLIC_READ_LIMITS.responseBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const jwks = JSON.parse(utf8Decode(bytes)) as { keys?: (JsonWebKey & { kid?: string })[] };
    if (!Array.isArray(jwks.keys)) return null;
    const matches = jwks.keys.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    if (matches.length !== 1) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      matches[0],
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        utf8Encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      return null;
    return {
      adminId: `access:${await hashSessionToken(JSON.stringify([issuer, claims.sub]))}`,
      expiresAt: claims.exp * 1_000,
    };
  } catch {
    return null;
  }
}
