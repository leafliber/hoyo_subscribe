import { ADMIN_SESSION_TTL, SECRET_BITS } from "@hoyo/contracts";
import { hashSessionToken } from "../auth/consume/session";
import { sessionAuthenticator } from "../auth/sessions/authenticator";
import { parseCookieHeader } from "../shell/csrf";
import { ADMIN_SESSION_COOKIE_NAME, type Authenticator, type ShellAuth } from "../shell/domains";
import { fromBase64Url, fromHex } from "../storage/crypto/bytes";
import type { Keyring } from "../storage/crypto/keyring";
import { computePurposeMac, verifyPurposeMac } from "../storage/crypto/mac";
import { generateSecretToken } from "../storage/crypto/random";
import { auditStatement } from "./audit";

const SESSION_DOMAIN = "admin-session:v1";
const BOOTSTRAP_DOMAIN = "admin-bootstrap:v1";

export async function verifyBootstrap(
  keys: Keyring,
  configured: string | undefined,
  submitted: string,
): Promise<boolean> {
  // hex 只是编码检查；强度由所有者以 CSPRNG 生成 SECRET_BITS 位保证。
  if (
    configured === undefined ||
    configured.length !== SECRET_BITS / 4 ||
    fromHex(configured) === null
  )
    return false;
  const expected = await computePurposeMac(keys.admin(), BOOTSTRAP_DOMAIN, configured);
  return verifyPurposeMac(keys.admin(), BOOTSTRAP_DOMAIN, submitted, expected);
}

export async function issueAdminSession(
  db: D1Database,
  keys: Keyring,
  adminId: string,
  reason: string,
  now: number,
  accessExpiresAt = Number.POSITIVE_INFINITY,
): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
  const random = generateSecretToken().base64url;
  const token = `${random}.${await computePurposeMac(keys.admin(), SESSION_DOMAIN, random)}`;
  const tokenHash = await hashSessionToken(token);
  const id = crypto.randomUUID();
  const expiresAt = Math.min(now + ADMIN_SESSION_TTL * 1_000, accessExpiresAt);
  await db.batch([
    db
      .prepare(`INSERT INTO admin_sessions
      (id, token_hash, admin_id, issued_at, expires_at, revoked_at, last_used_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .bind(id, tokenHash, adminId, now, expiresAt, now),
    auditStatement(db, {
      actorId: adminId,
      action: "session_issue",
      targetType: "admin_session",
      targetId: id,
      reason,
      createdAt: now,
    }),
  ]);
  return { token, tokenHash, expiresAt };
}

export function adminAuthenticator(
  db: D1Database,
  keys: () => Promise<Keyring>,
  now: () => number = Date.now,
): Authenticator {
  return {
    async authenticate(request, routeDomain): Promise<ShellAuth> {
      if (routeDomain !== "admin") return { kind: "none" };
      const token = parseCookieHeader(request.headers.get("cookie"), ADMIN_SESSION_COOKIE_NAME);
      if (token === undefined) return { kind: "none" };
      const parts = token.split(".");
      if (
        parts.length !== 2 ||
        fromBase64Url(parts[0])?.byteLength !== SECRET_BITS / 8 ||
        !(await verifyPurposeMac((await keys()).admin(), SESSION_DOMAIN, parts[0], parts[1]))
      )
        return { kind: "none" };
      const tokenHash = await hashSessionToken(token);
      const row = await db
        .prepare(`SELECT id, admin_id FROM admin_sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
        .bind(tokenHash, now())
        .first<{ id: string; admin_id: string }>();
      if (row === null) return { kind: "none" };
      return {
        kind: "session",
        domain: "admin",
        adminId: row.admin_id,
        sessionId: row.id,
        sessionTokenHash: tokenHash,
      };
    },
  };
}

/** 先解析目标域；另一域只用于 wrong_domain 错误，绝不提升或降级身份。 */
export function combinedAuthenticator(
  db: D1Database,
  keys: () => Promise<Keyring>,
  now: () => number = Date.now,
): Authenticator {
  const admin = adminAuthenticator(db, keys, now);
  const user = sessionAuthenticator(db, now);
  return {
    async authenticate(request, domain) {
      if (domain !== "admin" && domain !== "user") return { kind: "none" };
      const primary = domain === "admin" ? admin : user;
      const identity = await primary.authenticate(request, domain);
      if (identity.kind !== "none") return identity;
      return domain === "admin"
        ? user.authenticate(request, "user")
        : admin.authenticate(request, "admin");
    },
  };
}
