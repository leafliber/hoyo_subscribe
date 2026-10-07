// P4-05 · §7.5 / §9.4 / D3：邮件通道的共享语义，不包含数据库或浏览器依赖。
import { decideMailIntent } from "./budget/decision";
import type { MailDayLedgerSnapshot } from "./budget/pools";
import { buildApiErrorBody } from "./errors/codes";
import { MAIL_SEAT_LEASE } from "./params/registry";

/** 同意文案/结构版本，不是可调运行参数；变更说明内容时显式升级。 */
export const EMAIL_CONSENT_VERSION = 1;
export const EMAIL_CONSENT_ENABLE_ACTION = "enable";
export const EMAIL_CONSENT_DISABLE_ACTION = "disable";
export type EmailConsentLayer = "seat" | "routine";
export type EmailChannelBlockReason =
  | "pending_activation"
  | "recovery_code_unconfirmed"
  | "subscription_uninitialized"
  | "address_suppressed"
  | "deliverability_unknown"
  | "seat_required"
  | "capacity_full"
  | "capacity_unknown";
export interface EmailChannelEnableFacts {
  session_state: "active" | "pending";
  recovery_code_required: boolean;
  subscription_state: "initialized" | "uninitialized";
  deliverability: "deliverable" | "suppressed" | "unknown";
  enabled: boolean;
  routine_enabled: boolean;
  remaining: { seat: number | "unknown"; routine: number | "unknown" };
}
export type EmailChannelActionAvailability =
  | { allowed: true }
  | { allowed: false; reason: EmailChannelBlockReason };
/**
 * 浏览器可用此函数置灰；服务器写入复用，再以 SQL 条件守卫核对实时状态。
 * ADR-0026：恢复码改为可选，不再是开启邮件的前置；恢复登录的受限会话仍不能开启。
 */
export function emailChannelEnableAvailability(
  facts: EmailChannelEnableFacts,
  layer: EmailConsentLayer,
): EmailChannelActionAvailability {
  if (facts.session_state === "pending") return { allowed: false, reason: "pending_activation" };
  if (facts.recovery_code_required) return { allowed: false, reason: "recovery_code_unconfirmed" };
  if (facts.subscription_state !== "initialized")
    return { allowed: false, reason: "subscription_uninitialized" };
  if (facts.deliverability === "suppressed")
    return { allowed: false, reason: "address_suppressed" };
  if (facts.deliverability === "unknown")
    return { allowed: false, reason: "deliverability_unknown" };
  if (layer === "routine" && !facts.enabled) return { allowed: false, reason: "seat_required" };
  const alreadyEnabled = layer === "seat" ? facts.enabled : facts.routine_enabled;
  if (!alreadyEnabled) {
    const remaining = facts.remaining[layer];
    if (remaining === "unknown") return { allowed: false, reason: "capacity_unknown" };
    if (remaining <= 0) return { allowed: false, reason: "capacity_full" };
  }
  return { allowed: true };
}

export interface EmailActivityFacts {
  last_interactive_at: number | null;
  last_feed_poll_at: number | null;
  last_push_processed_at: number | null;
}
export function emailSeatLeaseExpiresAt(start: number): number {
  return start + MAIL_SEAT_LEASE * 24 * 60 * 60 * 1_000;
}
/** 只允许三种账号水位，发送/投递/页面读取都不属于输入。 */
export function emailSeatRenewal(
  activity: EmailActivityFacts,
  current: { enabled: boolean; last_renewed_at: number | null; lease_expires_at: number | null },
  now: number,
): { lease_expires_at: number; reason: keyof EmailActivityFacts } | null {
  if (!current.enabled) return null;
  const fields = ["last_interactive_at", "last_feed_poll_at", "last_push_processed_at"] as const;
  let latest: { at: number; reason: keyof EmailActivityFacts } | null = null;
  for (const reason of fields) {
    const at = activity[reason];
    if (at !== null && (latest === null || at > latest.at)) latest = { at, reason };
  }
  if (latest === null || latest.at > now || latest.at <= (current.last_renewed_at ?? -1))
    return null;
  const expires = emailSeatLeaseExpiresAt(latest.at);
  if (expires <= now || expires <= (current.lease_expires_at ?? -1)) return null;
  return { lease_expires_at: expires, reason: latest.reason };
}

export function emailChannelServiceState(
  sending: boolean | "unknown",
  ledger: MailDayLedgerSnapshot | null,
): "normal" | "budget_limited" | "sending_paused" | "unknown" {
  if (sending === false) return "sending_paused";
  if (sending === "unknown" || ledger === null) return "unknown";
  return (
    [
      "urgent_cancelled_or_retracted",
      "urgent_important_change",
      "urgent_late_discovery",
      "base_routine_or_announce",
    ] as const
  ).some((kind) => decideMailIntent(kind, ledger).decision === "reject")
    ? "budget_limited"
    : "normal";
}

/** 写入拒绝保留相同的闭合原因；七类错误本体仍由全站错误模型构造。 */
export function emailChannelRefusal(reason: EmailChannelBlockReason, layer: EmailConsentLayer) {
  const body = (() => {
    if (reason === "pending_activation" || reason === "recovery_code_unconfirmed")
      return buildApiErrorBody("unauthorized", { code: "unauthorized", reason });
    if (reason === "capacity_full")
      return buildApiErrorBody("capacity_reached", {
        code: "capacity_reached",
        capability: layer === "seat" ? "email_seat" : "email_routine",
      });
    if (reason === "capacity_unknown" || reason === "deliverability_unknown")
      return buildApiErrorBody("temporarily_unavailable", { code: "temporarily_unavailable" });
    if (reason === "address_suppressed")
      return buildApiErrorBody("quota_paused", { code: "quota_paused", scope: reason });
    return buildApiErrorBody("validation", {
      code: "validation",
      fields: [{ path: layer, reason }],
    });
  })();
  return { ...body, blocked_reason: reason };
}
