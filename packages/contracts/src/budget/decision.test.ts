// A-P1-BUDGET · 邮件意图当日判定（任务卡 P1-07）——L1 纯函数测试。
// 合同依据：CONTRACTS_BASELINE.md §7.1—§7.3、ADR-0003、主方案 §9.1。
// 重点钉死（任务卡明示）：
//   ★ 池间不互借：认证池耗尽时紧急池仍可发；反向同样成立（认证意图不得借紧急/基础余量）。
//   ★ 一次全量取消（MAIL_SEATS_MAX=100 席位）后当日紧急池余 20，恰好触发 floor 收紧。
import { describe, expect, it } from "vitest";
import { PARAMS } from "../params/registry";
import {
  decideMailIntent,
  type MailIntentKind,
  planMailReservation,
  poolOfMailIntent,
} from "./decision";
import {
  EMPTY_OCCUPANCY,
  type MailDayLedgerSnapshot,
  type MailPool,
  type MailPoolOccupancy,
} from "./pools";

const occ = (patch: Partial<MailPoolOccupancy>): MailPoolOccupancy => ({
  reserved: 0,
  settled: 0,
  uncertain: 0,
  ...patch,
});

function snapshot(
  pools: Partial<Record<keyof MailDayLedgerSnapshot["pools"], MailPoolOccupancy>>,
  users?: { base?: MailPoolOccupancy; urgent?: MailPoolOccupancy },
): MailDayLedgerSnapshot {
  return {
    periodKey: "2026-09-22",
    pools: {
      existing_auth: pools.existing_auth ?? EMPTY_OCCUPANCY,
      new_registration: pools.new_registration ?? EMPTY_OCCUPANCY,
      base_business: pools.base_business ?? EMPTY_OCCUPANCY,
      urgent_business: pools.urgent_business ?? EMPTY_OCCUPANCY,
    },
    userBase: users?.base,
    userUrgent: users?.urgent,
  };
}

const AUTH_TOTAL = PARAMS.MAIL_AUTH_DAY;
const SIGNUP_QUOTA = PARAMS.MAIL_SIGNUP_AUTH_DAY;
const AUTH_FLOOR = PARAMS.MAIL_AUTH_FLOOR;
const BASE_TOTAL = PARAMS.MAIL_BASE_DAY;
const URGENT_TOTAL = PARAMS.MAIL_URGENT_DAY;
const URGENT_FLOOR = PARAMS.MAIL_URGENT_FLOOR;
const SEATS = PARAMS.MAIL_SEATS_MAX;

describe("A-P1-BUDGET 池间不互借（§7.1：三个日池各自独立，出现互借即不合格）", () => {
  it("A-P1-BUDGET 认证池耗尽：紧急池与基础池仍可发（各自额度未被认证消耗波及）", () => {
    const snap = snapshot({
      existing_auth: occ({ settled: AUTH_TOTAL }),
      new_registration: occ({ settled: SIGNUP_QUOTA }),
    });
    expect(decideMailIntent("urgent_cancelled_or_retracted", snap)).toEqual({
      decision: "approve",
      pool: "urgent_business",
    });
    expect(decideMailIntent("urgent_important_change", snap)).toEqual({
      decision: "approve",
      pool: "urgent_business",
    });
    expect(decideMailIntent("base_routine_or_announce", snap)).toEqual({
      decision: "approve",
      pool: "base_business",
    });
  });

  it("A-P1-BUDGET ★ 认证池耗尽：认证意图全部拒绝——即使紧急/基础池还有大量余量（不得借）", () => {
    const snap = snapshot({ existing_auth: occ({ settled: AUTH_TOTAL }) });
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "reject",
      reason: "auth_day_exhausted",
    });
    expect(decideMailIntent("auth_resend", snap)).toEqual({
      decision: "reject",
      reason: "auth_day_exhausted",
    });
    expect(decideMailIntent("signup_auth", snap)).toEqual({
      decision: "reject",
      reason: "auth_day_exhausted",
    });
  });

  it("A-P1-BUDGET 紧急池耗尽：紧急意图拒绝——认证/基础不接济；基础池耗尽同理", () => {
    const urgentFull = snapshot({ urgent_business: occ({ settled: URGENT_TOTAL }) });
    expect(decideMailIntent("urgent_cancelled_or_retracted", urgentFull)).toEqual({
      decision: "reject",
      reason: "urgent_day_exhausted",
    });
    expect(decideMailIntent("existing_auth_first_login", urgentFull)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });

    const baseFull = snapshot({ base_business: occ({ settled: BASE_TOTAL }) });
    expect(decideMailIntent("base_routine_or_announce", baseFull)).toEqual({
      decision: "reject",
      reason: "base_day_exhausted",
    });
    expect(decideMailIntent("urgent_late_discovery", baseFull)).toEqual({
      decision: "approve",
      pool: "urgent_business",
    });
  });

  it("A-P1-BUDGET 基础/紧急余量再多也不抬高认证判定：认证剩余只看两行认证占用合计", () => {
    const snap = snapshot({ existing_auth: occ({ settled: AUTH_TOTAL - 1 }) });
    // 认证只剩 1：首次登录放行，重发已进降级区（1 <= floor）。
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
    expect(decideMailIntent("auth_resend", snap)).toEqual({
      decision: "reject",
      reason: "auth_floor_degraded",
    });
  });
});

