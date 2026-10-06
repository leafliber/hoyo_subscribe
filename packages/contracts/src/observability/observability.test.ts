import { describe, expect, it } from "vitest";
import { EMPTY_OCCUPANCY } from "../budget/pools";
import {
  MAIL_AUTH_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_URGENT_DAY,
  MAIL_URGENT_FLOOR,
  OBS_CAPACITY_WARN_RATIO,
} from "../params/registry";
import {
  ControlWriteSchema,
  capabilityFact,
  capacityWarning,
  controlFact,
  observedMailPools,
  observedRatio,
  PlatformFactSchema,
  publicOperationalCapabilities,
} from "./index";

describe("A-P5-OBS 观测合同", () => {
  it("缺失和畸形值 unknown，关闭优先但不隐式开放", () => {
    for (const value of [undefined, null, 0, 1, "true", {}, []])
      expect(controlFact(value)).toBe("unknown");
    expect(controlFact(false)).toBe(false);
    expect(capabilityFact(true, "unknown")).toBe("unknown");
    expect(capabilityFact(false, "unknown")).toBe("closed");
  });
  it("公开只含四种能力事实；Push 缺部署配置事实时不冒充开放", () => {
    expect(publicOperationalCapabilities({})).toEqual({
      calendar: "unknown",
      email_seats: "unknown",
      routine_email: "unknown",
      push: "unknown",
    });
    expect(
      publicOperationalCapabilities({
        push_enabled: true,
        outbound_enabled: true,
        read_only: false,
      }).push,
    ).toBe("unknown");
    const opened = { push_enabled: true, outbound_enabled: true, read_only: false } as const;
    // A-P6-BIND：开关、外发总闸、部署配置、非只读四项都成立才开放；任一为 false 即关闭。
    expect(publicOperationalCapabilities(opened, { push_configured: true }).push).toBe("open");
    expect(publicOperationalCapabilities(opened, { push_configured: false }).push).toBe("closed");
    expect(
      publicOperationalCapabilities({ ...opened, push_enabled: false }, { push_configured: true })
        .push,
    ).toBe("closed");
    expect(
      publicOperationalCapabilities({ ...opened, read_only: true }, { push_configured: true }).push,
    ).toBe("closed");
    expect(
      publicOperationalCapabilities({ calendar_enabled: true, read_only: false }).calendar,
    ).toBe("open");
  });
  it("认证合计含注册，floor 等号收紧，池独立", () => {
    const p = observedMailPools({
      periodKey: "synthetic",
      pools: {
        existing_auth: { ...EMPTY_OCCUPANCY, settled: MAIL_AUTH_DAY - MAIL_AUTH_FLOOR - 1 },
        new_registration: { ...EMPTY_OCCUPANCY, uncertain: 1 },
        base_business: { ...EMPTY_OCCUPANCY },
        urgent_business: { ...EMPTY_OCCUPANCY, reserved: MAIL_URGENT_DAY - MAIL_URGENT_FLOOR },
      },
    });
    expect(p.auth).toEqual({ remaining: MAIL_AUTH_FLOOR, floor_engaged: true });
    expect(p.urgent).toEqual({ remaining: MAIL_URGENT_FLOOR, floor_engaged: true });
    expect(p.base.remaining).toBeGreaterThan(0);
  });
  it("比例缺分母不能当零或成功", () => {
    expect(observedRatio(null, 4)).toBeNull();
    expect(observedRatio(4, 0)).toBeNull();
    expect(observedRatio(6, 2)).toBe(3);
  });
  it("严格写 schema 不接受任意开关、自由原因、未知字段", () => {
    const body = {
      control: "outbound_enabled",
      enabled: false,
      expected_updated_at: 0,
      reason: "initial_deployment",
    };
    expect(ControlWriteSchema.safeParse(body).success).toBe(true);
    for (const extra of [
      { control: "secret" },
      { reason: "email@example.test" },
      { token: "synthetic" },
      { enabled: "true" },
      { expected_updated_at: -1 },
    ])
      expect(ControlWriteSchema.safeParse({ ...body, ...extra }).success).toBe(false);
  });
  it("平台事实须属于有效观测周期，禁止负数和任意指标", () => {
    const body = {
      metric: "d1_rows_read",
      value: 12,
      included: 100,
      observed_at: 10,
      period_start: 0,
      period_end: 20,
      reason: "evidence_reviewed",
    };
    expect(PlatformFactSchema.safeParse(body).success).toBe(true);
    for (const extra of [
      { observed_at: 20 },
      { value: -1 },
      { included: 0 },
      { metric: "endpoint" },
    ])
      expect(PlatformFactSchema.safeParse({ ...body, ...extra }).success).toBe(false);
  });
});

it("P5 逼近容量恰在批准比例触发，未知包含量不伪造", () => {
  const limit = 100;
  const edge = limit * OBS_CAPACITY_WARN_RATIO;
  expect(capacityWarning(edge - 1, limit)).toBe(false);
  expect(capacityWarning(edge, limit)).toBe(true);
  expect(capacityWarning(edge + 1, limit)).toBe(true);
  expect(capacityWarning(null, limit)).toBeNull();
  expect(capacityWarning(edge, null)).toBeNull();
});
