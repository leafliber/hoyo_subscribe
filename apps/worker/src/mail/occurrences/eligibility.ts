// P6（ADR-0025）获准跨卡：兴趣匹配抽成与通道无关的 matchesSubscriptionInterest，邮件资格行为不变。
// P4-01 · 主方案 §5.3、§7.1：同一套匹配和发送前复核条件，按兴趣与通道各自生效时间判定。
import {
  changeNotificationScope,
  EMAIL_CONSENT_ENABLE_ACTION,
  type EventType,
  type GameId,
  getReminderRule,
  isWithinChangeNotificationScope,
  parseSubscriptionConfig,
  type RegionId,
  SUBSCRIPTION_SCHEMA_VERSION,
} from "@hoyo/contracts";

export interface OccurrenceMatch {
  id: string;
  milestone_id: string;
  schedule_revision: number;
  kind: string;
  due_at: number;
  expires_at: number;
  invalidated_at: number | null;
  event_id: string;
  game: GameId;
  region: RegionId;
  event_type: EventType;
  event_status: string;
  current_schedule_revision: number;
}

export interface AudienceRow {
  id: string;
  user_order: number;
  status: string;
  email_binding_id: string;
  email_version: number;
  subscription_state: string | null;
  subscription_revision: number | null;
  scope_json: string | null;
  calendar_json: string | null;
  notifications_json: string | null;
  channel_enabled: number | null;
  routine_enabled: number | null;
  channel_address_version: number | null;
  lease_expires_at: number | null;
  seat_enabled_at: number | null;
  routine_enabled_at: number | null;
  suppressed: number;
}

export const AUDIENCE_SELECT = `SELECT u.id, u."order" AS user_order, u.status, u.email_binding_id, u.email_version,
  s.state AS subscription_state, s.revision AS subscription_revision, s.scope_json, s.calendar_json, s.notifications_json,
  c.enabled AS channel_enabled, c.routine_enabled, c.address_version AS channel_address_version, c.lease_expires_at,
  (SELECT MAX(ce.created_at) FROM consent_events ce WHERE ce.user_id = u.id AND ce.email_binding_id = u.email_binding_id AND ce.layer = 'seat' AND ce.action = '${EMAIL_CONSENT_ENABLE_ACTION}') AS seat_enabled_at,
  (SELECT MAX(ce.created_at) FROM consent_events ce WHERE ce.user_id = u.id AND ce.email_binding_id = u.email_binding_id AND ce.layer = 'routine' AND ce.action = '${EMAIL_CONSENT_ENABLE_ACTION}') AS routine_enabled_at,
  EXISTS (SELECT 1 FROM suppressions x WHERE x.email_binding_id = u.email_binding_id AND (x.expires_at IS NULL OR x.expires_at > ?)) AS suppressed
  FROM users u LEFT JOIN user_subscriptions s ON s.user_id = u.id LEFT JOIN email_channels c ON c.user_id = u.id`;

export function occurrenceRuleId(kind: string): string | null {
  if (kind.startsWith("late_discovery:")) return kind.slice("late_discovery:".length);
  return getReminderRule(kind) === undefined ? null : kind;
}

export function occurrenceDeliveryKind(kind: string): string {
  if (kind.startsWith("late_discovery:")) return "late_discovery";
  return getReminderRule(kind) === undefined ? kind : "rule";
}

export function occurrencePriority(kind: string): number {
  const deliveryKind = occurrenceDeliveryKind(kind);
  switch (deliveryKind) {
    case "cancelled_or_retracted":
      return 1;
    case "important_change":
      return 2;
    case "late_discovery":
      return 3;
    case "rule":
      return 4;
    case "new_event":
      return 5;
    default:
      throw new Error(`未知发生项类型：${kind}`);
  }
}

function hasInterest(
  interests: readonly { interest_kind: string; interest_id: string; enabled_at: number }[],
  kind: string,
  id: string,
  anchor: number,
): boolean {
  return interests.some(
    (interest) =>
      interest.interest_kind === kind &&
      interest.interest_id === id &&
      interest.enabled_at <= anchor,
  );
}

/** 已保存订阅的兴趣事实（与通道无关）；P6 的 Push 资格与邮件共用同一匹配。 */
export interface SubscriptionInterestFacts {
  subscription_state: string | null;
  subscription_revision: number | null;
  scope_json: string | null;
  calendar_json: string | null;
  notifications_json: string | null;
}

