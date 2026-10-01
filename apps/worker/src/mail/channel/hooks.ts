import { EMAIL_CONSENT_DISABLE_ACTION } from "@hoyo/contracts";
import type { LifecycleEffectHook } from "../../accounts/lifecycle/effects";
import type { SafetyPauseContext, SafetyPauseEffectHook } from "../../auth/recovery/pause";
import type { GuardedEffect } from "../../storage/cas";

async function closeEffects(
  context: SafetyPauseContext,
  reason: string,
): Promise<readonly GuardedEffect[]> {
  const { db, userId, now } = context;
  // 只铺设关闭行：避免“读时不存在，提交前被开启”的竞态，也保证同批效果恰好命中一行。
  await db
    .prepare(`INSERT INTO email_channels(user_id,address_version,created_at,updated_at)
    SELECT id,email_version,?,? FROM users WHERE id=? ON CONFLICT(user_id) DO NOTHING`)
    .bind(now, now, userId)
    .run();
  const row = await db
    .prepare(`SELECT u.email_binding_id,c.consent_version FROM users u
    JOIN email_channels c ON c.user_id=u.id WHERE u.id=?`)
    .bind(userId)
    .first<{ email_binding_id: string; consent_version: number }>();
  if (!row) return [];
  // 每条效果恰好一行；并发开启亦会在安全暂停的权威事务内被关闭。
  return [
    ...(["seat", "routine"] as const).map(
      (layer): GuardedEffect => ({
        kind: "insert",
        table: "consent_events",
        columns: [
          "id",
          "user_id",
          "email_binding_id",
          "layer",
          "action",
          "consent_version",
          "context_json",
          "created_at",
        ],
        rows: [
          [
            crypto.randomUUID(),
            userId,
            row.email_binding_id,
            layer,
            EMAIL_CONSENT_DISABLE_ACTION,
            row.consent_version,
            JSON.stringify({ reason }),
            now,
          ],
        ],
      }),
    ),
    {
      kind: "update",
      table: "email_channels",
      set: {
        enabled: 0,
        routine_enabled: 0,
        lease_expires_at: null,
        // 0017 的换绑触发器会前移 address_version；新地址不能继承旧租期元数据。
        ...(reason === "email_change"
          ? { consent_version: 0, last_renewed_at: null, last_renewed_reason: null }
          : {}),
        channel_revision: { sql: "channel_revision+1" },
        updated_at: now,
      },
      where: { sql: "user_id=?", params: [userId] },
    },
  ];
}
export const emailSafetyPauseHook: SafetyPauseEffectHook = (context) =>
  closeEffects(context, "safety_pause");
export const emailLifecycleHook: LifecycleEffectHook = (context) =>
  closeEffects(context, context.event);
