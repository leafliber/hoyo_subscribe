// P3-07：专用撤销版本由 hook 推进；触发器在同一事务撤销零或一个 Feed。
// 不预读 Feed 是否存在，避免收集效果与提交之间的首次启用竞态。

import type { LifecycleEffectHook } from "../../accounts/lifecycle/effects";
import type { SafetyPauseContext, SafetyPauseEffectHook } from "../../auth/recovery/pause";
import type { GuardedEffect } from "../../storage/cas";
export const pauseCalendar: SafetyPauseEffectHook = Object.assign(
  async ({ userId, now }: SafetyPauseContext): Promise<readonly GuardedEffect[]> => [
    {
      kind: "update",
      table: "users",
      set: {
        calendar_revocation_version: { sql: "calendar_revocation_version+1" },
        updated_at: now,
      },
      where: { sql: "id=?", params: [userId] },
    },
  ],
  // 仍有启用中的 Feed 即未关闭；与触发器撤销的范围一致。
  {
    openSql:
      "EXISTS (SELECT 1 FROM calendar_feeds f WHERE f.user_id = users.id AND f.state = 'enabled')",
  },
);
export const calendarLifecycle: LifecycleEffectHook = async (context) =>
  context.event === "account_delete" ? pauseCalendar(context) : [];
