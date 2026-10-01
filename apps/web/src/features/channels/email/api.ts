import {
  type EmailChannelEnableFacts,
  type EmailConsentLayer,
  parseSubscriptionConfig,
  type SubscriptionConfig,
} from "@hoyo/contracts";
import { csrfToken } from "../../subscription/save/machine";

/** Only presentation facts consumed by this feature; enable rules stay in contracts. */
export interface EmailView extends EmailChannelEnableFacts {
  server_time: number;
  channel_revision: number;
  subscription: { revision: number; config: SubscriptionConfig | null };
  email: { masked: string; email_version: number };
  consent: Record<
    EmailConsentLayer,
    {
      version: number | null;
      enabled_at: number | null;
      last_event: { action: string; created_at: number } | null;
    }
  >;
  lease: {
    expires_at: number | null;
    last_renewed_at: number | null;
    last_renewed_reason: string | null;
    background_processing: string;
  };
  suppression_kind: string | null;
  service: { state: "normal" | "budget_limited" | "sending_paused" | "unknown" };
  disclosure: {
    consent_version: number;
    daily_limits: { seat: number; routine: number };
    lease_days: number;
    renewal: string;
    budget: string;
  };
}
export interface EmailUpdate {
  enabled?: boolean;
  routine_enabled?: boolean;
  expected_revision: number;
  email_version: number;
  subscription_revision: number;
  seat_consent_version?: number;
  routine_consent_version?: number;
}
export interface EmailResult {
  result: "completed" | "partial";
  state: EmailView;
  routine_error?: { code: "capacity_reached"; capability: "email_routine" };
}
export class EmailRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super("email_request_failed");
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("unknown_email_state");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("unknown_email_state");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("unknown_email_state");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("unknown_email_state");
  return value;
}
function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error("unknown_email_state");
  return value as T;
}
const nullableTime = (value: unknown) => (value === null ? null : integer(value));
const nullableText = (value: unknown) => (value === null ? null : text(value));

/** Missing/malformed facts never turn into an enabled or healthy channel. */
export function parseEmailView(value: unknown): EmailView {
  const row = record(value);
  const subscription = record(row.subscription);
  const state = member(row.subscription_state, ["initialized", "uninitialized"]);
  if (subscription.state !== state) throw new Error("unknown_email_state");
  const revision = integer(subscription.revision);
  const parsed =
    state === "initialized" ? parseSubscriptionConfig(state, subscription.config) : null;
  const config = parsed?.success ? parsed.data : null;
  if (
    state === "initialized"
      ? !config || config.revision !== revision
      : subscription.config !== null || revision !== 0
  )
    throw new Error("unknown_email_state");
  const email = record(row.email);
  const remaining = record(row.remaining);
  const consent = record(row.consent);
  const layer = (name: EmailConsentLayer) => {
    const item = record(consent[name]);
    const latest = item.last_event === null ? null : record(item.last_event);
    return {
      version: nullableTime(item.version),
      enabled_at: nullableTime(item.enabled_at),
      last_event: latest
        ? { action: text(latest.action), created_at: integer(latest.created_at) }
        : null,
    };
  };
  const lease = record(row.lease);
  const disclosure = record(row.disclosure);
  const limits = record(disclosure.daily_limits);
  return {
    server_time: integer(row.server_time),
    channel_revision: integer(row.channel_revision),
    session_state: member(row.session_state, ["active", "pending"]),
    recovery_code_required: bool(row.recovery_code_required),
    recovery_code_saved: bool(row.recovery_code_saved),
    subscription_state: state,
    subscription: { revision, config },
    deliverability: member(row.deliverability, ["deliverable", "suppressed", "unknown"]),
    enabled: bool(row.enabled),
    routine_enabled: bool(row.routine_enabled),
    remaining: {
      seat: remaining.seat === "unknown" ? "unknown" : integer(remaining.seat),
      routine: remaining.routine === "unknown" ? "unknown" : integer(remaining.routine),
    },
    email: { masked: text(email.masked), email_version: integer(email.email_version) },
    consent: { seat: layer("seat"), routine: layer("routine") },
    lease: {
      expires_at: nullableTime(lease.expires_at),
      last_renewed_at: nullableTime(lease.last_renewed_at),
      last_renewed_reason: nullableText(lease.last_renewed_reason),
      background_processing: text(lease.background_processing),
    },
    suppression_kind: nullableText(row.suppression_kind),
    service: {
      state: member(record(row.service).state, [
        "normal",
        "budget_limited",
        "sending_paused",
        "unknown",
      ]),
    },
    disclosure: {
      consent_version: integer(disclosure.consent_version),
      daily_limits: { seat: integer(limits.seat), routine: integer(limits.routine) },
      lease_days: integer(disclosure.lease_days),
      renewal: text(disclosure.renewal),
      budget: text(disclosure.budget),
    },
  };
}
async function request(update?: EmailUpdate): Promise<unknown> {
  const response = await fetch("/api/v2/me/email-channel", {
    method: update ? "PUT" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(update
      ? {
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken() ?? "" },
          body: JSON.stringify(update),
        }
      : {}),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new EmailRequestError(response.status, body);
  return body;
}
export async function readEmail(): Promise<EmailView> {
  return parseEmailView(await request());
}
export async function updateEmail(update: EmailUpdate): Promise<EmailResult> {
  const body = record(await request(update));
  const result = member(body.result, ["completed", "partial"]);
  if (result === "partial") {
    const error = record(body.routine_error);
    if (error.code !== "capacity_reached" || error.capability !== "email_routine")
      throw new Error("unknown_email_result");
    return {
      result,
      state: parseEmailView(body.state),
      routine_error: { code: "capacity_reached", capability: "email_routine" },
    };
  }
  return { result, state: parseEmailView(body.state) };
}
