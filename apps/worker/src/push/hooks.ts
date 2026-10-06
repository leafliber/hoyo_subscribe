// P6-01 · 安全暂停与账号生命周期挂钩（主方案 §4.6、§9.6；P2-05 / P2-07 挂接点；ADR-0025）。
//
// 紧急停用、恢复登录（P2-05 安全暂停）与删除账号（P2-07）都必须在同一账号事务里暂停 Push：
// 效果只推进 users.push_revocation_version（守卫命中时必然恰好一行），由 0029 的触发器在同一事务内
// 把该账号所有 pending/active 绑定转为 paused（零到多个），与 Feed 撤销同一做法；不预读绑定，
// 避免"收集效果与提交之间首次启用"的竞态。紧急停用不消费恢复码（由 P2-05 保证）。
// 换邮箱不影响 Push：绑定归属账号，不归属邮箱。
import type { LifecycleEffectHook } from "../accounts/lifecycle/effects";
import type { SafetyPauseContext, SafetyPauseEffectHook } from "../auth/recovery/pause";
import type { GuardedEffect } from "../storage/cas";

export const pushSafetyPauseHook: SafetyPauseEffectHook = Object.assign(
  async ({ userId, now }: SafetyPauseContext): Promise<readonly GuardedEffect[]> => [
    {
      kind: "update",
      table: "users",
      set: { push_revocation_version: { sql: "push_revocation_version+1" }, updated_at: now },
      where: { sql: "id=?", params: [userId] },
    },
  ],
  // 仍有等待激活或已激活的绑定即未关闭；与触发器暂停的范围一致。
  {
    openSql:
      "EXISTS (SELECT 1 FROM push_bindings p WHERE p.user_id = users.id AND p.state IN ('pending','active'))",
  },
);

export const pushLifecycleHook: LifecycleEffectHook = async (context) =>
  context.event === "account_delete" ? pushSafetyPauseHook(context) : [];
