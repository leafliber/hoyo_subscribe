// A-P1-BUDGET · 三个日池与占用语义（任务卡 P1-07）——L1 纯函数测试。
// 合同依据：CONTRACTS_BASELINE.md §7.1、ADR-0003、主方案 §9.1。
import { describe, expect, it } from "vitest";
import { PARAMS } from "../params/registry";
import {
  AUTH_MAIL_POOLS,
  authDayTotalLimit,
  authTotalOccupancy,
  BUDGET_PERIOD_KIND,
  dayRemaining,
  EMPTY_OCCUPANCY,
  floorIsEngaged,
  MAIL_POOLS,
  type MailPoolOccupancy,
  occupancyTotal,
  poolDayLimit,
  utcDayPeriod,
} from "./pools";

const occ = (patch: Partial<MailPoolOccupancy>): MailPoolOccupancy => ({
  reserved: 0,
  settled: 0,
  uncertain: 0,
  ...patch,
});

describe("A-P1-BUDGET 占用三元组（§9.1：settled + reserved + uncertain 均占当日额度）", () => {
  it("A-P1-BUDGET 任一维度单独存在即计入占用，三者相加", () => {
    expect(occupancyTotal(occ({ reserved: 7 }))).toBe(7);
    expect(occupancyTotal(occ({ settled: 7 }))).toBe(7);
    expect(occupancyTotal(occ({ uncertain: 7 }))).toBe(7);
    expect(occupancyTotal(occ({ reserved: 1, settled: 2, uncertain: 3 }))).toBe(6);
    expect(occupancyTotal(EMPTY_OCCUPANCY)).toBe(0);
  });

  it("A-P1-BUDGET 当日剩余随占用合计递减，与占用构成方式无关（reserved/settled/uncertain 同权）", () => {
    const limit = poolDayLimit("urgent_business");
    expect(dayRemaining(limit, occ({ reserved: 3 }))).toBe(limit - 3);
    expect(dayRemaining(limit, occ({ settled: 3 }))).toBe(limit - 3);
    expect(dayRemaining(limit, occ({ uncertain: 3 }))).toBe(limit - 3);
    expect(dayRemaining(limit, occ({ reserved: 1, settled: 1, uncertain: 1 }))).toBe(limit - 3);
  });
});

describe("A-P1-BUDGET 池日额度映射（全部来自参数注册表，无第二份字面量）", () => {
  it("A-P1-BUDGET poolDayLimit 与注册表值恒等；认证总池 = MAIL_AUTH_DAY", () => {
    expect(poolDayLimit("existing_auth")).toBe(PARAMS.MAIL_AUTH_DAY);
    expect(poolDayLimit("new_registration")).toBe(PARAMS.MAIL_SIGNUP_AUTH_DAY);
    expect(poolDayLimit("base_business")).toBe(PARAMS.MAIL_BASE_DAY);
    expect(poolDayLimit("urgent_business")).toBe(PARAMS.MAIL_URGENT_DAY);
    expect(authDayTotalLimit()).toBe(PARAMS.MAIL_AUTH_DAY);
    expect(MAIL_POOLS).toHaveLength(4);
    expect(AUTH_MAIL_POOLS).toHaveLength(2);
    // 新注册子额度是认证日池的子集（A.5 等式 MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY 的结构面）。
    expect(poolDayLimit("new_registration")).toBeLessThanOrEqual(authDayTotalLimit());
  });

  it("A-P1-BUDGET 认证总池占用 = existing_auth 行 + new_registration 行（结构上不含其他池）", () => {
    const total = authTotalOccupancy({
      existing_auth: occ({ reserved: 10, settled: 5, uncertain: 2 }),
      new_registration: occ({ reserved: 3, settled: 1, uncertain: 0 }),
      base_business: occ({ reserved: 40 }),
      urgent_business: occ({ reserved: 100 }),
    });
    expect(total).toEqual({ reserved: 13, settled: 6, uncertain: 2 });
    expect(occupancyTotal(total)).toBe(21);
  });
});

describe("A-P1-BUDGET floor 边界（等号属于触发侧，★100 席位用例的判定基础）", () => {
  it("A-P1-BUDGET floorIsEngaged：剩余 = floor+1 不触发；= floor 触发；= 0 触发", () => {
    const floor = PARAMS.MAIL_URGENT_FLOOR;
    expect(floorIsEngaged(floor + 1, floor)).toBe(false);
    expect(floorIsEngaged(floor, floor)).toBe(true);
    expect(floorIsEngaged(0, floor)).toBe(true);
  });
});

describe("A-P1-BUDGET UTC 日分桶（period_key 派生；每 UTC 日独立、不跨日结转）", () => {
  it("A-P1-BUDGET 同一 UTC 日内任意时刻同桶；跨零点换桶", () => {
    const day = utcDayPeriod(Date.UTC(2026, 8, 22, 0, 0, 0));
    expect(utcDayPeriod(Date.UTC(2026, 8, 22, 12, 34, 56)).key).toBe(day.key);
    expect(utcDayPeriod(Date.UTC(2026, 8, 22, 23, 59, 59, 999)).key).toBe(day.key);
    expect(utcDayPeriod(Date.UTC(2026, 8, 23, 0, 0, 0)).key).not.toBe(day.key);
    expect(day.key).toBe("2026-09-22");
    expect(day.startMs).toBe(Date.UTC(2026, 8, 22));
    expect(day.endMsExclusive).toBe(Date.UTC(2026, 8, 23));
  });

  it("A-P1-BUDGET 月末/年末进位正确（无月末片段概念——ADR-0003 已废止，日就是日）", () => {
    expect(utcDayPeriod(Date.UTC(2026, 11, 31, 23, 0, 0)).key).toBe("2026-12-31");
    expect(utcDayPeriod(Date.UTC(2027, 0, 1, 0, 0, 0)).key).toBe("2027-01-01");
    expect(utcDayPeriod(Date.UTC(2027, 1, 28, 12, 0, 0)).key).toBe("2027-02-28");
    expect(utcDayPeriod(Date.UTC(2027, 2, 1, 0, 0, 0)).key).toBe("2027-03-01");
    // 闰年二月：2028-02-28 的次日是 2028-02-29，不是 03-01。
    expect(utcDayPeriod(Date.UTC(2028, 1, 28)).endMsExclusive).toBe(Date.UTC(2028, 1, 29));
  });

  it("A-P1-BUDGET 周期口径常量与迁移一致（usage_periods.period_kind 唯一取值）", () => {
    expect(BUDGET_PERIOD_KIND).toBe("utc_day");
  });
});
