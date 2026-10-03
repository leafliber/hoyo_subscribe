import {
  type AccountSummary,
  type CalendarPreviewResponse,
  type CalendarView,
  ExactTimeValueSchema,
  explainCalendarPreview,
  FEED_ACTIVITY_WRITE_INTERVAL,
  feedWindow,
  SUBSCRIPTION_SCHEMA_VERSION,
  type SubscriptionConfig,
} from "@hoyo/contracts";
export const now = Date.UTC(2026, 9, 3);
export const syntheticConfig: SubscriptionConfig = {
  schema_version: SUBSCRIPTION_SCHEMA_VERSION,
  revision: 4,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["livestream"], node_types: ["start"], alarms_enabled: true },
  notifications: {
    rule_ids: ["limited_end_1d"],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  },
};
export function syntheticAccount(_config = syntheticConfig): AccountSummary {
  return {
    user_id: "synthetic-account-a",
    server_time: now,
    email: { masked: "s***@example.invalid", email_version: 1 },
    recovery_code_saved: true,
    recovery_code_generation: 1,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: now + 100000,
      absolute_expires_at: now + 200000,
      recovery_code_required: false,
      recovery_login_at: null,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "unknown" },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: { email_change: null, recovery_code_rotate: null, account_delete: null },
  };
}
export function syntheticView(config = syntheticConfig): CalendarView {
  return {
    address_state: "not_enabled",
    url: null,
    token_generation: 7,
    configuration: {
      state: "initialized",
      revision: config.revision,
      alarms_enabled: config.calendar.alarms_enabled,
    },
    output: {
      state: "unknown",
      last_output_at: null,
      diagnostic: null,
      last_served_at: null,
      last_served_node_count: null,
      last_guard_blocked_at: null,
    },
    polling: {
      last_feed_poll_at: null,
      merge_interval_days: FEED_ACTIVITY_WRITE_INTERVAL,
      meaning: "client_requested_address",
    },
  };
}
export function syntheticPreview(config = syntheticConfig): CalendarPreviewResponse {
  const result = explainCalendarPreview(
    config,
    [
      {
        game: "genshin",
        region: "CN",
        tombstone: false,
        patch: null,
        projection: {
          event_id: "synthetic-event",
          milestone_id: "synthetic-end",
          event: {
            event_type: "limited_event",
            status: "scheduled",
            title: "合成活动",
            summary: null,
            official_url: null,
          },
          milestone: {
            milestone_key: "end",
            node_type: "end",
            title: "结束",
            time: ExactTimeValueSchema.parse({
              precision: "datetime",
              utc_ms: now + 86400000,
              source_timezone: "UTC",
              raw_expression: "synthetic",
              time_basis: "official_explicit",
            }),
          },
        },
      },
    ],
    now,
  );
  return {
    server_time: now,
    subscription: { revision: config.revision },
    config: {
      scope: config.scope,
      calendar: config.calendar,
      notifications: { rule_ids: config.notifications.rule_ids },
    },
    publication: { generation: 31, publishedAt: now },
    asOf: now,
    window: feedWindow(now),
    sources: { fresh: true, verifiedAt: now },
    outcome: "ok",
    totals: result.totals,
    omitted: result.omitted,
    items: result.items,
    nextCursor: null,
  };
}
