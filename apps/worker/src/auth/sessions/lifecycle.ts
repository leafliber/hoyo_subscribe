// P2-04 · pending→active、明确续期、本人撤销与 pending 超时清理（主方案 §4.5、§9.5）。
// 所有写入是显式操作；鉴权器和设备列表不写 D1。active 名额在单条 CAS 守卫中核对，
// 用户所选撤销与激活、完成回执清密文在同一 D1 batch 中提交。

import {
  API_BODY_MAX_BYTES,
  SESSION_ACTIVE_MAX,
  SESSION_EXPIRY_NOTICE,
  SESSION_IDLE_TTL,
  SESSION_LABEL_SOURCE,
  SESSION_RENEW_INTERVAL,
} from "@hoyo/contracts";
import { conditionalCommit } from "../../storage/cas";
import { activatedReceiptClearEffect } from "../consume/cleanup";

const SECOND = 1_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionView {
  readonly id: string;
  readonly label: string;
  readonly created_at: number;
  readonly renewed_at: number;
  readonly is_current: boolean;
  readonly state: "pending" | "active";
}

interface SessionListRow {
  id: string;
  label: string;
  created_at: number;
  renewed_at: number;
  state: "pending" | "active";
}

interface SessionTimeRow {
  id: string;
  user_id: string;
  state: string;
  created_at: number;
  expires_at: number;
  absolute_expires_at: number;
  renewed_at: number;
}

export async function listSessions(
  db: D1Database,
  userId: string,
  currentId: string,
  now: number,
): Promise<SessionView[]> {
  const rows = await db
    .prepare(`SELECT s.id, s.label, s.created_at, s.renewed_at, s.state
                FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.user_id = ? AND s.state IN ('pending','active')
                 AND s.expires_at > ? AND s.absolute_expires_at > ?
                 AND u.status = 'active'
                 AND s.auth_epoch = u.auth_epoch AND s.recovery_epoch = u.recovery_epoch
               ORDER BY s.created_at DESC, s.id`)
    .bind(userId, now, now)
    .all<SessionListRow>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    created_at: row.created_at,
    renewed_at: row.renewed_at,
    is_current: row.id === currentId,
    state: row.state,
  }));
}

export async function expiryNotice(
  db: D1Database,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT state, expires_at, absolute_expires_at FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ state: string; expires_at: number; absolute_expires_at: number }>();
  return (
    row?.state === "active" &&
    Math.min(row.expires_at, row.absolute_expires_at) - now <= SESSION_EXPIRY_NOTICE * SECOND
  );
}

export function coarsePlatform(userAgent: string | null): "desktop" | "mobile" | "unknown" {
  if (userAgent === null || userAgent.length === 0) return "unknown";
  if (/Mobile|Android|iPad|iPhone|iPod/i.test(userAgent)) return "mobile";
  if (/Windows|Macintosh|Linux|X11/i.test(userAgent)) return "desktop";
  return "unknown";
}

export function sessionLabel(
  createdAt: number,
  platform: ReturnType<typeof coarsePlatform>,
  input?: string,
): string {
  if (
    SESSION_LABEL_SOURCE.source !== "user-provided" ||
    SESSION_LABEL_SOURCE.fallback !== "creation-time+coarse-platform"
  ) {
    throw new Error("SESSION_LABEL_SOURCE 不受支持");
  }
  if (input !== undefined) {
    const trimmed = input.trim();
    if (trimmed.length === 0 || new TextEncoder().encode(trimmed).byteLength > API_BODY_MAX_BYTES) {
      throw new Error("invalid_session_label");
    }
    return trimmed;
  }
  const platformText = { desktop: "桌面", mobile: "移动", unknown: "未知" }[platform];
  return `${new Date(createdAt).toISOString()} · ${platformText}`;
}

