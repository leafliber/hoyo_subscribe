import { z } from "zod";
import {
  authTotalOccupancy,
  dayRemaining,
  floorIsEngaged,
  type MailDayLedgerSnapshot,
  poolDayLimit,
} from "../budget/pools";
import {
  API_BODY_MAX_BYTES,
  MAIL_AUTH_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_URGENT_FLOOR,
  OBS_CAPACITY_WARN_RATIO,
} from "../params/registry";

export const OPERATIONAL_CONTROLS = [
  "registration_open",
  "mail_sending_available",
  "outbound_enabled",
  "email_seats_open",
  "email_routine_enabled",
  "business_mail_enabled",
  "push_enabled",
  "model_enabled",
  "automatic_publication_enabled",
  // P3-25（ADR-0018）：AI 草稿通过全部检查后由系统批准、免人工审核；默认关闭（没有这一行即关闭）。
  "review_skip_enabled",
  "account_reclaim_enabled",
  "seat_reclaim_enabled",
  "read_only",
  "calendar_enabled",
  "source_enabled",
] as const;
export const OperationalControlSchema = z.enum(OPERATIONAL_CONTROLS);
export type OperationalControl = z.infer<typeof OperationalControlSchema>;
/**
 * 首次部署之后才加的开关没有初始化行：查询成功但没有这一行时按这里的默认值读（P3-25）。
 * 默认值只能是 false——不能借默认值打开任何能力；读取出错仍是 unknown。
 * 管理端据此显示"关"并允许以版本 0 写入第一行（服务端条件写入挡住覆盖已有行）。
 */
export const OPERATIONAL_CONTROL_DEFAULTS: Readonly<Partial<Record<OperationalControl, false>>> = {
  review_skip_enabled: false,
};
export type ControlFact = boolean | "unknown";
export type ControlFacts = Partial<Record<OperationalControl, ControlFact>>;
export const OperationalReasonSchema = z.enum([
  "maintenance",
  "incident_containment",
  "verified_configuration",
  "evidence_reviewed",
  "initial_deployment",
]);
export const ControlWriteSchema = z.strictObject({
  control: OperationalControlSchema,
  enabled: z.boolean(),
  source: z.string().min(1).max(API_BODY_MAX_BYTES).optional(),
  expected_updated_at: z.int().nonnegative(),
  reason: OperationalReasonSchema,
});
export const OBS_METRICS = [
  "feed_shrink_guard",
  "source_response_truncated",
  "snapshot_build_failed",
  "mail_provider_unknown",
  "mail_call",
  "mail_delivery_items",
  "seat_renewed",
  "seat_released",
  "unsubscribe_latency_ms",
  "delivery_budget_failed",
  "delivery_dispatch_failed",
  "feedback_maintenance_failed",
  "dispatch_budget_skipped",
] as const;
export const ObsMetricSchema = z.enum(OBS_METRICS);
export type ObsMetric = z.infer<typeof ObsMetricSchema>;
export const PLATFORM_METRICS = [
  "worker_cpu_ms",
  "worker_requests",
  "d1_rows_read",
  "d1_rows_written",
  "d1_storage_bytes",
  "do_requests",
  "do_duration_gb_seconds",
  "do_storage_bytes",
  "queue_operations",
  "queue_dlq_backlog",
  "bill_extra_charge",
] as const;
export const PlatformMetricSchema = z.enum(PLATFORM_METRICS);
export const PlatformFactSchema = z
  .strictObject({
    metric: PlatformMetricSchema,
    value: z.number().finite().nonnegative(),
    included: z.number().finite().positive().optional(),
    observed_at: z.int().nonnegative(),
    period_start: z.int().nonnegative(),
    period_end: z.int().positive(),
    reason: OperationalReasonSchema,
  })
  .refine((v) => v.period_start <= v.observed_at && v.observed_at < v.period_end);
export function controlFact(value: unknown): ControlFact {
  return typeof value === "boolean" ? value : "unknown";
}
export function capabilityFact(
  ...facts: (ControlFact | undefined)[]
): "open" | "closed" | "unknown" {
  if (facts.includes(false)) return "closed";
  return facts.every((v) => v === true) ? "open" : "unknown";
}
export function publicOperationalCapabilities(facts: ControlFacts) {
  const writable =
    facts.read_only === "unknown" || facts.read_only === undefined ? "unknown" : !facts.read_only;
  return {
    calendar: capabilityFact(facts.calendar_enabled, writable),
    email_seats: capabilityFact(facts.email_seats_open, writable),
    routine_email: capabilityFact(
      facts.email_routine_enabled,
      facts.business_mail_enabled,
      facts.outbound_enabled,
      facts.mail_sending_available,
      writable,
    ),
    push: capabilityFact(facts.push_enabled, facts.outbound_enabled, "unknown", writable),
  };
}
export function observedMailPools(ledger: MailDayLedgerSnapshot) {
  const auth = dayRemaining(MAIL_AUTH_DAY, authTotalOccupancy(ledger.pools));
  const base = dayRemaining(poolDayLimit("base_business"), ledger.pools.base_business);
  const urgent = dayRemaining(poolDayLimit("urgent_business"), ledger.pools.urgent_business);
  return {
    auth: { remaining: auth, floor_engaged: floorIsEngaged(auth, MAIL_AUTH_FLOOR) },
    signup: {
      remaining: Math.min(
        auth,
        dayRemaining(poolDayLimit("new_registration"), ledger.pools.new_registration),
      ),
    },
    base: { remaining: base },
    urgent: { remaining: urgent, floor_engaged: floorIsEngaged(urgent, MAIL_URGENT_FLOOR) },
  };
}
export function observedRatio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}

export const OBS_DELIVERY_REASONS = [
  "eligibility_lost",
  "schedule_revision_changed",
  "notification_expired",
  "higher_priority_same_node",
  "preflight_skipped",
  "preflight_superseded",
  "preflight_expired",
  "retry_budget_not_scheduled",
] as const;
/** 无新的业务质量阈值：仅检查数学不变量，缺失留 unknown。 */
export function ratioIntegrityAlert(
  numerator: number | null,
  denominator: number | null,
): boolean | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator < denominator;
}

// 反馈无身份累计计数键白名单，不向观测接口透传任意 system_state key。
export const OBS_FEEDBACK_KINDS = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "complained",
  "rejected",
] as const;

/** 缺少真实包含量不推断平台容量。 */
export function capacityWarning(value: number | null, included: number | null): boolean | null {
  return value === null ||
    included === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(included) ||
    value < 0 ||
    included <= 0
    ? null
    : value >= included * OBS_CAPACITY_WARN_RATIO;
}
