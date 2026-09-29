// P2-07：通道卡在本账号事务中追加本通道的撤销效果；不预设 Feed/Push 状态值。
import type { GuardedEffect } from "../../storage/cas";

export type LifecycleEvent = "email_change" | "account_delete";
export interface LifecycleEffectContext {
  readonly db: D1Database;
  readonly userId: string;
  readonly now: number;
  readonly event: LifecycleEvent;
}
export type LifecycleEffectHook = (
  context: LifecycleEffectContext,
) => Promise<readonly GuardedEffect[]>;

export async function collectLifecycleEffects(
  context: LifecycleEffectContext,
  hooks: readonly LifecycleEffectHook[],
): Promise<GuardedEffect[]> {
  const effects: GuardedEffect[] = [];
  for (const hook of hooks) effects.push(...(await hook(context)));
  return effects;
}
