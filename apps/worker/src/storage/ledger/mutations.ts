// 操作额度精确计数（任务卡 P1-07，验收 ID A-P1-BUDGET）。
//
// 合同依据：主方案 §9.5——USER_MUTATIONS_DAY（每账号）与 GLOBAL_MUTATIONS_DAY（全站）
// 计普通状态变更；**终止路径不被阻断**（邮件退订、Feed 停用、会话撤销、恢复码紧急
// 停用、删除账号）——这是恢复入口不依赖预算的组成部分（§9.2 保留条款），终止动作
// 连计数都不消耗（不写库）。[R16]——本模块是精确账本；近似边缘限速只挡突发，其结论
// 不得进入这里的判定。
//
// 计数行落在 capacity_state（键格式来自 contracts 的 mutationCounterKeys，键含 UTC 日：
// 新的一天即新的键，天然日重置、不跨日结转）。判定纪律沿 P1-05：用户/全站两级上限
// 都在守卫 UPDATE 的 WHERE 谓词内（全站经子查询），禁止 COUNT 后无条件 INSERT。
//
// 已停止对象的再次停止不重复写库、幂等状态转换属业务层（P2/P4）；平台整体不可用时
// 返回真实错误（conditionalCommit 会 reject），不伪称已停用。

import {
  GLOBAL_MUTATIONS_DAY,
  isTerminationMutation,
  type MutationAction,
  mutationCounterKeys,
  USER_MUTATIONS_DAY,
} from "@hoyo/contracts";
import { conditionalCommit } from "../cas";

export interface MutationAllowancePlan {
  action: MutationAction;
  userId: string;
  /** UTC 日键（contracts utcDayPeriod().key）。 */
  utcDayKey: string;
  now: number;
}

export type MutationAllowanceDecision =
  | { allowed: true; counted: boolean; terminationBypass: boolean }
  | {
      allowed: false;
      reason: "user_day_exhausted" | "global_day_exhausted";
      counted: boolean;
    };

/**
 * 消耗一次普通状态变更额度；终止动作直接放行且不消耗任何计数（§9.5）。
 * 普通变更满额 → allowed:false（user/global 两级都会在守卫谓词里原子判定）。
 * reason 的区分是 miss 之后的只读复核，仅供调用方提示，不是第二判定源。
 */
export async function consumeMutationAllowance(
  db: D1Database,
  plan: MutationAllowancePlan,
): Promise<MutationAllowanceDecision> {
  if (isTerminationMutation(plan.action)) {
    // 终止路径零写入：不预插行、不计数——额度再满也放行。
    return { allowed: true, counted: false, terminationBypass: true };
  }
  const { userKey, globalKey } = mutationCounterKeys(plan.userId, plan.utcDayKey);

  const outcome = await conditionalCommit(db, {
    preamble: [
      {
        sql: "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
        params: [userKey, plan.now],
      },
      {
        sql: "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
        params: [globalKey, plan.now],
      },
    ],
    guard: {
      sql: `UPDATE capacity_state SET value = value + 1, version = version + 1, updated_at = ?
        WHERE key = ? AND value < ?
          AND (SELECT coalesce(value, 0) FROM capacity_state WHERE key = ?) < ?`,
      params: [plan.now, userKey, USER_MUTATIONS_DAY, globalKey, GLOBAL_MUTATIONS_DAY],
    },
    effects: [
      {
        kind: "update",
        table: "capacity_state",
        set: { value: { sql: "value + 1" }, updated_at: plan.now },
        where: { sql: "key = ?", params: [globalKey] },
      },
    ],
  });
  if (outcome.outcome === "committed") {
    return { allowed: true, counted: true, terminationBypass: false };
  }

  // condition_missed 的只读复核：区分是用户日额还是全站日额顶格（提示用途）。
  const userRow = await db
    .prepare("SELECT value FROM capacity_state WHERE key = ?")
    .bind(userKey)
    .first<{ value: number }>();
  return {
    allowed: false,
    reason:
      (userRow?.value ?? 0) >= USER_MUTATIONS_DAY ? "user_day_exhausted" : "global_day_exhausted",
    counted: false,
  };
}
