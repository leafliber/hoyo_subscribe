// P4-07：Cloudflare R06 / P0-05 的 Queue 边界；只投影所需字段，不留原文。
import { API_BODY_MAX_BYTES, canonicalizeEmail } from "@hoyo/contracts";
import { deliveryAddressForm } from "../../auth/challenges/delivery";
import type { recordMailReceipt } from "../outbox/state";

export const FEEDBACK_QUEUE = "hoyo-mail-events";
export const FEEDBACK_DLQ = "hoyo-mail-events-dlq";
export type Receipt = Parameters<typeof recordMailReceipt>[2];
export interface FeedbackTrust {
  accountId: string;
  subscriptions: readonly { id: string; domain: string }[];
}
// 只定义供应商边界的名称映射，内部回执语义沿用 P4-03 的类型。
const eventTypes: Record<Receipt, string> = {
  delivered: "cf.email.sending.message.delivered",
  deferred: "cf.email.sending.message.deferred",
  bounced: "cf.email.sending.message.bounced",
  failed: "cf.email.sending.message.failed",
  complained: "cf.email.sending.message.complained",
  rejected: "cf.email.sending.message.rejected",
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("feedback_schema");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value))
    throw new Error("feedback_schema");
  return value;
}
function address(value: unknown): string {
  const v = identifier(value);
  if (!canonicalizeEmail(v).ok) throw new Error("feedback_schema");
  return deliveryAddressForm(v);
}
export function parseFeedback(body: unknown, trust: FeedbackTrust) {
  // 复用现有受控输入上限；不自创 FEEDBACK_MAX_BYTES。超限仍重试至平台 DLQ。
  const json = typeof body === "string" ? body : JSON.stringify(body);
  if (!json || new TextEncoder().encode(json).byteLength > API_BODY_MAX_BYTES)
    throw new Error("feedback_size");
  const event = object(JSON.parse(json));
  const source = object(event.source),
    metadata = object(event.metadata),
    payload = object(event.payload);
  const delivery = object(payload.delivery);
  const rawReceipt = identifier(delivery.status);
  if (!Object.hasOwn(eventTypes, rawReceipt)) throw new Error("feedback_schema");
  const receipt = rawReceipt as Receipt;
  const sender = address(payload.sender),
    recipient = address(payload.recipient);
  const eventId = identifier(payload.eventId),
    messageId = identifier(payload.messageId);
  const timestamp = identifier(metadata.eventTimestamp);
  const at = Date.parse(timestamp);
  const bounce = payload.bounce === undefined ? undefined : object(payload.bounce);
  const rejection = payload.rejection === undefined ? undefined : object(payload.rejection);
  if (
    bounce &&
    ((bounce.type !== "hard" && bounce.type !== "soft") || !identifier(bounce.classification))
  )
    throw new Error("feedback_schema");
  if (rejection) identifier(rejection.reason);
  if (
    !trust.accountId ||
    metadata.accountId !== trust.accountId ||
    metadata.eventSchemaVersion !== 1 ||
    source.type !== "email.sending" ||
    !identifier(source.zoneId) ||
    !Number.isFinite(at) ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    (payload.subject !== undefined && typeof payload.subject !== "string") ||
    !trust.subscriptions.some(
      (s) => s.id === metadata.eventSubscriptionId && s.domain === source.domain,
    ) ||
    sender.slice(sender.lastIndexOf("@") + 1) !== source.domain ||
    event.type !== eventTypes[receipt] ||
    payload.terminal !== (receipt !== "deferred") ||
    (receipt === "bounced" && !bounce)
  )
    throw new Error("feedback_envelope");
  return {
    eventId: eventId,
    messageId: messageId,
    receipt,
    at: at,
    recipient: recipient,
    // deferred 可以带 soft bounce；只按终态处理。普通 failed/rejected 不推断为地址抑制。
    suppression:
      receipt === "complained"
        ? ("complaint" as const)
        : receipt === "bounced" && bounce?.type === "hard"
          ? ("hard_bounce" as const)
          : receipt === "rejected" && rejection?.reason === "suppressed"
            ? ("policy" as const)
            : null,
  };
}
export type Feedback = ReturnType<typeof parseFeedback>;
