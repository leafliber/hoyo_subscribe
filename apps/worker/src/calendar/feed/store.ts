// P3-06 · 主状态授权与版本核对；P3-07 管理入口签发时须保存当前 recovery_epoch（灾备代次）。
import {
  FEED_MAX_STALE,
  type FeedDiagnostic,
  feedActivityCutoff,
  SECRET_BITS,
  type SubscriptionConfig,
  subscriptionConfigSchemaFor,
} from "@hoyo/contracts";
import { recordActivityFailure } from "../../accounts/activity/telemetry";
import { fromBase64Url, toBase64Url, toHex, utf8Encode } from "../../storage/crypto/bytes";

export interface FeedState {
  user_id: string;
  namespace: string;
  token_generation: number;
  view_revision: number;
  changed_at: number;
  recovery_epoch: number;
  last_served_node_count: number | null;
  last_served_view_revision: number | null;
  last_served_generation: number | null;
  last_served_at: number | null;
  last_served_natural_exit_at: number | null;
  last_guard_blocked_at: number | null;
  revision: number;
  schema_version: number;
  scope_json: string;
  calendar_json: string;
  notifications_json: string;
}
export async function hashFeedToken(token: string): Promise<string | null> {
  if (token.length !== Math.ceil(SECRET_BITS / 6)) return null;
  const decoded = fromBase64Url(token);
  if (decoded === null || decoded.length * 8 !== SECRET_BITS || toBase64Url(decoded) !== token)
    return null;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(token))));
}
/** 每次请求、包括热缓存/HEAD/304，都从主库核验；不接受 Cookie 或缓存身份。 */
export async function readFeedState(
  db: D1Database,
  hash: string,
  now = Date.now(),
): Promise<FeedState | null> {
  // 授权谓词仍为 P3-06 的原文；UPDATE 与只读重查共用，失败时绝不返回缓存身份。
  const authorized = `FROM calendar_feeds f JOIN users u ON u.id = f.user_id JOIN user_subscriptions s ON s.user_id = f.user_id
    WHERE f.token_hash = ? AND f.state = 'enabled' AND u.status = 'active'
      AND f.recovery_epoch = u.recovery_epoch AND s.state = 'initialized'`;
  try {
    await db
      .prepare(`UPDATE calendar_feeds SET last_feed_poll_at = ?
      WHERE user_id IN (SELECT f.user_id ${authorized})
        AND (last_feed_poll_at IS NULL OR last_feed_poll_at <= ?)`)
      .bind(now, hash, feedActivityCutoff(now))
      .run();
  } catch {
    await recordActivityFailure(db, now);
  }
  return db
    .prepare(`SELECT f.user_id, f.namespace, f.token_generation, f.view_revision, f.changed_at,
    f.recovery_epoch, f.last_served_node_count, f.last_served_view_revision,
    f.last_served_generation, f.last_served_at, f.last_served_natural_exit_at, f.last_guard_blocked_at,
    s.revision, s.schema_version, s.scope_json, s.calendar_json, s.notifications_json ${authorized}`)
    .bind(hash)
    .first<FeedState>();
}

export function feedConfig(state: FeedState): SubscriptionConfig {
  return subscriptionConfigSchemaFor("initialized").parse({
    schema_version: state.schema_version,
    revision: state.revision,
    scope: JSON.parse(state.scope_json),
    calendar: JSON.parse(state.calendar_json),
    notifications: JSON.parse(state.notifications_json),
  });
}
/** 保存输出事实本身也是最终 CAS：不让并发旧响应覆盖新基线或越过撤销/配置/发布变化。 */
export async function recordFeedOutput(
  db: D1Database,
  hash: string,
  state: FeedState,
  generation: number,
  count: number,
  now: number,
  blocked: boolean,
  diagnostic: FeedDiagnostic | null = null,
  requiredSources: readonly string[] = [],
  naturalExitAt: number | null = null,
): Promise<boolean> {
  const failed = diagnostic !== null || blocked;
  const set = blocked
    ? "last_guard_blocked_at = ?, "
    : failed
      ? ""
      : "last_served_at = ?, last_served_node_count = ?, last_served_view_revision = view_revision, last_served_generation = ?, last_served_natural_exit_at = ?, ";
  const result = await db
    .prepare(`UPDATE calendar_feeds SET ${set}last_output_at = ?, last_output_diagnostic = ?
    WHERE token_hash = ? AND state = 'enabled' AND token_generation = ? AND view_revision = ?
      AND last_served_at IS ? AND last_served_node_count IS ? AND last_served_generation IS ?
      AND last_served_natural_exit_at IS ?
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_feeds.user_id AND u.status = 'active'
        AND u.recovery_epoch = calendar_feeds.recovery_epoch)
      AND EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_id = calendar_feeds.user_id
        AND s.state = 'initialized' AND s.revision = ?)
      AND EXISTS (SELECT 1 FROM public_snapshots WHERE state = 'current' AND generation = ?)
      AND (? = 1 OR NOT EXISTS (SELECT 1 FROM json_each(?) requested LEFT JOIN sources s ON s.source_id = requested.value
        WHERE s.last_success_at IS NULL OR s.last_success_at > ? OR s.last_success_at < ?))`)
    .bind(
      ...(blocked ? [now] : failed ? [] : [now, count, generation, naturalExitAt]),
      now,
      diagnostic ?? (blocked ? "shrink_guard" : null),
      hash,
      state.token_generation,
      state.view_revision,
      state.last_served_at,
      state.last_served_node_count,
      state.last_served_generation,
      state.last_served_natural_exit_at,
      state.revision,
      generation,
      Number(failed),
      JSON.stringify(requiredSources),
      now,
      now - FEED_MAX_STALE * 1000,
    )
    .run();
  return result.meta.changes === 1;
}
