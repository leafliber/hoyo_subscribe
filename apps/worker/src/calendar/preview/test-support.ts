// 所有数据均为本地 synthetic 样本；不访问来源或邮件服务。
import { env } from "cloudflare:test";
import {
  type PublicSnapshotNode,
  SESSION_IDLE_TTL,
  type SubscriptionConfig,
  TimeValueSchema,
} from "@hoyo/contracts";
import { makePendingSession } from "../../auth/consume/session";
import { generateSecretToken } from "../../storage/crypto/random";
import { hashFeedToken } from "../feed/store";
export const T = Date.parse("2026-10-02T12:00:00Z");
export const config: SubscriptionConfig = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
  notifications: {
    rule_ids: ["limited_end_1d", "limited_start_1h"],
    new_event: false,
    important_change: false,
    cancelled_or_retracted: false,
    late_discovery: false,
  },
};
export type StampedNode = PublicSnapshotNode & { public_changed_at: number };
export function node(id: string, ms = T): StampedNode {
  return {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    public_changed_at: T,
    source_projection_json: "internal",
    tombstone: false,
    patch: null,
    projection: {
      event_id: "synthetic-preview-event",
      milestone_id: id,
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "synthetic 中文😀",
        summary: "synthetic,;",
        official_url: "https://example.invalid/event",
        human_locked: true,
      },
      milestone: {
        milestone_key: id,
        node_type: "start",
        title: "synthetic start",
        human_locked: false,
        time: TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: ms,
          source_timezone: "UTC",
          raw_expression: "synthetic",
          time_basis: "official_explicit",
        }),
      },
    },
  };
}
export async function run(sql: string, ...args: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
let order = 900000;
export async function seed(initialized = true) {
  const userId = crypto.randomUUID(),
    session = await makePendingSession(T);
  await run(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,recovery_epoch,created_at,updated_at) VALUES (?,?,'active',?,?,X'00',1,0,?,?)`,
    userId,
    ++order,
    userId,
    userId,
    T,
    T,
  );
  await run(
    `INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at,activated_at) VALUES (?,?,?,'active','synthetic','unknown',?,?,?,?,0,0,?,?,?)`,
    session.id,
    userId,
    session.tokenHash,
    T,
    session.absoluteExpiresAt,
    // 活跃会话按闲置期限过期（不是待激活的短期限），否则拨动时钟超过新鲜期时会话先失效。
    T + SESSION_IDLE_TTL * 1000,
    T,
    T,
    T,
    T,
  );
  if (initialized)
    await run(
      `INSERT INTO user_subscriptions(user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES (?,'initialized',3,1,?,?,?,?,?)`,
      userId,
      JSON.stringify(config.scope),
      JSON.stringify(config.calendar),
      JSON.stringify(config.notifications),
      T,
      T,
    );
  else
    await run(
      "INSERT INTO user_subscriptions(user_id,state,schema_version,revision,created_at,updated_at) VALUES (?,'uninitialized',3,0,?,?)",
      userId,
      T,
      T,
    );
  await run(
    `INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,human_locked,created_at,updated_at) VALUES ('synthetic-preview-event','genshin','CN','limited_event','scheduled','synthetic',1,1,0,?,?) ON CONFLICT DO NOTHING`,
    T,
    T,
  );
  await run(
    `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES ('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?) ON CONFLICT(source_id) DO UPDATE SET last_success_at=excluded.last_success_at`,
    T,
    T,
    T,
  );
  return { userId, sessionId: session.id, cookie: session.cookieValue };
}
export async function snapshot(values: readonly StampedNode[], generation = 1) {
  await run("DELETE FROM public_snapshot_nodes");
  await run("DELETE FROM public_snapshots");
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO public_snapshots(id,generation,state,published_at,node_count,created_at) VALUES (?,?,'current',?,?,?)`,
    id,
    generation,
    T,
    values.length,
    T,
  );
  for (const n of values) {
    await run(
      `INSERT INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,public_ical_revision,human_locked,created_at,updated_at) VALUES (?,'synthetic-preview-event',?,'start','synthetic','UTC','synthetic','official_explicit','unknown',1,0,?,?) ON CONFLICT(id) DO NOTHING`,
      n.projection.milestone_id,
      n.projection.milestone_id,
      T,
      T,
    );
    await run(
      "INSERT INTO public_snapshot_nodes(snapshot_id,milestone_id,node_json) VALUES (?,?,?)",
      id,
      n.projection.milestone_id,
      JSON.stringify(n),
    );
  }
}
export async function feed(userId: string) {
  const token = generateSecretToken().base64url,
    namespace = crypto.randomUUID();
  await run(
    `INSERT INTO calendar_feeds(user_id,namespace,state,token_hash,token_ciphertext,token_generation,view_revision,recovery_epoch,changed_at,created_at,updated_at) VALUES (?,?,'enabled',?,X'00',1,0,0,?,?,?)`,
    userId,
    namespace,
    await hashFeedToken(token),
    T,
    T,
    T,
  );
  return { token, namespace };
}
export async function savedState(userId: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "sessions",
    "user_subscriptions",
    "calendar_feeds",
    "subscription_interests",
  ])
    result[table] = (
      await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id=?`).bind(userId).all()
    ).results;
  return result;
}
