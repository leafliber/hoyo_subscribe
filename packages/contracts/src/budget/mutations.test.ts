// A-P1-BUDGET · 操作额度与终止路径 taxonomy（任务卡 P1-07）——L1 纯函数测试。
// 合同依据：主方案 §9.5（终止路径不被普通修改日额阻断）、[R16]（边缘限速只挡突发）。
import { describe, expect, it } from "vitest";
import {
  EDGE_RATE_LIMIT_ROLE,
  isTerminationMutation,
  type MutationAction,
  mutationCounterKeys,
  REGULAR_MUTATION_ACTIONS,
  TERMINATION_MUTATION_ACTIONS,
} from "./mutations";

describe("A-P1-BUDGET 终止路径枚举（§9.5：五项终止能力不被普通修改日额阻断）", () => {
  it("A-P1-BUDGET 五个终止动作全部识别为终止；普通状态变更不计入终止", () => {
    expect(TERMINATION_MUTATION_ACTIONS).toEqual([
      "unsubscribe",
      "feed_disable",
      "session_revoke",
      "emergency_deactivation",
      "account_delete",
    ]);
    for (const action of TERMINATION_MUTATION_ACTIONS) {
      expect(isTerminationMutation(action)).toBe(true);
    }
    for (const action of REGULAR_MUTATION_ACTIONS) {
      expect(isTerminationMutation(action)).toBe(false);
    }
    expect(isTerminationMutation("regular_state_change")).toBe(false);
  });

  it("A-P1-BUDGET 动作集合是封闭的：普通侧一个标记，终止侧逐项枚举（类型层约束的运行时镜像）", () => {
    const all: readonly MutationAction[] = [
      ...TERMINATION_MUTATION_ACTIONS,
      ...REGULAR_MUTATION_ACTIONS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("A-P1-BUDGET 计数行键格式（capacity_state.key；键含 UTC 日 → 天然日重置）", () => {
  it("A-P1-BUDGET 用户键含用户与日；全局键只含日；不同日即不同键（不跨日结转的机制面）", () => {
    const day1 = mutationCounterKeys("u_1", "2026-09-22");
    expect(day1.userKey).toBe("mutations:user:u_1:2026-09-22");
    expect(day1.globalKey).toBe("mutations:global:2026-09-22");

    const day2 = mutationCounterKeys("u_1", "2026-09-23");
    expect(day2.userKey).not.toBe(day1.userKey);
    expect(day2.globalKey).not.toBe(day1.globalKey);

    const otherUser = mutationCounterKeys("u_2", "2026-09-22");
    expect(otherUser.userKey).not.toBe(day1.userKey);
    expect(otherUser.globalKey).toBe(day1.globalKey); // 全站一行共享
  });
});

describe("A-P1-BUDGET [R16] 分工声明（边缘限速只挡突发；权威配额在 D1 账本）", () => {
  it("A-P1-BUDGET 边缘限速被固定为建议性，权威账本指向 D1", () => {
    expect(EDGE_RATE_LIMIT_ROLE.advisoryOnly).toBe(true);
    expect(EDGE_RATE_LIMIT_ROLE.authoritativeLedger).toBe("d1-usage-periods-and-capacity-state");
  });
});