/** latest consent_event 作为该层本轮同意的生效时间；P4-05 负责写入动作语义。 */
export function isEmailAudienceEligible(
  occurrence: OccurrenceMatch,
  audience: AudienceRow,
  interests: readonly { interest_kind: string; interest_id: string; enabled_at: number }[],
  nowMs: number,
): boolean {
  if (
    audience.status !== "active" ||
    audience.subscription_state !== "initialized" ||
    audience.channel_enabled !== 1 ||
    audience.channel_address_version !== audience.email_version ||
    audience.lease_expires_at === null ||
    audience.lease_expires_at <= nowMs ||
    audience.suppressed !== 0 ||
    occurrence.invalidated_at !== null ||
    occurrence.current_schedule_revision !== occurrence.schedule_revision ||
    occurrence.expires_at <= nowMs
  )
    return false;
  const anchor = occurrence.due_at;
  const kind = occurrenceDeliveryKind(occurrence.kind);
  const routine = kind === "rule" || kind === "new_event";
  if (
    audience.seat_enabled_at === null ||
    audience.seat_enabled_at > anchor ||
    (routine &&
      (audience.routine_enabled !== 1 ||
        audience.routine_enabled_at === null ||
        audience.routine_enabled_at > anchor))
  )
    return false;
  return matchesSubscriptionInterest(occurrence, audience, interests);
}

/**
 * 兴趣匹配（§5.3、§7.1）：已保存订阅、范围、规则或变更开关在 due_at 前已生效。
 * 只判断"通知什么"，不判断通道；通道各自的生效时间与可用性由调用方先判断。
 */
export function matchesSubscriptionInterest(
  occurrence: OccurrenceMatch,
  audience: SubscriptionInterestFacts,
  interests: readonly { interest_kind: string; interest_id: string; enabled_at: number }[],
): boolean {
  if (audience.subscription_state !== "initialized") return false;
  if (
    audience.scope_json === null ||
    audience.calendar_json === null ||
    audience.notifications_json === null
  )
    return false;
  const config = parseSubscriptionConfig("initialized", {
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    revision: audience.subscription_revision,
    scope: JSON.parse(audience.scope_json),
    calendar: JSON.parse(audience.calendar_json),
    notifications: JSON.parse(audience.notifications_json),
  });
  if (!config.success) return false;
  const anchor = occurrence.due_at;
  const kind = occurrenceDeliveryKind(occurrence.kind);
  if (
    !config.data.scope.games.includes(occurrence.game) ||
    !config.data.scope.regions.includes(occurrence.region)
  )
    return false;
  const ruleId = occurrenceRuleId(occurrence.kind);
  if (kind === "rule" || kind === "late_discovery") {
    const rule = ruleId === null ? undefined : getReminderRule(ruleId);
    if (
      rule === undefined ||
      rule.event_type !== occurrence.event_type ||
      !hasInterest(interests, "rule", rule.rule_id, anchor)
    )
      return false;
    if (kind === "rule") return true;
    return (
      config.data.notifications.late_discovery &&
      hasInterest(interests, "change_switch", "late_discovery", anchor) &&
      isWithinChangeNotificationScope(changeNotificationScope(config.data), occurrence)
    );
  }
  if (kind !== "new_event" && kind !== "important_change" && kind !== "cancelled_or_retracted")
    return false;
  return (
    config.data.notifications[kind] &&
    hasInterest(interests, "change_switch", kind, anchor) &&
    isWithinChangeNotificationScope(changeNotificationScope(config.data), occurrence)
  );
}

export async function loadInterests(
  db: D1Database,
  userId: string,
  game: string,
  region: string,
): Promise<{ interest_kind: string; interest_id: string; enabled_at: number }[]> {
  return (
    (
      await db
        .prepare(`SELECT interest_kind,interest_id,enabled_at FROM subscription_interests
    WHERE user_id = ? AND game = ? AND region = ?`)
        .bind(userId, game, region)
        .all<{ interest_kind: string; interest_id: string; enabled_at: number }>()
    ).results ?? []
  );
}

export const OCCURRENCE_SELECT = `SELECT o.id,o.milestone_id,o.schedule_revision,o.kind,o.due_at,o.expires_at,o.invalidated_at,
  e.id AS event_id,e.game,e.region,e.event_type,e.status AS event_status,e.schedule_revision AS current_schedule_revision
  FROM occurrences o JOIN events e ON e.id = o.event_id`;
