import {
  EMAIL_CONSENT_VERSION,
  emailChannelServiceState,
  MAIL_SEAT_LEASE,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { readSubscription } from "../../accounts/subscription/service";
import type { ActiveRecoverySession } from "../../auth/recovery/credential";
import type { Keyring } from "../../storage/crypto/keyring";
import { readMailDayLedger } from "../../storage/ledger/mail-ledger";
import { readContext, readLayerConsent } from "./state";

export interface ChannelDeps {
  db: D1Database;
  keys: Keyring;
  /** P4-06 接入业务退订能力后提供发送可用事实；尚未接入时不能声称正常。 */
  sendingAvailable?: () => Promise<boolean | "unknown">;
}
export async function readEmailChannel(
  deps: ChannelDeps,
  session: ActiveRecoverySession,
  now: number,
) {
  const { db } = deps;
  const context = await readContext(db, deps.keys, session, now);
  const currentChannel =
    context.channel?.address_version === context.user.email_version ? context.channel : null;
  const [subscription, seatConsent, routineConsent, ledger, sending] = await Promise.all([
    readSubscription(db, session.userId),
    readLayerConsent(db, session.userId, context.user.email_binding_id, "seat"),
    readLayerConsent(db, session.userId, context.user.email_binding_id, "routine"),
    readMailDayLedger(db, utcDayPeriod(now).key, session.userId).catch(() => null),
    deps.sendingAvailable?.().catch(() => "unknown" as const) ?? Promise.resolve(false),
  ]);
  return {
    server_time: now,
    channel_revision: context.channel?.channel_revision ?? 0,
    ...context.facts,
    subscription_state: subscription.state,
    subscription,
    email: { masked: context.maskedAddress, email_version: context.user.email_version },
    consent: { seat: seatConsent, routine: routineConsent },
    lease: {
      expires_at: currentChannel?.lease_expires_at ?? null,
      last_renewed_at: currentChannel?.last_renewed_at ?? null,
      last_renewed_reason: currentChannel?.last_renewed_reason ?? null,
      automatic_renewal: "account_activity",
      // 后台批量续租的编排由 P5-02 接入；不把尚未接线说成已运行。
      background_processing: "unknown",
    },
    suppression_kind: context.suppressionKind,
    service: { state: emailChannelServiceState(sending, ledger), sending_available: sending },
    disclosure: {
      consent_version: EMAIL_CONSENT_VERSION,
      daily_limits: { seat: MAIL_USER_URGENT_DAY, routine: MAIL_USER_BASE_DAY },
      lease_days: MAIL_SEAT_LEASE,
      renewal:
        "账号真实交互、有效日历拉取或客户端处理信号自动续租，无须专门返回网页。发信与投递成功不算活动。",
      budget:
        "UTC 日口径为最大发送机会，不保证每条送达；同一时段多条提醒会合并成一封。邮件受每日预算和投递状态约束。基础池不足时暂停常规提醒；紧急池降级时只保留取消或撤回。",
      alternative:
        "名额不足时仍可使用公开浏览与日历提醒；没有邮件会失去取消或改期的主动邮件通知，不承诺名额开放时间。",
    },
  };
}
