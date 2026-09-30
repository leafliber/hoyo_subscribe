import { parseSubscriptionConfig, type SubscriptionConfig } from "@hoyo/contracts";
import type { Draft } from "../save/machine";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_preferences");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("invalid_preferences");
}

/** 数据形状和枚举只由 contracts 校验；本机中间草稿允许暂时清空必选项。 */
export function localDraft(value: unknown): Draft {
  const input = record(value);
  keys(input, ["schema_version", "scope", "calendar", "notifications"]);
  const parsed = parseSubscriptionConfig("uninitialized", { ...input, revision: 1 });
  if (!parsed.success) throw new Error("invalid_preferences");
  const { revision: _revision, ...draft } = parsed.data;
  return draft;
}

/** 与 P2-07 导出兼容；空账号不制造默认设置，版本不作为本机保存的 CAS 基线。 */
export function importPreferences(text: string): Draft | null {
  const input = record(JSON.parse(text));
  keys(input, ["format", "subscription"]);
  if (input.format !== "hoyo-preferences") throw new Error("invalid_preferences");
  const subscription = record(input.subscription);
  keys(subscription, ["state", "config"]);
  if (subscription.state === "uninitialized" && subscription.config === null) return null;
  if (subscription.state !== "initialized") throw new Error("invalid_preferences");
  const parsed = parseSubscriptionConfig("initialized", subscription.config);
  if (!parsed.success) throw new Error("invalid_preferences");
  const { revision: _revision, ...draft } = parsed.data;
  return draft;
}

/** 显式白名单投影；即使调用者传入额外字段也不会导出秘密或通道同意。 */
export function exportPreferences(value: Draft): string {
  const config: SubscriptionConfig = {
    schema_version: value.schema_version,
    revision: 1,
    scope: { games: value.scope.games, regions: value.scope.regions },
    calendar: {
      event_types: value.calendar.event_types,
      node_types: value.calendar.node_types,
      alarms_enabled: value.calendar.alarms_enabled,
    },
    notifications: {
      rule_ids: value.notifications.rule_ids,
      new_event: value.notifications.new_event,
      important_change: value.notifications.important_change,
      cancelled_or_retracted: value.notifications.cancelled_or_retracted,
      late_discovery: value.notifications.late_discovery,
    },
  };
  const parsed = parseSubscriptionConfig("initialized", config);
  if (!parsed.success) throw new Error("invalid_preferences");
  return JSON.stringify(
    { format: "hoyo-preferences", subscription: { state: "initialized", config: parsed.data } },
    null,
    2,
  );
}
