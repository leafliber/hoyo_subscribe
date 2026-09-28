// P2-04 · 会话鉴权（主方案 §4.5）。每个请求只读 D1 主状态，绝不在鉴权时续期。
// Cookie 的 SHA-256 与 P2-03 makePendingSession 一致；IP/UA 不参与身份判定。

import { parseCookieHeader } from "../../shell/csrf";
import type { Authenticator, ShellAuth } from "../../shell/domains";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { toHex, utf8Encode } from "../../storage/crypto/bytes";

interface SessionIdentityRow {
  id: string;
  user_id: string;
  token_hash: string;
  state: string;
  expires_at: number;
  absolute_expires_at: number;
  auth_epoch: number;
  recovery_epoch: number;
  user_status: string;
  user_auth_epoch: number;
  user_recovery_epoch: number;
}

export async function hashSessionCookie(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encode(value));
  return toHex(new Uint8Array(digest));
}

export function sessionAuthenticator(db: D1Database, now: () => number = Date.now): Authenticator {
  return {
    async authenticate(request, routeDomain): Promise<ShellAuth> {
      if (routeDomain !== "user") return { kind: "none" };
      const token = parseCookieHeader(request.headers.get("cookie"), USER_SESSION_COOKIE_NAME);
      if (token === undefined || token.length === 0) return { kind: "none" };
      const tokenHash = await hashSessionCookie(token);
      const checkedAt = now();
      const row = await db
        .prepare(`SELECT s.id, s.user_id, s.token_hash, s.state, s.expires_at,
                         s.absolute_expires_at, s.auth_epoch, s.recovery_epoch,
                         u.status AS user_status, u.auth_epoch AS user_auth_epoch,
                         u.recovery_epoch AS user_recovery_epoch
                    FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ?`)
        .bind(tokenHash)
        .first<SessionIdentityRow>();
      if (
        row === null ||
        (row.state !== "pending" && row.state !== "active") ||
        row.expires_at <= checkedAt ||
        row.absolute_expires_at <= checkedAt ||
        row.user_status !== "active" ||
        row.auth_epoch !== row.user_auth_epoch ||
        row.recovery_epoch !== row.user_recovery_epoch
      ) {
        return { kind: "none" };
      }
      return {
        kind: "session",
        domain: "user",
        userId: row.user_id,
        sessionId: row.id,
        sessionState: row.state,
        sessionTokenHash: row.token_hash,
      };
    },
  };
}
