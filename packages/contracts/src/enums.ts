// 全部业务枚举的唯一运行时定义源。
// 来源：主方案 §3.3（Event / Milestone 合同）、§4.4/§5.1（订阅行状态）、§4.5（会话状态）、
// §7.4（发送状态）；清单与 docs/CONTRACTS_BASELINE.md §1 逐条对应。
// 约束（AGENTS.md 第 2 节硬规则 3）：Worker 与 Web 共同消费本文件，任何消费方不得按中文标签
// 反推规则，不得另写第二份枚举定义。新增取值属于合同变更，须先改主方案再改这里。
import { z } from "zod";

/** 逐个枚举提供：`as const` 元组（运行时清单）、TS 联合类型、Zod schema。 */
const enumSchema = <const T extends readonly string[]>(values: T) => z.enum(values);

// 主方案 §3.3：事件类型。
export const EVENT_TYPES = ["livestream", "maintenance", "limited_event", "gacha"] as const;
/** 事件类型（主方案 §3.3）。 */
export type EventType = (typeof EVENT_TYPES)[number];

// 主方案 §3.3：节点类型；同类阶段用稳定 milestone_key 区分（milestone_key 不在本枚举内）。
export const NODE_TYPES = [
  "start",
  "end",
  "phase_unlock",
  "reward_deadline",
  "expected_end",
  "actual_end",
] as const;
/** 节点类型（主方案 §3.3）。 */
export type NodeType = (typeof NODE_TYPES)[number];

// 主方案 §3.3：审核状态（候选三路发布路径的统一审核状态）。
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
/** 审核状态（主方案 §3.3）。 */
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// 主方案 §3.3：事件状态。retracted 表示本站纠错撤回，不是官方取消。
export const EVENT_STATUSES = ["scheduled", "postponed", "cancelled", "retracted"] as const;
/** 事件状态（主方案 §3.3；`retracted` = 本站纠错，**不是**官方取消）。 */
export type EventStatus = (typeof EVENT_STATUSES)[number];

// 主方案 §3.3：时间依据。只有 official_explicit 与 deterministic_derived 可用于提醒。
export const TIME_BASES = [
  "official_explicit",
  "deterministic_derived",
  "official_estimate",
  "unresolved",
] as const;
/**
 * 时间依据（主方案 §3.3）。
 * 只有精确、证据通过的明确时间（official_explicit）或确定性推导（deterministic_derived）
 * 可用于提醒；预计与未知时间可在 Web 标注但不冒充精确提醒。
 */
export type TimeBasis = (typeof TIME_BASES)[number];

// 主方案 §3.3：时间精度。
export const TIME_PRECISIONS = ["datetime", "date", "unknown"] as const;
/** 时间精度（主方案 §3.3）。 */
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

// 主方案 §4.4、§5.1：订阅行状态。uninitialized → initialized 单向，不可退回。
export const SUBSCRIPTION_STATES = ["uninitialized", "initialized"] as const;
/** 订阅行状态（主方案 §4.4、§5.1；单向 uninitialized → initialized）。 */
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

// 主方案 §4.5：会话状态。pending 不计入 active 名额。
export const SESSION_STATUSES = ["pending", "active", "revoked"] as const;
/** 会话状态（主方案 §4.5）。 */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// 主方案 §7.4：发送状态。`accepted` 只表示收件服务器接受，不是已送达或已读。
export const DELIVERY_STATUSES = [
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
] as const;
/** 发送状态（主方案 §7.4；`accepted` ≠ 已送达/已读）。 */
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// 附录 A.1 SUPPORTED_SCOPE：仅开放验证通过的来源类别（genshin / hsr / zzz；CN）。
// 创建账号时保存具体选择，不自动加入未来游戏；新增游戏属于合同变更（先改附录 A 再改这里）。
// 注意：这是 SUPPORTED_SCOPE 的唯一代码定义；P1-03 参数注册表引用本定义，不得复制第二份。
export const SUPPORTED_SCOPE_GAMES = ["genshin", "hsr", "zzz"] as const;
/** scope 可选游戏（附录 A.1 SUPPORTED_SCOPE）。 */
export type GameId = (typeof SUPPORTED_SCOPE_GAMES)[number];

export const SUPPORTED_SCOPE_REGIONS = ["CN"] as const;
/** scope 可选区域（附录 A.1 SUPPORTED_SCOPE）。 */
export type RegionId = (typeof SUPPORTED_SCOPE_REGIONS)[number];

// Zod schema 集中导出（与上方元组同源，不重复写字面量）。
export const EventTypeSchema = enumSchema(EVENT_TYPES);
export const NodeTypeSchema = enumSchema(NODE_TYPES);
export const ReviewStatusSchema = enumSchema(REVIEW_STATUSES);
export const EventStatusSchema = enumSchema(EVENT_STATUSES);
export const TimeBasisSchema = enumSchema(TIME_BASES);
export const TimePrecisionSchema = enumSchema(TIME_PRECISIONS);
export const SubscriptionStateSchema = enumSchema(SUBSCRIPTION_STATES);
export const SessionStatusSchema = enumSchema(SESSION_STATUSES);
export const DeliveryStatusSchema = enumSchema(DELIVERY_STATUSES);
export const GameIdSchema = enumSchema(SUPPORTED_SCOPE_GAMES);
export const RegionIdSchema = enumSchema(SUPPORTED_SCOPE_REGIONS);
