// P2-05 · 安全暂停的单一挂接点（§4.6）。本卡的权威撤销为 users.auth_epoch 递增；
// P3-07 / P4-05 / P6-01 在此注入各通道的同批条件效果，不在本卡臆造通道状态。
import type { GuardedEffect } from "../../storage/cas";

export interface SafetyPauseContext {
  readonly db: D1Database;
  readonly userId: string;
  readonly now: number;
}

/** 注入的效果必须在 users 守卫命中时恰好命中一行；无通道行时返回空数组。 */
export type SafetyPauseEffectHook = (
  context: SafetyPauseContext,
) => Promise<readonly GuardedEffect[]>;

export async function collectSafetyPauseEffects(
  context: SafetyPauseContext,
  hooks: readonly SafetyPauseEffectHook[],
): Promise<GuardedEffect[]> {
  const effects: GuardedEffect[] = [];
  for (const hook of hooks) effects.push(...(await hook(context)));
  return effects;
}

/**
 * auth_epoch 已是权限撤销的权威；这里清理旧行，避免失效 pending 继续占 P2-03 名额。
 * 两条 UPDATE 均允许零行，故不写成 conditionalCommit 的依赖效果。
 */
export async function retireInvalidatedSessions(
  db: D1Database,
  userId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE auth_challenges SET receipt_ciphertext = NULL,
        receipt_expires_at = NULL, updated_at = ?
      WHERE receipt_ciphertext IS NOT NULL AND pending_session_id IN
        (SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.user_id = ? AND s.auth_epoch <> u.auth_epoch)`)
      .bind(now, userId),
    db
      .prepare(`UPDATE sessions SET state = 'revoked', revoked_at = ?,
        revoke_reason = 'recovery_pause', updated_at = ?
      WHERE user_id = ? AND state IN ('pending','active')
        AND auth_epoch <> (SELECT auth_epoch FROM users WHERE id = ?)`)
      .bind(now, now, userId, userId),
  ]);
}
