// P3-07：D3 §2.6 草案；状态解释与运行参数只在 contracts 定义。
import { z } from "zod";
import { FEED_ACTIVITY_WRITE_INTERVAL, RECLAIM_TELEMETRY_STALE_HOURS } from "./params/registry";
export const calendarActionSchema = z.enum(["enable", "disable", "reset"]);
export type CalendarAction = z.infer<typeof calendarActionSchema>;
export const calendarMutationSchema = z
  .object({
    confirmed: z.literal(true),
    expected_generation: z.number().int().nonnegative().safe(),
  })
  .strict();
export const calendarEnableSchema = calendarMutationSchema.extend({
  expected_revision: z.int().positive(),
  publication_generation: z.int().positive(),
});
export function calendarOutputState(at: number | null, diagnostic: string | null) {
  return at === null
    ? "unknown"
    : diagnostic === "shrink_guard"
      ? "integrity_blocked"
      : diagnostic === null
        ? "normal"
        : "unavailable";
}
export function feedActivityCutoff(now: number): number {
  return now - FEED_ACTIVITY_WRITE_INTERVAL * 86_400_000;
}
export function feedActivityDue(last: number | null, now: number): boolean {
  return last === null || last <= feedActivityCutoff(now);
}

export function activityTelemetryStale(last: number | null, now: number): boolean {
  return last === null || last > now || last < now - RECLAIM_TELEMETRY_STALE_HOURS * 3_600_000;
}
export const calendarViewSchema = z.object({
  address_state: z.enum(["not_enabled", "enabled", "disabled"]),
  url: z.string().url().nullable(),
  token_generation: z.number().int().nonnegative(),
  configuration: z.object({
    state: z.enum(["uninitialized", "initialized"]),
    revision: z.number().int().nonnegative(),
    alarms_enabled: z.boolean().nullable(),
  }),
  output: z.object({
    state: z.enum(["unknown", "normal", "integrity_blocked", "unavailable"]),
    last_output_at: z.number().nullable(),
    diagnostic: z.string().nullable(),
    last_served_at: z.number().nullable(),
    last_served_node_count: z.number().nullable(),
    last_guard_blocked_at: z.number().nullable(),
  }),
  polling: z.object({
    last_feed_poll_at: z.number().nullable(),
    merge_interval_days: z.literal(FEED_ACTIVITY_WRITE_INTERVAL),
    meaning: z.literal("client_requested_address"),
  }),
});
export type CalendarView = z.infer<typeof calendarViewSchema>;

/** D3: presentation only; management API remains the authority. No recent OTP gate. */
export function deriveCalendarActions(facts: {
  session: { state: string; recovery_code_required: boolean };
  recovery_code_saved: boolean;
  subscription: { state: string };
}): Record<CalendarAction, import("./account-lifecycle").ActionAvailability> {
  const common =
    facts.session.state !== "active"
      ? { allowed: false as const, reason: "pending_activation" as const }
      : facts.session.recovery_code_required
        ? { allowed: false as const, reason: "recovery_code_unconfirmed" as const }
        : { allowed: true as const };
  const credential = !common.allowed
    ? common
    : !facts.recovery_code_saved
      ? { allowed: false as const, reason: "recovery_code_not_saved" as const }
      : common;
  return {
    disable: common,
    reset: credential,
    enable: !credential.allowed
      ? credential
      : facts.subscription.state !== "initialized"
        ? { allowed: false, reason: "subscription_uninitialized" }
        : credential,
  };
}
