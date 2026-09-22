// 操作额度、终止路径与边缘限速分工（任务卡 P1-07，验收 ID A-P1-BUDGET）——纯类型与键格式。
//
// 合同依据：主方案 §9.5——USER_MUTATIONS_DAY 每账号 / GLOBAL_MUTATIONS_DAY 全站；范围为
// 普通订阅保存、日历启用/重置和设备管理等状态变更；邮件退订、Feed 停用、会话撤销、
// 恢复码紧急停用与删除入口**不被普通修改日额阻断**。[R16]——近似 IP/边缘限速只挡突发，
// 精确配额与存量必须走数据库账本。
//
// [R16] 分工合同：边缘限速的结论是建议性的（advisory）——它可能误伤、没有配额视图，
// 只用于挡突发；配额与存量的唯一权威是 D1 账本（usage_periods 与 capacity_state 计数行）。
// 边缘限速的任何结果不得被当成「预算已用尽 / 预算充足」的判定依据，也不得反过来
// 用账本去实现突发限速（那是边缘层的职责）。

/** §9.5 的终止路径：不被 USER_MUTATIONS_DAY / GLOBAL_MUTATIONS_DAY 阻断，也不消耗计数。 */
export const TERMINATION_MUTATION_ACTIONS = [
  "unsubscribe", // 邮件退订
  "feed_disable", // Feed 停用
  "session_revoke", // 会话撤销
  "emergency_deactivation", // 恢复码紧急停用（恢复入口不依赖发信预算，§9.2 保留条款）
  "account_delete", // 删除账号
] as const;

/**
 * 普通状态变更的封闭标记集。§9.5 的范围（订阅保存、日历启用/重置、设备管理等）对
 * 计数器而言不需要区分动作身份——计数的粒度就是「一次普通状态变更」，因此普通侧是
 * 单一标记；终止侧是封闭枚举，因为「不被阻断」是逐项写进合同的。
 */
export const REGULAR_MUTATION_ACTIONS = ["regular_state_change"] as const;

export type RegularMutationAction = (typeof REGULAR_MUTATION_ACTIONS)[number];

export type TerminationMutationAction = (typeof TERMINATION_MUTATION_ACTIONS)[number];

export type MutationAction = TerminationMutationAction | RegularMutationAction;

export function isTerminationMutation(action: MutationAction): action is TerminationMutationAction {
  return (TERMINATION_MUTATION_ACTIONS as readonly string[]).includes(action);
}

/**
 * 精确计数行的键格式（capacity_state.key，worker 侧消费）。键含 UTC 日：新的一天就是
 * 新的键，天然实现日重置与不跨日结转，无需清理前的任何结转逻辑。
 */
export function mutationCounterKeys(
  userId: string,
  utcDayKey: string,
): { userKey: string; globalKey: string } {
  return {
    userKey: `mutations:user:${userId}:${utcDayKey}`,
    globalKey: `mutations:global:${utcDayKey}`,
  };
}

/** [R16] 分工的常量声明：边缘限速只挡突发（建议性），权威配额在 D1 账本。 */
export const EDGE_RATE_LIMIT_ROLE = {
  advisoryOnly: true,
  authoritativeLedger: "d1-usage-periods-and-capacity-state",
} as const;
