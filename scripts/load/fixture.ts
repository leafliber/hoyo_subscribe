// synthetic only. Imported exclusively by the local harness, never by production.

import { cleanupDeletedAccountPage } from "../../apps/worker/src/accounts/lifecycle/cleanup";
import {
  confirmReclaim,
  listReclaimCandidates,
  scanAccountPage,
} from "../../apps/worker/src/accounts/reclaim/service";
import { encryptOtpPayload, OTP_PAYLOAD_KIND } from "../../apps/worker/src/auth/challenges/payload";
import { makePendingSession } from "../../apps/worker/src/auth/consume/session";
import { hashFeedToken } from "../../apps/worker/src/calendar/feed/store";
import { calendarLifecycle } from "../../apps/worker/src/calendar/manage/hooks";
import { emailLifecycleHook } from "../../apps/worker/src/mail/channel/hooks";
import { sendOneMail } from "../../apps/worker/src/mail/outbox/send";
import { maintainFeedback } from "../../apps/worker/src/scheduled/feedback";
import { runScheduledMaintenance } from "../../apps/worker/src/scheduled/reclaim";
import { Keyring } from "../../apps/worker/src/storage/crypto/keyring";
import { generateSecretToken } from "../../apps/worker/src/storage/crypto/random";
import {
  readMailDayLedger,
  reserveMailBudget,
} from "../../apps/worker/src/storage/ledger/mail-ledger";
import * as C from "../../packages/contracts/src/index";

