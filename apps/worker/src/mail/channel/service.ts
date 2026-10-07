import {
  EMAIL_CONSENT_DISABLE_ACTION,
  EMAIL_CONSENT_ENABLE_ACTION,
  EMAIL_CONSENT_VERSION,
  type EmailChannelBlockReason,
  type EmailChannelEnableFacts,
  emailChannelEnableAvailability,
  emailChannelRefusal,
  emailSeatLeaseExpiresAt,
  GLOBAL_MUTATIONS_DAY,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEATS_MAX,
  mutationCounterKeys,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { readSubscription } from "../../accounts/subscription/service";
import type { ActiveRecoverySession } from "../../auth/recovery/credential";
import { ApiError } from "../../shell/errors";
import {
  controlPredicate,
  controlsAllow,
  readControl,
  WRITABLE_PREDICATE,
} from "../../shell/observability/controls";
import { readContext } from "./state";
import { type ChannelDeps, readEmailChannel } from "./view";

export interface EmailChannelUpdate {
  enabled?: boolean;
  routine_enabled?: boolean;
  expected_revision?: number;
  email_version?: number;
  subscription_revision?: number;
  seat_consent_version?: number;
  routine_consent_version?: number;
}
function validation(path: string, reason: string): never {
  throw new ApiError("validation", { code: "validation", fields: [{ path, reason }] });
}
export class EmailChannelRefusalError extends ApiError {
  readonly body: ReturnType<typeof emailChannelRefusal>;
  constructor(reason: EmailChannelBlockReason, layer: "seat" | "routine") {
    const body = emailChannelRefusal(reason, layer);
    super(body.error.code, body.error.details);
    this.body = body;
  }
}
export function rejectEnable(reason: EmailChannelBlockReason, layer: "seat" | "routine"): never {
  throw new EmailChannelRefusalError(reason, layer);
}

/** 两层结果在同一事务内决定；第二层满额仍提交已获同意且有名额的第一层。 */
export async function updateEmailChannel(
  deps: ChannelDeps,
  session: ActiveRecoverySession,
  input: EmailChannelUpdate,
  now: number,
) {
  const { db } = deps;
  if (input.enabled === undefined && input.routine_enabled === undefined)
    validation("", "empty_update");
  if (input.enabled === false && input.routine_enabled === true)
    validation("routine_enabled", "seat_required");
  for (const field of [
    "expected_revision",
    "email_version",
    "subscription_revision",
    "seat_consent_version",
    "routine_consent_version",
  ] as const) {
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || input[field] < 0))
      validation(field, "invalid_version");
  }
  const context = await readContext(db, deps.keys, session, now);
  if (context.facts.session_state !== "active") rejectEnable("pending_activation", "seat");
  if (context.facts.recovery_code_required) rejectEnable("recovery_code_unconfirmed", "seat");
  const subscription = await readSubscription(db, session.userId);
  const facts: EmailChannelEnableFacts = {
    ...context.facts,
    subscription_state: subscription.state,
  };
  const old = context.channel;
  const enabled = input.enabled ?? facts.enabled;
  const routine = enabled && (input.routine_enabled ?? facts.routine_enabled);
  const enableSeat = enabled && !facts.enabled;
  const enableRoutine = routine && !facts.routine_enabled;
  const enabling = enableSeat || enableRoutine;
  if (input.enabled === true || input.routine_enabled === true) {
    if (
      input.expected_revision !== (old?.channel_revision ?? 0) ||
      input.email_version !== context.user.email_version ||
      input.subscription_revision !== subscription.revision
    )
      throw new ApiError("conflict", { code: "conflict" });
  }
  if (enableSeat && input.seat_consent_version !== EMAIL_CONSENT_VERSION)
    validation("seat_consent_version", "explicit_consent_required");
  if (enableRoutine && input.routine_consent_version !== EMAIL_CONSENT_VERSION)
    validation("routine_consent_version", "explicit_consent_required");
  if (input.routine_enabled === true && !enabled) {
    const decision = emailChannelEnableAvailability(facts, "routine");
    if (!decision.allowed) rejectEnable(decision.reason, "routine");
  }
  if (enabling) {
    if ((await readControl(db, "read_only")).value === true)
      throw new ApiError("temporarily_unavailable");
    if (enableSeat && !(await controlsAllow(db, "email_seats_open")))
      throw new ApiError("temporarily_unavailable");
    if (enableRoutine && !(await controlsAllow(db, "email_routine_enabled")))
      throw new ApiError("temporarily_unavailable");
    const seat = emailChannelEnableAvailability(facts, "seat");
    if (!seat.allowed) rejectEnable(seat.reason, "seat");
    if (enableRoutine) {
      const second = emailChannelEnableAvailability({ ...facts, enabled }, "routine");
      // 只允许“子名额不足”这一项部分成功，其余前置失败整次不执行。
      if (!second.allowed && !(enableSeat && second.reason === "capacity_full"))
        rejectEnable(second.reason, "routine");
    }
  }
  if (enabled === (old?.enabled === 1) && routine === (old?.routine_enabled === 1)) {
    return { result: "completed" as const, state: await readEmailChannel(deps, session, now) };
  }
  const { userKey, globalKey } = mutationCounterKeys(session.userId, utcDayPeriod(now).key);
  const statements: D1PreparedStatement[] = [];
  if (enabling)
    for (const key of [userKey, globalKey]) {
      statements.push(
        db
          .prepare(
            "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,0,0,?) ON CONFLICT(key) DO NOTHING",
          )
          .bind(key, now),
      );
    }
  const guardIndex = statements.length;
  // 读取仅供提示；权限、绑定、配置、抑制、容量与日额在同一 SQL 守卫重查（恢复码可选，ADR-0026）。
  statements.push(
    db
      .prepare(`UPDATE users SET updated_at=updated_at WHERE id=? AND status='active'
    AND email_binding_id=? AND email_version=? AND auth_epoch=? AND recovery_epoch=?
    AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=? AND s.user_id=users.id AND s.token_hash=? AND s.state='active'
      AND s.recovery_code_required=0 AND s.auth_epoch=users.auth_epoch AND s.recovery_epoch=users.recovery_epoch AND s.expires_at>? AND s.absolute_expires_at>?)
    AND COALESCE((SELECT channel_revision FROM email_channels WHERE user_id=users.id),0)=?
    AND (?=0 OR (EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=users.id AND state='initialized' AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM suppressions WHERE address_key=? AND (expires_at IS NULL OR expires_at>?))
      AND (SELECT value FROM capacity_state WHERE key=?)<? AND (SELECT value FROM capacity_state WHERE key=?)<?))
    AND (?=0 OR (SELECT COUNT(*) FROM email_channels WHERE enabled=1)<?)
    AND (?=0 OR (SELECT COUNT(*) FROM email_channels WHERE enabled=1 AND routine_enabled=1)<?)
    ${enabling ? `AND ${WRITABLE_PREDICATE}` : ""}
    ${enableSeat ? `AND ${controlPredicate("email_seats_open")}` : ""}
    ${enableRoutine ? `AND ${controlPredicate("email_routine_enabled")}` : ""}`)
      .bind(
        session.userId,
        context.user.email_binding_id,
        context.user.email_version,
        context.user.auth_epoch,
        context.user.recovery_epoch,
        session.sessionId,
        session.sessionTokenHash,
        now,
        now,
        old?.channel_revision ?? 0,
        Number(enabling),
        subscription.revision,
        context.addressKey,
        now,
        userKey,
        USER_MUTATIONS_DAY,
        globalKey,
        GLOBAL_MUTATIONS_DAY,
        Number(enableSeat),
        MAIL_SEATS_MAX,
        Number(enableRoutine && !enableSeat),
        MAIL_ROUTINE_SEATS_MAX,
      ),
  );
  if (enabling)
    for (const key of [userKey, globalKey]) {
      statements.push(
        db
          .prepare(
            "UPDATE capacity_state SET value=value+1,version=version+1,updated_at=? WHERE changes()=1 AND key=?",
          )
          .bind(now, key),
      );
    }
  const channelIndex = statements.length;
  statements.push(
    db
      .prepare(`INSERT INTO email_channels(user_id,enabled,routine_enabled,consent_version,address_version,
    lease_expires_at,last_renewed_at,last_renewed_reason,channel_revision,created_at,updated_at)
    SELECT ?,?,CASE WHEN ?=1 AND (?=1 OR (SELECT COUNT(*) FROM email_channels WHERE enabled=1 AND routine_enabled=1)<?) THEN 1 ELSE 0 END,
      ?,?,?,?,?,?,?,? WHERE changes()=1
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,routine_enabled=excluded.routine_enabled,
      consent_version=excluded.consent_version,address_version=excluded.address_version,lease_expires_at=excluded.lease_expires_at,
      last_renewed_at=excluded.last_renewed_at,last_renewed_reason=excluded.last_renewed_reason,
      channel_revision=excluded.channel_revision,updated_at=excluded.updated_at`)
      .bind(
        session.userId,
        Number(enabled),
        Number(routine),
        Number(facts.routine_enabled),
        MAIL_ROUTINE_SEATS_MAX,
        enabling ? EMAIL_CONSENT_VERSION : (old?.consent_version ?? 0),
        context.user.email_version,
        !enabled
          ? null
          : enableSeat
            ? emailSeatLeaseExpiresAt(now)
            : (old?.lease_expires_at ?? null),
        enableSeat ? now : (old?.last_renewed_at ?? null),
        enableSeat ? "explicit_consent" : (old?.last_renewed_reason ?? null),
        (old?.channel_revision ?? 0) + 1,
        now,
        now,
      ),
  );
  // 单个最终 INSERT 可写 0/1/2 条；不把可能零行的事件插入放进 changes() 链中间。
  const audit = JSON.stringify({
    subscription_revision: subscription.revision,
    email_version: context.user.email_version,
  });
  statements.push(
    db
      .prepare(`INSERT INTO consent_events(id,user_id,email_binding_id,layer,action,consent_version,context_json,created_at)
    SELECT ?,user_id,?,'seat',CASE WHEN enabled=1 THEN ? ELSE ? END,consent_version,?,? FROM email_channels
      WHERE changes()=1 AND user_id=? AND enabled<>?
    UNION ALL SELECT ?,user_id,?,'routine',CASE WHEN routine_enabled=1 THEN ? ELSE ? END,consent_version,?,? FROM email_channels
      WHERE changes()=1 AND user_id=? AND routine_enabled<>?`)
      .bind(
        crypto.randomUUID(),
        context.user.email_binding_id,
        EMAIL_CONSENT_ENABLE_ACTION,
        EMAIL_CONSENT_DISABLE_ACTION,
        audit,
        now,
        session.userId,
        Number(facts.enabled),
        crypto.randomUUID(),
        context.user.email_binding_id,
        EMAIL_CONSENT_ENABLE_ACTION,
        EMAIL_CONSENT_DISABLE_ACTION,
        audit,
        now,
        session.userId,
        Number(facts.routine_enabled),
      ),
  );
  const results = await db.batch(statements);
  if (results[guardIndex]?.meta.changes !== 1) {
    // 不把竞态泛化为成功；按最新事实给出原因，无可解释的变化返回 conflict。
    const fresh = await readEmailChannel(deps, session, now);
    if (enabling) {
      const decision = emailChannelEnableAvailability(
        { ...fresh, enabled: enableRoutine && !enableSeat ? fresh.enabled : facts.enabled },
        enableSeat ? "seat" : "routine",
      );
      if (!decision.allowed) rejectEnable(decision.reason, enableSeat ? "seat" : "routine");
      const counters = (
        await db
          .prepare("SELECT key,value FROM capacity_state WHERE key IN (?,?)")
          .bind(userKey, globalKey)
          .all<{ key: string; value: number }>()
      ).results;
      for (const [key, limit, scope] of [
        [userKey, USER_MUTATIONS_DAY, "user_mutations_day"],
        [globalKey, GLOBAL_MUTATIONS_DAY, "global_mutations_day"],
      ] as const)
        if ((counters.find((row) => row.key === key)?.value ?? 0) >= limit)
          throw new ApiError("quota_paused", { code: "quota_paused", scope });
    }
    throw new ApiError("conflict", { code: "conflict" });
  }
  if (results[channelIndex]?.meta.changes !== 1) throw new Error("email_channel_commit_invariant");
  const state = await readEmailChannel(deps, session, now);
  return {
    result: routine && !state.routine_enabled ? ("partial" as const) : ("completed" as const),
    state,
    ...(routine && !state.routine_enabled
      ? { routine_error: { code: "capacity_reached" as const, capability: "email_routine" } }
      : {}),
  };
}
