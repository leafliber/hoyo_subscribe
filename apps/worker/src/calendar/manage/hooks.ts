// P3-07：专用撤销版本由 hook 推进；触发器在同一事务撤销零或一个 Feed。
// 不预读 Feed 是否存在，避免收集效果与提交之间的首次启用竞态。

import type { LifecycleEffectHook } from "../../accounts/lifecycle/effects";
import type { SafetyPauseEffectHook } from "../../auth/recovery/pause";
export const pauseCalendar: SafetyPauseEffectHook = async ({ userId, now }) => [
  {
    kind: "update",
    table: "users",
    set: { calendar_revocation_version: { sql: "calendar_revocation_version+1" }, updated_at: now },
    where: { sql: "id=?", params: [userId] },
  },
];
export const calendarLifecycle: LifecycleEffectHook = async (context) =>
  context.event === "account_delete" ? pauseCalendar(context) : [];