const DAY = 86400000;
let T = 0;
let ring: Keyring;
const run = (db: D1Database, sql: string, ...args: unknown[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .run();
const scalar = (db: D1Database, sql: string) => db.prepare(sql).first<number>("n");
const set = (db: D1Database, key: string, value: boolean) =>
  run(
    db,
    "INSERT INTO system_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    key,
    JSON.stringify(value),
    T,
  );
export async function fixture(db: D1Database, action: string, offset = 0) {
  if (action === "seed") {
    T = Date.now();
    ring = await Keyring.create({
      masterSecret: crypto.getRandomValues(new Uint8Array(C.SECRET_BITS / 8)),
      otpPepper: crypto.getRandomValues(new Uint8Array(C.SECRET_BITS / 8)),
      unsubscribeMacCurrentKeyId: "synthetic",
    });
    const s = await makePendingSession(T),
      token = generateSecretToken().base64url;
    await run(
      db,
      `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at) VALUES('synthetic-reader',1,'active','synthetic-reader','synthetic-reader',X'00',1,?,?)`,
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at,activated_at) VALUES (?,'synthetic-reader',?,'active','synthetic','unknown',?,?,?,?,0,0,?,?,?)`,
      s.id,
      s.tokenHash,
      T,
      s.absoluteExpiresAt,
      T + C.SESSION_IDLE_TTL * 1000,
      T,
      T,
      T,
      T,
    );
    const config = {
      schema_version: 3,
      revision: 1,
      scope: { games: ["genshin"], regions: ["CN"] },
      calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
      notifications: {
        rule_ids: ["limited_start_1h"],
        new_event: false,
        important_change: true,
        cancelled_or_retracted: true,
        late_discovery: true,
      },
    };
    await run(
      db,
      `INSERT INTO user_subscriptions(user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES('synthetic-reader','initialized',3,1,?,?,?,?,?)`,
      JSON.stringify(config.scope),
      JSON.stringify(config.calendar),
      JSON.stringify(config.notifications),
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO calendar_feeds(user_id,namespace,state,token_hash,token_ciphertext,token_generation,view_revision,recovery_epoch,changed_at,created_at,updated_at) VALUES('synthetic-reader',?,'enabled',?,X'00',1,0,0,?,?,?)`,
      crypto.randomUUID(),
      await hashFeedToken(token),
      T,
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?)`,
      T,
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,human_locked,created_at,updated_at) VALUES('synthetic-event','genshin','CN','limited_event','scheduled','synthetic',1,1,0,?,?)`,
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO public_snapshots(id,generation,state,published_at,node_count,created_at) VALUES('synthetic-snapshot',1,'current',?,?,?)`,
      T,
      C.FEED_BASE_NODE_MAX,
      T,
    );
    return { token, cookie: s.cookieValue, nodes: C.FEED_BASE_NODE_MAX };
  }
  if (action === "nodes") {
    const end = Math.min(offset + C.MATCH_PAGE, C.FEED_BASE_NODE_MAX);
    for (let i = offset; i < end; i++) {
      const id = `synthetic-node-${i}`;
      const n = {
        game: "genshin",
        region: "CN",
        public_ical_revision: 1,
        public_changed_at: T,
        source_projection_json: null,
        tombstone: false,
        patch: null,
        projection: {
          event_id: "synthetic-event",
          milestone_id: id,
          event: {
            event_type: "limited_event",
            status: "scheduled",
            title: "synthetic 中文😀",
            summary: "synthetic",
            official_url: "https://example.invalid/event",
            human_locked: false,
          },
          milestone: {
            milestone_key: id,
            node_type: "start",
            title: "synthetic",
            human_locked: false,
            time: {
              precision: "datetime",
              utc_ms: T + 3600000,
              source_timezone: "UTC",
              raw_expression: "synthetic",
              time_basis: "official_explicit",
            },
          },
        },
      };
      await db.batch([
        db
          .prepare(
            `INSERT INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,public_ical_revision,human_locked,created_at,updated_at) VALUES(?,'synthetic-event',?,'start','synthetic','UTC','synthetic','official_explicit','unknown',1,0,?,?)`,
          )
          .bind(id, id, T, T),
        db
          .prepare(
            "INSERT INTO public_snapshot_nodes(snapshot_id,milestone_id,node_json) VALUES('synthetic-snapshot',?,?)",
          )
          .bind(id, JSON.stringify(n)),
      ]);
    }
    return { next: end < C.FEED_BASE_NODE_MAX ? end : null };
  }
  if (action === "revoke") {
    await run(db, "UPDATE calendar_feeds SET state='disabled'");
    await run(db, "UPDATE sessions SET state='revoked'");
    return { revoked: true };
  }
  if (action === "mail") {
    await set(db, "outbound_enabled", true);
    const id = crypto.randomUUID(),
      cid = crypto.randomUUID();
    const payload = await encryptOtpPayload(ring.fieldEncryption(), id, {
      challengeId: cid,
      generation: 0,
      code: "2".repeat(C.OTP_DIGITS),
      address: "synthetic@example.invalid",
    });
    await run(
      db,
      `INSERT INTO auth_challenges(id,purpose,email_key,address_version,preauth_id,mac,generation,deadline,created_at,updated_at) VALUES(?,'login',?,1,?,'synthetic',0,?,?,?)`,
      cid,
      "synthetic-reader",
      id,
      T + C.OTP_TTL * 1000,
      T,
      T,
    );
    await run(
      db,
      `INSERT INTO mail_outbox(id,recipient_user_id,purpose,priority,period_key,address_version,payload_kind,payload_ref,payload_ciphertext,status,created_at,updated_at) VALUES(?,'synthetic-reader','existing_auth',0,'',1,?,?,?,'pending',?,?)`,
      id,
      OTP_PAYLOAD_KIND,
      cid,
      payload,
      T,
      T,
    );
    const reservation = await reserveMailBudget(db, {
      intent: "existing_auth_first_login",
      period: C.utcDayPeriod(T),
      now: T,
      outboxId: id,
    });
    let calls = 0;
    await sendOneMail(
      {
        db,
        now: () => T,
        origin: "https://example.invalid",
        fieldKey: async () => ring.fieldEncryption(),
        available: async () => true,
        pause: async () => {},
        provider: {
          send: async () => {
            calls++;
            return offset % 3 === 0
              ? { kind: "accepted", messageId: crypto.randomUUID() }
              : offset % 3 === 1
                ? { kind: "unknown", reason: "synthetic", pause: false }
                : { kind: "rejected", reason: "synthetic", retryable: true, pause: false };
          },
        },
      },
      "synthetic",
      id,
    );
    return {
      reservation: reservation.outcome,
      calls,
      status: await db
        .prepare("SELECT status FROM mail_outbox WHERE id=?")
        .bind(id)
        .first("status"),
      ledger: await readMailDayLedger(db, C.utcDayPeriod(T).key),
    };
  }
  if (action === "capacity-seed") {
    const end = Math.min(offset + C.MATCH_PAGE, C.ACCOUNT_MAX_STORED - 1);
    const old = T - (C.ACCOUNT_IDLE_DAYS + C.ACCOUNT_GRACE_DAYS + 1) * DAY;
    for (let i = offset; i < end; i++) {
      const id = `synthetic-capacity-${i}`;
      await run(
        db,
        `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,last_interactive_at,reclaim_grace_until,created_at,updated_at) VALUES(?,?,'active',?,?,X'00',1,?,?,?,?)`,
        id,
        i + 2,
        id,
        id,
        old,
        T,
        old,
        old,
      );
      if (i < C.MAIL_SEATS_MAX)
        await run(
          db,
          `INSERT INTO email_channels(user_id,enabled,routine_enabled,address_version,lease_expires_at,last_renewed_at,consent_version,created_at,updated_at) VALUES(?,1,?,1,?,?,1,?,?)`,
          id,
          i < C.MAIL_ROUTINE_SEATS_MAX ? 1 : 0,
          T - 1,
          old,
          old,
          old,
        );
    }
    await run(
      db,
      "INSERT INTO capacity_state(key,value,version,updated_at) VALUES('accounts_total',?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      end + 1,
      T,
    );
    return { next: end < C.ACCOUNT_MAX_STORED - 1 ? end : null };
  }
  if (action === "capacity") {
    await run(db, "UPDATE users SET last_feed_poll_at=? WHERE id='synthetic-capacity-0'", T);
    const before = {
      accounts: await scalar(db, "SELECT COUNT(*) n FROM users WHERE status='active'"),
      seats: await scalar(db, "SELECT COUNT(*) n FROM email_channels WHERE enabled=1"),
      routine: await scalar(db, "SELECT COUNT(*) n FROM email_channels WHERE routine_enabled=1"),
    };
    await set(db, "account_reclaim_enabled", true);
    await set(db, "seat_reclaim_enabled", true);
    await run(
      db,
      "INSERT INTO activity_write_failures(metric,utc_day,failures,last_success_at,updated_at) VALUES('feed_poll_merge',?,0,?,?) ON CONFLICT(metric,utc_day) DO UPDATE SET last_success_at=excluded.last_success_at",
      C.utcDayPeriod(T).key,
      T,
      T,
    );
    await set(db, "reclaim_paused", true);
    const candidate = (await listReclaimCandidates(db, T)).candidates[0];
    const input = {
      user_id: candidate.id,
      activity_at: candidate.activity_at,
      grace_until: candidate.reclaim_grace_until,
      channel_revision: candidate.channel_revision ?? 0,
      reason: "synthetic explicit review",
      kind: "seat" as const,
    };
    let pauseRefused = false;
    try {
      await confirmReclaim(db, input, "synthetic-admin", T, [
        calendarLifecycle,
        emailLifecycleHook,
      ]);
    } catch {
      pauseRefused = true;
    }
    await set(db, "reclaim_paused", false);
    // Scanning cannot delete an unconfirmed candidate, even after grace.
    await scanAccountPage(db, T, 0);
    const scanned = await scalar(db, "SELECT COUNT(*) n FROM users WHERE status='active'");
    const ledgerBefore = JSON.stringify(await readMailDayLedger(db, C.utcDayPeriod(T).key));
    await confirmReclaim(db, input, "synthetic-admin", T, [calendarLifecycle, emailLifecycleHook]);
    const current = (await listReclaimCandidates(db, T)).candidates.find(
      (c) => c.id === candidate.id,
    );
    if (!current) throw new Error("synthetic candidate missing");
    await confirmReclaim(
      db,
      { ...input, kind: "account", channel_revision: current.channel_revision ?? 0 },
      "synthetic-admin",
      T,
      [calendarLifecycle, emailLifecycleHook],
    );
    let done = false;
    for (let page = 0; page < C.ACCOUNT_MAX_STORED && !done; page++)
      done =
        (await cleanupDeletedAccountPage(db, candidate.id, C.MATCH_PAGE, T)).state === "complete";
    const renewed = await db
      .prepare("SELECT lease_expires_at FROM email_channels WHERE user_id='synthetic-capacity-0'")
      .first<number>("lease_expires_at");
    return {
      before,
      scanned,
      pauseRefused,
      done,
      feedOnlyRenewed: renewed !== null && renewed > T,
      after: {
        accounts: await scalar(db, "SELECT value n FROM capacity_state WHERE key='accounts_total'"),
        seats: await scalar(db, "SELECT COUNT(*) n FROM email_channels WHERE enabled=1"),
      },
      ledgerUnchanged:
        ledgerBefore === JSON.stringify(await readMailDayLedger(db, C.utcDayPeriod(T).key)),
    };
  }
  if (action === "feedback-seed") {
    const n = C.FEEDBACK_BATCH * C.FEEDBACK_MAINTENANCE_ROUNDS;
    const p = C.utcDayPeriod(T);
    await run(
      db,
      "INSERT INTO usage_periods(id,pool,period_kind,period_key,uncertain,period_start,period_end,created_at,updated_at) VALUES('synthetic-feedback-budget','existing_auth',?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      C.BUDGET_PERIOD_KIND,
      p.key,
      0,
      p.startMs,
      p.endMsExclusive,
      T,
      T,
    );
    if (offset === 0)
      await run(
        db,
        "UPDATE usage_periods SET uncertain=uncertain+? WHERE pool='existing_auth' AND user_id IS NULL AND period_key=?",
        n + 1,
        p.key,
      );
    for (let i = offset; i < Math.min(offset + C.FEEDBACK_BATCH, n + 1); i++) {
      const id = `synthetic-feedback-${i}`;
      await db.batch([
        db
          .prepare(
            "INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at) VALUES(?,?,?,'delivered',?,'{}',?)",
          )
          .bind(
            `${id}-expired`,
            `${id}-expired`,
            `${id}-expired`,
            T,
            T - C.MAIL_FEEDBACK_TTL * 1000,
          ),
        db
          .prepare(
            "INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,status,message_id,created_at,updated_at) VALUES(?,'existing_auth',0,?,1,'synthetic','unknown',?,?,?)",
          )
          .bind(id, p.key, id, T, T),
        db
          .prepare(
            "INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at) VALUES(?,?,?,'bounced',?,?,?)",
          )
          .bind(
            id,
            id,
            id,
            T,
            JSON.stringify({
              addressKey: id,
              suppression: "hard_bounce",
              stage: "pending",
              leaseUntil: 0,
              token: null,
            }),
            T,
          ),
      ]);
    }
    return { next: offset + C.FEEDBACK_BATCH <= n ? offset + C.FEEDBACK_BATCH : null };
  }
  if (action === "combined") {
    const result = await runScheduledMaintenance(
      db,
      (bounded) =>
        maintainFeedback(
          bounded,
          async () => ({ lookup: ring.emailLookup(), field: ring.fieldEncryption() }),
          () => T,
        ),
      () => T,
    );
    return result;
  }
  if (action === "feedback-check") {
    return {
      doneFeedback: await scalar(
        db,
        "SELECT COUNT(*) n FROM mail_feedback WHERE json_extract(raw_ref,'$.stage')='done'",
      ),
      leftUnknown: await scalar(
        db,
        "SELECT COUNT(*) n FROM mail_outbox WHERE payload_kind='synthetic' AND status='unknown'",
      ),
    };
  }

  throw new Error("unknown local fixture action");
}
