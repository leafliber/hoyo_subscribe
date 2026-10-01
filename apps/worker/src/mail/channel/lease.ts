import { type EmailActivityFacts, emailSeatRenewal } from "@hoyo/contracts";
import { channelRow } from "./state";

/** P5-02 的有界后台扫描调用本原语；不依赖用户访问本 API，不做沉睡回收。 */
export async function renewEmailSeat(
  db: D1Database,
  userId: string,
  now: number,
): Promise<boolean> {
  const channel = await channelRow(db, userId);
  if (!channel) return false;
  const user = await db
    .prepare(`SELECT email_version,last_interactive_at,last_feed_poll_at,last_push_processed_at
    FROM users WHERE id=? AND status='active'`)
    .bind(userId)
    .first<EmailActivityFacts & { email_version: number }>();
  if (!user || channel.address_version !== user.email_version) return false;
  const renewal = emailSeatRenewal(user, { ...channel, enabled: channel.enabled === 1 }, now);
  if (!renewal) return false;
  const result = await db
    .prepare(`UPDATE email_channels SET lease_expires_at=?,last_renewed_at=?,last_renewed_reason=?,
    channel_revision=channel_revision+1,updated_at=? WHERE user_id=? AND channel_revision=? AND enabled=1 AND address_version=?
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=email_channels.user_id AND u.status='active' AND u.email_version=email_channels.address_version
      AND u.last_interactive_at IS ? AND u.last_feed_poll_at IS ? AND u.last_push_processed_at IS ?)`)
    .bind(
      renewal.lease_expires_at,
      now,
      renewal.reason,
      now,
      userId,
      channel.channel_revision,
      user.email_version,
      user.last_interactive_at,
      user.last_feed_poll_at,
      user.last_push_processed_at,
    )
    .run();
  return result.meta.changes === 1;
}