describe("A-P1-BUDGET ★ 一次全量取消（100 席位）后余 20 恰好触发紧急 floor（§7.3）", () => {
  it("A-P1-BUDGET ★ 前 100 封取消逐封放行；第 100 封后剩余恰为 floor，收紧为只发取消/撤回", () => {
    // MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR（A.5 等式，取等号）。
    expect(URGENT_TOTAL).toBe(SEATS + URGENT_FLOOR);

    // 逐封取消：从 0 发到 100，每一封在发送前判定都应放行（最高档不受 floor 影响）。
    for (let sent = 0; sent < SEATS; sent++) {
      const snap = snapshot({ urgent_business: occ({ settled: sent }) });
      expect(decideMailIntent("urgent_cancelled_or_retracted", snap)).toEqual({
        decision: "approve",
        pool: "urgent_business",
      });
    }

    // ★ 100 席位全部通知完：当日剩余 = 120 − 100 = 20，恰好落到 floor 上。
    const afterFullCancellation = snapshot({ urgent_business: occ({ settled: SEATS }) });
    expect(afterFullCancellation.pools.urgent_business.settled).toBe(SEATS);
    // 低两档被收紧拒绝（这一天第二次取消前的重要更正/晚发现不再消耗紧急池）。
    expect(decideMailIntent("urgent_important_change", afterFullCancellation)).toEqual({
      decision: "reject",
      reason: "urgent_floor_degraded",
    });
    expect(decideMailIntent("urgent_late_discovery", afterFullCancellation)).toEqual({
      decision: "reject",
      reason: "urgent_floor_degraded",
    });
    // 取消/撤回仍是唯一可发档：剩余 20 封全部留给它。
    expect(decideMailIntent("urgent_cancelled_or_retracted", afterFullCancellation)).toEqual({
      decision: "approve",
      pool: "urgent_business",
    });
  });

  it("A-P1-BUDGET floor 触发的等号边界：占用 = 日额度 − floor − 1 时低档仍放行，+1 后收紧", () => {
    const justBefore = snapshot({
      urgent_business: occ({ settled: URGENT_TOTAL - URGENT_FLOOR - 1 }),
    });
    expect(decideMailIntent("urgent_important_change", justBefore)).toEqual({
      decision: "approve",
      pool: "urgent_business",
    });
    const atFloor = snapshot({ urgent_business: occ({ settled: URGENT_TOTAL - URGENT_FLOOR }) });
    expect(decideMailIntent("urgent_important_change", atFloor)).toEqual({
      decision: "reject",
      reason: "urgent_floor_degraded",
    });
  });
});

