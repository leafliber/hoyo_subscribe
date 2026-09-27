// P2-03 · 创建 pending Session 所需值（主方案 §4.4–§4.5、附录 A.2）。
// 只存 token 的 SHA-256 hash；唯一可恢复明文是挑战行里的短期加密回执。
// 绝对期限在创建时从注册表中心值 ± 抖动毫秒范围均匀抽取，触发器禁止改写。

import {
  SESSION_ABSOLUTE_JITTER,
  SESSION_ABSOLUTE_TTL,
  SESSION_IDLE_TTL,
  SESSION_PENDING_TTL,
} from "@hoyo/contracts";
import { toHex, utf8Encode } from "../../storage/crypto/bytes";
import { generateSecretToken, uniformIntegerInclusive } from "../../storage/crypto/random";

const MS_PER_SECOND = 1_000;
export const SESSION_COOKIE_NAME = "__Host-session";

export interface PendingSessionValues {
  readonly id: string;
  readonly tokenHash: string;
  readonly cookieValue: string;
  readonly label: string;
  readonly platformHint: "unknown";
  readonly issuedAt: number;
  readonly absoluteExpiresAt: number;
  readonly expiresAt: number;
}

export async function makePendingSession(now: number): Promise<PendingSessionValues> {
  const token = generateSecretToken();
  const hash = await crypto.subtle.digest("SHA-256", utf8Encode(token.base64url));
  const jitterMs = SESSION_ABSOLUTE_JITTER * MS_PER_SECOND;
  const offset = uniformIntegerInclusive(-jitterMs, jitterMs);
  const absoluteExpiresAt = now + SESSION_ABSOLUTE_TTL * MS_PER_SECOND + offset;
  return {
    id: crypto.randomUUID(),
    tokenHash: toHex(new Uint8Array(hash)),
    cookieValue: token.base64url,
    label: `${new Date(now).toISOString()} · unknown`,
    platformHint: "unknown",
    issuedAt: now,
    absoluteExpiresAt,
    expiresAt: Math.min(now + SESSION_PENDING_TTL * MS_PER_SECOND, absoluteExpiresAt),
  };
}

/** 激活后仍由数据库状态与期限鉴权；浏览器 Cookie 可以活到不活跃期限。 */
export function serializePendingSessionCookie(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_IDLE_TTL}`;
}