/** 传输层用逗号分隔所选会话 ID；全部校验后才进入 CAS。 */
export function parseSelectedSessionIds(input?: string): string[] {
  if (input === undefined || input === "") return [];
  const ids = input.split(",").map((part) => part.trim());
  if (
    ids.length > SESSION_ACTIVE_MAX ||
    ids.some((id) => !SESSION_ID_PATTERN.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("invalid_session_selection");
  }
  return ids;
}

export interface ActivationInput {
  db: D1Database;
  userId: string;
  sessionId: string;
  selectedIds: readonly string[];
  label?: string;
  platform: ReturnType<typeof coarsePlatform>;
  now: number;
  beforeCommit?: () => Promise<void>;
}

export async function activateSession(input: ActivationInput): Promise<"activated" | "conflict"> {
  const pending = await input.db
    .prepare(
      "SELECT id, user_id, state, created_at, expires_at, absolute_expires_at, renewed_at FROM sessions WHERE id = ?",
    )
    .bind(input.sessionId)
    .first<SessionTimeRow>();
  if (pending === null || pending.user_id !== input.userId || pending.state !== "pending")
    return "conflict";
  const label = sessionLabel(pending.created_at, input.platform, input.label);
  const expiresAt = Math.min(input.now + SESSION_IDLE_TTL * SECOND, pending.absolute_expires_at);
  const selected = input.selectedIds;
  const placeholders = selected.map(() => "?").join(",");
  const selectionCount =
    selected.length === 0
      ? "1 = 1"
      : `(SELECT count(*) FROM sessions r WHERE r.user_id = sessions.user_id
          AND r.id IN (${placeholders}) AND r.state = 'active'
          AND r.expires_at > ? AND r.absolute_expires_at > ?
          AND r.auth_epoch = sessions.auth_epoch AND r.recovery_epoch = sessions.recovery_epoch) = ?`;
  const activeCount = `(SELECT count(*) FROM sessions a WHERE a.user_id = sessions.user_id
          AND a.state = 'active' AND a.expires_at > ? AND a.absolute_expires_at > ?
          AND a.auth_epoch = sessions.auth_epoch AND a.recovery_epoch = sessions.recovery_epoch
          ${selected.length ? `AND a.id NOT IN (${placeholders})` : ""}) < ?`;
  await input.beforeCommit?.();
  const outcome = await conditionalCommit(input.db, {
    guard: {
      sql: `UPDATE sessions SET state = 'active', label = ?, platform_hint = ?,
                activated_at = ?, renewed_at = ?, expires_at = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND state = 'pending'
               AND expires_at > ? AND absolute_expires_at > ?
               AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
                           AND u.status = 'active' AND u.auth_epoch = sessions.auth_epoch
                           AND u.recovery_epoch = sessions.recovery_epoch)
               AND EXISTS (SELECT 1 FROM auth_challenges c WHERE c.pending_session_id = sessions.id
                           AND c.receipt_ciphertext IS NOT NULL AND c.receipt_expires_at > ?)
               AND ${selectionCount} AND ${activeCount}`,
      params: [
        label,
        input.platform,
        input.now,
        input.now,
        expiresAt,
        input.now,
        input.sessionId,
        input.userId,
        input.now,
        input.now,
        input.now,
        ...selected,
        ...(selected.length ? [input.now, input.now, selected.length] : []),
        input.now,
        input.now,
        ...selected,
        SESSION_ACTIVE_MAX,
      ],
    },
    effects: [
      ...selected.map((id) => ({
        kind: "update" as const,
        table: "sessions",
        set: {
          state: "revoked",
          revoked_at: input.now,
          revoke_reason: "activation_selection",
          updated_at: input.now,
        },
        where: { sql: "id = ? AND user_id = ? AND state = 'active'", params: [id, input.userId] },
      })),
      activatedReceiptClearEffect(input.sessionId, input.now),
    ],
  });
  return outcome.outcome === "committed" ? "activated" : "conflict";
}

export async function renewSession(
  db: D1Database,
  userId: string,
  sessionId: string,
  now: number,
): Promise<{ renewed: boolean; expiresAt: number } | null> {
  const row = await db
    .prepare(
      "SELECT id, user_id, state, created_at, expires_at, absolute_expires_at, renewed_at FROM sessions WHERE id = ?",
    )
    .bind(sessionId)
    .first<SessionTimeRow>();
  if (row === null || row.user_id !== userId || row.state !== "active") return null;
  const expiresAt = Math.min(now + SESSION_IDLE_TTL * SECOND, row.absolute_expires_at);
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE sessions SET renewed_at = ?, expires_at = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND state = 'active'
               AND expires_at > ? AND absolute_expires_at > ?
               AND renewed_at <= ?
               AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
                           AND u.status = 'active' AND u.auth_epoch = sessions.auth_epoch
                           AND u.recovery_epoch = sessions.recovery_epoch)`,
      params: [
        now,
        expiresAt,
        now,
        sessionId,
        userId,
        now,
        now,
        now - SESSION_RENEW_INTERVAL * SECOND,
      ],
    },
  });
  if (outcome.outcome === "committed") return { renewed: true, expiresAt };
  const current = await db
    .prepare(`SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.id = ? AND s.user_id = ? AND s.state = 'active'
                  AND s.expires_at > ? AND s.absolute_expires_at > ?
                  AND u.status = 'active' AND s.auth_epoch = u.auth_epoch
                  AND s.recovery_epoch = u.recovery_epoch`)
    .bind(sessionId, userId, now, now)
    .first<{ expires_at: number }>();
  return current === null ? null : { renewed: false, expiresAt: current.expires_at };
}

export async function revokeSession(
  db: D1Database,
  userId: string,
  targetId: string,
  now: number,
): Promise<"revoked" | "already_revoked" | "not_found"> {
  const owned = await db
    .prepare("SELECT state FROM sessions WHERE id = ? AND user_id = ?")
    .bind(targetId, userId)
    .first<{ state: string }>();
  if (owned === null) return "not_found";
  if (owned.state === "revoked") return "already_revoked";
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: "UPDATE sessions SET state = 'revoked', revoked_at = ?, revoke_reason = 'user_revoke', updated_at = ? WHERE id = ? AND user_id = ? AND state IN ('active','pending')",
      params: [now, now, targetId, userId],
    },
  });
  return outcome.outcome === "committed" ? "revoked" : "already_revoked";
}

/** 定时挂接属后续卡；此函数只处理 pending 到期，并清除可恢复 Cookie 密文。 */
export async function cleanupExpiredPendingSessions(db: D1Database, now: number): Promise<number> {
  const results = await db.batch([
    db
      .prepare(`UPDATE auth_challenges SET receipt_ciphertext = NULL, receipt_expires_at = NULL, updated_at = ?
                 WHERE receipt_ciphertext IS NOT NULL AND pending_session_id IN
                   (SELECT id FROM sessions WHERE state = 'pending' AND expires_at <= ?)`)
      .bind(now, now),
    db
      .prepare(`UPDATE sessions SET state = 'revoked', revoked_at = ?,
                  revoke_reason = 'pending_timeout', updated_at = ?
                 WHERE state = 'pending' AND expires_at <= ?`)
      .bind(now, now, now),
  ]);
  return results[1]?.meta.changes ?? 0;
}