describe("A-P1-BUDGET 认证降级（§7.2：只接受既有账号首次登录，暂停新注册发信与全部重发）", () => {
  it("A-P1-BUDGET 认证剩余 > floor：三类认证意图均放行", () => {
    const snap = snapshot({ existing_auth: occ({ settled: AUTH_TOTAL - AUTH_FLOOR - 1 }) });
    expect(decideMailIntent("signup_auth", snap)).toEqual({
      decision: "approve",
      pool: "new_registration",
    });
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
    expect(decideMailIntent("auth_resend", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
  });

  it("A-P1-BUDGET 认证剩余 = floor：新注册与重发暂停；既有账号首次登录仍放行（§9.2 保留精神）", () => {
    const snap = snapshot({ existing_auth: occ({ settled: AUTH_TOTAL - AUTH_FLOOR }) });
    expect(decideMailIntent("signup_auth", snap)).toEqual({
      decision: "reject",
      reason: "auth_floor_degraded",
    });
    expect(decideMailIntent("auth_resend", snap)).toEqual({
      decision: "reject",
      reason: "auth_floor_degraded",
    });
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
  });

  it("A-P1-BUDGET 新注册子额度用尽：先停注册发信，既有账号登录不受影响（附录 A.4）", () => {
    const snap = snapshot({ new_registration: occ({ settled: SIGNUP_QUOTA }) });
    expect(decideMailIntent("signup_auth", snap)).toEqual({
      decision: "reject",
      reason: "signup_sub_quota_exhausted",
    });
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
    expect(decideMailIntent("auth_resend", snap)).toEqual({
      decision: "approve",
      pool: "existing_auth",
    });
  });

  it("A-P1-BUDGET 认证合计跨行计算：existing 60 + new_registration 30 = 90 → 当日用尽", () => {
    const snap = snapshot({
      existing_auth: occ({ settled: 60 }),
      new_registration: occ({ settled: 30 }),
    });
    expect(decideMailIntent("existing_auth_first_login", snap)).toEqual({
      decision: "reject",
      reason: "auth_day_exhausted",
    });
  });
});

describe("A-P1-BUDGET 当日用尽即停发、次日自动恢复（§7.1：不跨日结转）", () => {
  it("A-P1-BUDGET 三池各自耗尽当日全部停发；换一个 periodKey（次日）即满额恢复", () => {
    const exhausted = snapshot({
      existing_auth: occ({ reserved: AUTH_TOTAL }),
      new_registration: occ({ reserved: SIGNUP_QUOTA }),
      base_business: occ({ reserved: BASE_TOTAL }),
      urgent_business: occ({ reserved: URGENT_TOTAL }),
    });
    for (const kind of [
      "signup_auth",
      "existing_auth_first_login",
      "auth_resend",
      "base_routine_or_announce",
      "urgent_cancelled_or_retracted",
      "urgent_important_change",
      "urgent_late_discovery",
    ] as const) {
      expect(decideMailIntent(kind, exhausted).decision).toBe("reject");
    }

    // 次日快照：新的 periodKey、空占用——昨日耗尽不结转，也不遗留任何降级。
    const nextDay: MailDayLedgerSnapshot = {
      periodKey: "2026-09-23",
      pools: exhausted.pools,
      userBase: occ({}),
      userUrgent: occ({}),
    };
    // 同一占用对象换 periodKey 也应视为新的一天：判定只依赖占用数字，
    // 这里的重点是账本为新一天建立的是全新的 0 占用行（L2 用真实行验证）。
    const freshNextDay = snapshot({});
    for (const kind of [
      "signup_auth",
      "existing_auth_first_login",
      "auth_resend",
      "base_routine_or_announce",
      "urgent_cancelled_or_retracted",
      "urgent_important_change",
      "urgent_late_discovery",
    ] as const) {
      expect(decideMailIntent(kind, freshNextDay).decision).toBe("approve");
    }
    expect(nextDay.periodKey).toBe("2026-09-23");
  });
});

describe("A-P1-BUDGET 每用户日机会（§9.1：基础/紧急分别限频）", () => {
  it("A-P1-BUDGET 用户紧急日机会用尽 → 紧急拒绝，即使池有余量；基础同理独立计数", () => {
    const snap = snapshot(
      {},
      {
        urgent: occ({ settled: PARAMS.MAIL_USER_URGENT_DAY }),
        base: occ({ settled: PARAMS.MAIL_USER_BASE_DAY }),
      },
    );
    expect(decideMailIntent("urgent_cancelled_or_retracted", snap)).toEqual({
      decision: "reject",
      reason: "user_day_exhausted",
    });
    expect(decideMailIntent("base_routine_or_announce", snap)).toEqual({
      decision: "reject",
      reason: "user_day_exhausted",
    });
  });

  it("A-P1-BUDGET 紧急机会未用完的用户不受其他用户计数影响（user 行按用户独立）", () => {
    const otherUserHeavy = snapshot({}, { urgent: occ({ settled: 2 }) });
    expect(decideMailIntent("urgent_late_discovery", otherUserHeavy).decision).toBe("reject");
    const anotherUser = snapshot({}, { urgent: occ({ settled: 1 }) });
    expect(decideMailIntent("urgent_late_discovery", anotherUser).decision).toBe("approve");
  });
});

describe("A-P1-BUDGET planMailReservation 与 decideMailIntent 等价（判定唯一来源，SQL 化不另写一套）", () => {
  it("A-P1-BUDGET 阈值边界逐意图对齐：decide 批准 ⟺ 快照满足 plan 全部阈值", () => {
    const kinds = [
      "signup_auth",
      "existing_auth_first_login",
      "auth_resend",
      "base_routine_or_announce",
      "urgent_cancelled_or_retracted",
      "urgent_important_change",
      "urgent_late_discovery",
    ] as const satisfies readonly MailIntentKind[];

    for (const kind of kinds) {
      const plan = planMailReservation(kind);
      expect(poolOfMailIntent(kind)).toBe(plan.pool);

      // 对每个阈值在 ±1 边界上构造占用，断言 decide 与阈值算术一致。
      // existing_auth 行单独占用时行占用即认证合计占用，绑定边 = min(行上限, 合计上限)；
      // 其余池行上限就是绑定边（认证合计是另一根轴，由下方 authTotalLimit 块单独覆盖）。
      const bindingRowLimit =
        plan.pool === "existing_auth" && plan.authTotalLimit !== undefined
          ? Math.min(plan.rowOccupancyLimit, plan.authTotalLimit)
          : plan.rowOccupancyLimit;
      const atRowLimit = snapshot({
        [plan.pool]: occ({ settled: bindingRowLimit }),
      } as Partial<Record<MailPool, MailPoolOccupancy>>);
      expect(
        decideMailIntent(kind, atRowLimit).decision,
        `${kind}：行占用已到绑定上限 ${bindingRowLimit}`,
      ).toBe("reject");
      const belowRowLimit = snapshot({
        [plan.pool]: occ({ settled: bindingRowLimit - 1 }),
      } as Partial<Record<MailPool, MailPoolOccupancy>>);
      expect(decideMailIntent(kind, belowRowLimit).decision, `${kind}：绑定上限 −1 应放行`).toBe(
        "approve",
      );

      if (plan.authTotalLimit !== undefined) {
        // 认证合计边界：把合计精确压到 authTotalLimit（全部放 existing_auth 行，
        // 不触碰子额度行上限，从而只检验合计谓词这一层）。
        const total = plan.authTotalLimit;
        const onExisting = snapshot({ existing_auth: occ({ settled: total }) });
        expect(
          decideMailIntent(kind, onExisting).decision,
          `${kind}：认证合计已到上限 authTotalLimit=${total}`,
        ).toBe("reject");
        const oneBelow = snapshot({ existing_auth: occ({ settled: total - 1 }) });
        expect(decideMailIntent(kind, oneBelow).decision, `${kind}：认证合计上限 −1 应放行`).toBe(
          "approve",
        );
      }

      if (plan.userDayLimit !== undefined) {
        const userAtLimit = snapshot(
          {},
          plan.pool === "urgent_business"
            ? { urgent: occ({ settled: plan.userDayLimit }) }
            : { base: occ({ settled: plan.userDayLimit }) },
        );
        expect(decideMailIntent(kind, userAtLimit).decision).toBe("reject");
      }
    }
  });

  it("A-P1-BUDGET ★ 全量取消后的收紧阈值在 plan 上同样成立（低档上限 = 日额度 − floor）", () => {
    const top = planMailReservation("urgent_cancelled_or_retracted");
    const lower = planMailReservation("urgent_important_change");
    expect(top.rowOccupancyLimit).toBe(URGENT_TOTAL);
    expect(lower.rowOccupancyLimit).toBe(URGENT_TOTAL - URGENT_FLOOR);
    expect(lower.rowOccupancyLimit).toBe(SEATS); // 一次全量取消恰好把低档额度用完
    // 认证降级对重发/新注册的收紧：合计上限 = 认证日池 − 认证 floor。
    expect(planMailReservation("auth_resend").authTotalLimit).toBe(AUTH_TOTAL - AUTH_FLOOR);
    expect(planMailReservation("signup_auth").authTotalLimit).toBe(AUTH_TOTAL - AUTH_FLOOR);
    expect(planMailReservation("existing_auth_first_login").authTotalLimit).toBe(AUTH_TOTAL);
  });
});
