import { describe, expect, it } from "vitest";
import {
  DELIVERY_STATUSES,
  DeliveryStatusSchema,
  EVENT_STATUSES,
  EVENT_TYPES,
  EventStatusSchema,
  EventTypeSchema,
  GameIdSchema,
  NODE_TYPES,
  NodeTypeSchema,
  REVIEW_STATUSES,
  RegionIdSchema,
  ReviewStatusSchema,
  SESSION_STATUSES,
  SessionStatusSchema,
  SUBSCRIPTION_STATES,
  SUPPORTED_SCOPE_GAMES,
  SUPPORTED_SCOPE_REGIONS,
  SubscriptionStateSchema,
  TIME_BASES,
  TIME_PRECISIONS,
  TimeBasisSchema,
  TimePrecisionSchema,
} from "./enums";

// 合同清单的独立抄本：主方案 §3.3 与附录 A.1 SUPPORTED_SCOPE。测试用它钉住代码里的枚举
// 不漂移；两处不一致即失败（这是验证层，不是第二份运行时定义）。
describe("A-P1-CONTRACT 枚举完整性（主方案 §3.3）", () => {
  it("事件类型、节点类型、审核状态、事件状态与合同一致", () => {
    expect([...EVENT_TYPES]).toEqual(["livestream", "maintenance", "limited_event", "gacha"]);
    expect([...NODE_TYPES]).toEqual([
      "start",
      "end",
      "phase_unlock",
      "reward_deadline",
      "expected_end",
      "actual_end",
    ]);
    expect([...REVIEW_STATUSES]).toEqual(["pending", "approved", "rejected"]);
    expect([...EVENT_STATUSES]).toEqual(["scheduled", "postponed", "cancelled", "retracted"]);
  });

  it("时间依据与时间精度和合同一致", () => {
    expect([...TIME_BASES]).toEqual([
      "official_explicit",
      "deterministic_derived",
      "official_estimate",
      "unresolved",
    ]);
    expect([...TIME_PRECISIONS]).toEqual(["datetime", "date", "unknown"]);
  });

  it("订阅行状态、会话状态、发送状态和合同一致", () => {
    expect([...SUBSCRIPTION_STATES]).toEqual(["uninitialized", "initialized"]);
    expect([...SESSION_STATUSES]).toEqual(["pending", "active", "revoked"]);
    expect([...DELIVERY_STATUSES]).toEqual([
      "pending",
      "leased",
      "calling_provider",
      "accepted",
      "retry_wait",
      "unknown",
      "deferred",
      "bounced",
      "failed",
      "complained",
      "rejected",
      "skipped",
      "superseded",
      "expired",
    ]);
  });

  it("scope 的游戏与区域和附录 A.1 SUPPORTED_SCOPE 一致", () => {
    expect([...SUPPORTED_SCOPE_GAMES]).toEqual(["genshin", "hsr", "zzz"]);
    expect([...SUPPORTED_SCOPE_REGIONS]).toEqual(["CN"]);
  });

  it("全部 Zod schema 拒绝未知取值", () => {
    const schemas = [
      EventTypeSchema,
      NodeTypeSchema,
      ReviewStatusSchema,
      EventStatusSchema,
      TimeBasisSchema,
      TimePrecisionSchema,
      SubscriptionStateSchema,
      SessionStatusSchema,
      DeliveryStatusSchema,
      GameIdSchema,
      RegionIdSchema,
    ];
    for (const schema of schemas) {
      expect(schema.safeParse("not_a_real_value").success).toBe(false);
      expect(schema.safeParse(1).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    }
  });
});
