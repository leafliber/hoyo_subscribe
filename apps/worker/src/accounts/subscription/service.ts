// P2-06 云端订阅：所有者由外壳会话派生；保存以订阅 revision 为 CAS 守卫，
// 两级修改日额和兴趣/Feed 效果同批提交（主方案 §5.1/§5.3/§5.4/§9.5）。
import {
  CONFIG_MAX_BYTES,
  changesCalendarView,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  parseSubscriptionConfig,
  SUBSCRIPTION_SCHEMA_VERSION,
  type SubscriptionConfig,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import { conditionalCommit, type GuardedEffect } from "../../storage/cas";

interface SubscriptionRow {
  state: "uninitialized" | "initialized";
  schema_version: number;
  revision: number;
  scope_json: string | null;
  calendar_json: string | null;
  notifications_json: string | null;
}

interface InterestRow {
  id: string;
  game: string;
  region: string;
  interest_kind: string;
  interest_id: string;
  enabled_at: number;
}

export interface SubscriptionSnapshot {
  readonly state: "uninitialized" | "initialized";
  readonly revision: number;
  readonly config: SubscriptionConfig | null;
}

function validation(path: string, reason: string): ApiError {
  return new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

/** 未初始化直接返回 null，绝不合成 DEFAULT_* 配置。 */
export async function readSubscription(
  db: D1Database,
  userId: string,
): Promise<SubscriptionSnapshot> {
  const row = await db
    .prepare(
      "SELECT state, schema_version, revision, scope_json, calendar_json, notifications_json FROM user_subscriptions WHERE user_id = ?",
    )
    .bind(userId)
    .first<SubscriptionRow>();
  if (!row) throw new Error("subscription_row_missing");
  if (row.state === "uninitialized") {
    if (row.revision !== 0) throw new Error("uninitialized_revision_invalid");
    return { state: "uninitialized", revision: row.revision, config: null };
  }
  if (!row.scope_json || !row.calendar_json || !row.notifications_json) {
    throw new Error("initialized_subscription_incomplete");
  }
  const parsed = parseSubscriptionConfig("initialized", {
    schema_version: row.schema_version,
    revision: row.revision,
    scope: JSON.parse(row.scope_json),
    calendar: JSON.parse(row.calendar_json),
    notifications: JSON.parse(row.notifications_json),
  });
  if (!parsed.success) throw new Error("stored_subscription_invalid");
  return { state: "initialized", revision: row.revision, config: parsed.data };
}

function interestKey(
  row: Pick<InterestRow, "game" | "region" | "interest_kind" | "interest_id">,
): string {
  return JSON.stringify([row.game, row.region, row.interest_kind, row.interest_id]);
}

function desiredInterests(
  config: SubscriptionConfig,
): Map<string, Omit<InterestRow, "id" | "enabled_at">> {
  const desired = new Map<string, Omit<InterestRow, "id" | "enabled_at">>();
  const selected: Array<{ kind: string; id: string }> = [
    ...config.notifications.rule_ids.map((id) => ({ kind: "rule", id })),
    ...Object.entries(config.notifications)
      .filter(([, value]) => value === true)
      .map(([id]) => ({ kind: "change_switch", id })),
  ];
  for (const game of config.scope.games) {
    for (const region of config.scope.regions) {
      for (const interest of selected) {
        const row = { game, region, interest_kind: interest.kind, interest_id: interest.id };
        desired.set(interestKey(row), row);
      }
    }
  }
  return desired;
}

function sameConfig(before: SubscriptionConfig, after: SubscriptionConfig): boolean {
  return JSON.stringify({ ...before, revision: after.revision }) === JSON.stringify(after);
}

export type SaveSubscriptionResult =
  | { readonly kind: "saved" | "unchanged"; readonly snapshot: SubscriptionSnapshot }
  | { readonly kind: "conflict"; readonly current: SubscriptionSnapshot }
  | { readonly kind: "rate_limited" };

/** PATCH 的 config 不含服务端维护的 revision；expected_revision 是唯一写入条件。 */
export async function saveSubscription(
  db: D1Database,
  userId: string,
  expectedRevision: number,
  input: unknown,
  now: number,
): Promise<SaveSubscriptionResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw validation("expected_revision", "invalid_revision");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input) || "revision" in input) {
    throw validation("config", "invalid_config_shape");
  }
  if (byteLength(input) > CONFIG_MAX_BYTES) throw validation("config", "config_too_large");
  const parsed = parseSubscriptionConfig("initialized", {
    ...input,
    revision: expectedRevision + 1,
  });
  if (!parsed.success) {
    throw new ApiError("validation", {
      code: "validation",
      fields: parsed.error.issues.map((issue) => ({
        path: ["config", ...issue.path.map(String)].join("."),
        reason: issue.code,
      })),
    });
  }
  const config = parsed.data;
  if (byteLength(config) > CONFIG_MAX_BYTES) throw validation("config", "config_too_large");
  const before = await readSubscription(db, userId);
  if (before.revision !== expectedRevision) return { kind: "conflict", current: before };
  if (before.config !== null && sameConfig(before.config, config)) {
    return { kind: "unchanged", snapshot: before };
  }

  const existing =
    (
      await db
        .prepare(
          "SELECT id, game, region, interest_kind, interest_id, enabled_at FROM subscription_interests WHERE user_id = ?",
        )
        .bind(userId)
        .all<InterestRow>()
    ).results ?? [];
  const existingByKey = new Map(existing.map((row) => [interestKey(row), row]));
  const desired = desiredInterests(config);
  const { userKey, globalKey } = mutationCounterKeys(userId, utcDayPeriod(now).key);
  const effects: GuardedEffect[] = [
    {
      kind: "update",
      table: "capacity_state",
      set: { value: { sql: "value + 1" }, version: { sql: "version + 1" }, updated_at: now },
      where: { sql: "key = ?", params: [globalKey] },
    },
    {
      kind: "update",
      table: "capacity_state",
      set: { value: { sql: "value + 1" }, version: { sql: "version + 1" }, updated_at: now },
      where: { sql: "key = ?", params: [userKey] },
    },
  ];
  for (const [key, row] of existingByKey) {
    if (!desired.has(key)) {
      effects.push({
        kind: "delete",
        table: "subscription_interests",
        where: { sql: "id = ? AND user_id = ?", params: [row.id, userId] },
      });
    }
  }
  for (const [key, row] of desired) {
    if (!existingByKey.has(key)) {
      effects.push({
        kind: "insert",
        table: "subscription_interests",
        columns: ["id", "user_id", "game", "region", "interest_kind", "interest_id", "enabled_at"],
        rows: [
          [
            crypto.randomUUID(),
            userId,
            row.game,
            row.region,
            row.interest_kind,
            row.interest_id,
            now,
          ],
        ],
      });
    }
  }
  if (before.config !== null && changesCalendarView(before.config, config)) {
    effects.push({
      kind: "update",
      table: "calendar_feeds",
      allowZeroRowsIfLast: true,
      set: { view_revision: { sql: "view_revision + 1" }, changed_at: now, updated_at: now },
      where: { sql: "user_id = ?", params: [userId] },
    });
  }

  const outcome = await conditionalCommit(db, {
    preamble: [userKey, globalKey].map((key) => ({
      sql: "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
      params: [key, now],
    })),
    guard: {
      sql: `UPDATE user_subscriptions SET state = 'initialized', schema_version = ?, revision = revision + 1,
        scope_json = ?, calendar_json = ?, notifications_json = ?, updated_at = ?
        WHERE user_id = ? AND revision = ? AND state = ?
          AND (SELECT value FROM capacity_state WHERE key = ?) < ?
          AND (SELECT value FROM capacity_state WHERE key = ?) < ?`,
      params: [
        SUBSCRIPTION_SCHEMA_VERSION,
        JSON.stringify(config.scope),
        JSON.stringify(config.calendar),
        JSON.stringify(config.notifications),
        now,
        userId,
        expectedRevision,
        before.state,
        userKey,
        USER_MUTATIONS_DAY,
        globalKey,
        GLOBAL_MUTATIONS_DAY,
      ],
    },
    effects,
  });
  if (outcome.outcome === "committed") {
    return { kind: "saved", snapshot: { state: "initialized", revision: config.revision, config } };
  }
  const current = await readSubscription(db, userId);
  if (current.revision !== expectedRevision) return { kind: "conflict", current };
  return { kind: "rate_limited" };
}
