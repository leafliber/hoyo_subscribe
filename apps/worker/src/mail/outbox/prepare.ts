import {
  AUTH_MAIL_POOLS,
  canonicalizeEmail,
  type FieldEncryptionKey,
  OTP_DIGITS,
} from "@hoyo/contracts";
import { decryptDeliveryAddress } from "../../auth/challenges/delivery";
import {
  asEnvelopeBytes,
  decryptOtpPayload,
  OTP_PAYLOAD_KIND,
} from "../../auth/challenges/payload";
import { conditionalCommit, type SqlParam } from "../../storage/cas";
import { AUDIENCE_SELECT } from "../occurrences/eligibility";
import { reviewDeliveryBeforeSend } from "../occurrences/review";
import { authTemplate, type DigestNode, digestTemplate } from "../provider/templates";
import type { ServerMail } from "../provider/types";
import { type Invalidation, MailDataError, type MailRow } from "./types";

export interface MailContentDeps {
  fieldKey: () => Promise<FieldEncryptionKey>;
  origin: string;
  // P4-06 提供已可用的正文确认入口及 RFC8058 入口；未接通时业务信失败关闭。
  unsubscribe?: (bindingId: string) => Promise<{ page: string; oneClick: string }>;
}
export type PreparedMail =
  | { invalid: Invalidation }
  | {
      mail: ServerMail;
      guard: { sql: string; params: SqlParam[] };
      expiresAt: number;
    };
const AUTH_SQL = `SELECT json_object(
  'regular',(SELECT json_object('generation',c.generation,'deadline',c.deadline,'consumed',c.consumed_at,
    'aborted',c.aborted_at,'purpose',c.purpose,'version',c.address_version,'email_key',c.email_key)
    FROM auth_challenges c WHERE c.id = ?),
  'recent',(SELECT json_object('generation',0,'deadline',c.deadline,'consumed',c.consumed_at,
    'aborted',c.aborted_at,'role',c.role,'version',c.address_version,'session_expiry',(SELECT MIN(expires_at,absolute_expires_at) FROM sessions WHERE id=c.session_id),'session_ok',EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=c.session_id AND s.user_id=c.user_id AND s.state='active' AND s.expires_at > ? AND s.absolute_expires_at > ?
      AND s.auth_epoch=u.auth_epoch AND s.recovery_epoch=u.recovery_epoch)) FROM recent_auth_challenges c WHERE c.id=? AND c.outbox_id=?),
  'user',(SELECT json_object('status',status,'version',email_version,'email_key',email_key,'binding',email_binding_id) FROM users WHERE id=?),
  'suppressed',EXISTS(SELECT 1 FROM suppressions WHERE email_binding_id=(SELECT email_binding_id FROM users WHERE id=?)
    AND (expires_at IS NULL OR expires_at > ?))) AS snapshot`;
interface AuthSnapshot {
  regular: {
    generation: number;
    deadline: number;
    consumed: number | null;
    aborted: number | null;
    purpose: string;
    version: number;
    email_key: string;
  } | null;
  recent: {
    generation: number;
    deadline: number;
    consumed: number | null;
    aborted: number | null;
    version: number;
    session_ok: number;
    session_expiry: number;
    role: string;
  } | null;
  user: { status: string; version: number; email_key: string; binding: string } | null;
  suppressed: number;
}
// 快照在读取/解密/复核前取得，calling_provider 的同一事务再次核对，消除退订/换绑/改期竞态。
const DIGEST_SQL = `SELECT json_object(
  'audience',(SELECT json_object('status',a.status,'version',a.email_version,'binding',a.email_binding_id,
    'subscription',a.subscription_revision,'state',a.subscription_state,'channel',a.channel_enabled,'routine',a.routine_enabled,
    'channel_version',a.channel_address_version,'lease',a.lease_expires_at,'seat_at',a.seat_enabled_at,'routine_at',a.routine_enabled_at,'suppressed',a.suppressed)
    FROM (${AUDIENCE_SELECT} WHERE u.id=?) a),
  'interests',json((SELECT json_group_array(json_object('id',id,'at',enabled_at)) FROM (SELECT * FROM subscription_interests WHERE user_id=? ORDER BY id))),
  'deliveries',json((SELECT json_group_array(json_object('id',d.id,'status',d.status,'user',d.user_id,'target',d.target_ref,
    'expiry',d.expires_at,'schedule',d.schedule_revision,'event_revision',e.event_revision,'current',e.schedule_revision,
    'invalidated',o.invalidated_at,'occurrence_expiry',o.expires_at)) FROM deliveries d JOIN occurrences o ON o.id=d.occurrence_id
    JOIN events e ON e.id=o.event_id WHERE d.mail_outbox_ref=?))) AS snapshot`;
async function snapshot(db: D1Database, sql: string, params: SqlParam[]): Promise<string> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<{ snapshot: string }>();
  if (!row) throw new MailDataError("missing_snapshot");
  return row.snapshot;
}
function addressValid(address: string) {
  if (!canonicalizeEmail(address).ok || /[\r\n]/.test(address))
    throw new MailDataError("invalid_recipient");
}
export async function prepareMail(
  db: D1Database,
  row: MailRow,
  now: number,
  deps: MailContentDeps,
): Promise<PreparedMail> {
  if ((AUTH_MAIL_POOLS as readonly string[]).includes(row.purpose)) {
    if (row.payload_kind !== OTP_PAYLOAD_KIND || !row.payload_ref)
      throw new MailDataError("auth_payload_kind");
    const params: SqlParam[] = [
      row.payload_ref,
      now,
      now,
      row.payload_ref,
      row.id,
      row.recipient_user_id,
      row.recipient_user_id,
      now,
    ];
    const before = await snapshot(db, AUTH_SQL, params);
    const state = JSON.parse(before) as AuthSnapshot;
    const challenge = state.regular ?? state.recent;
    if (!challenge || challenge.consumed !== null || challenge.aborted !== null)
      return { invalid: "superseded" };
    if (challenge.deadline <= now) return { invalid: "expired" };
    if (
      (state.suppressed && state.recent?.role !== "new_address") ||
      (row.recipient_user_id !== null &&
        (state.user?.status !== "active" || state.user.version !== row.address_version))
    )
      return { invalid: "skipped" };
    if (state.regular && !["login", "signup"].includes(state.regular.purpose))
      return { invalid: "skipped" };
    if (
      state.regular?.purpose === "login" &&
      (!state.user || state.user.email_key !== state.regular.email_key)
    )
      return { invalid: "skipped" };
    if (state.recent && !state.recent.session_ok) return { invalid: "skipped" };
    if (challenge.version !== row.address_version || row.payload_ciphertext === null)
      return { invalid: "superseded" };
    const payload = await decryptOtpPayload(
      await deps.fieldKey(),
      row.id,
      asEnvelopeBytes(row.payload_ciphertext),
    );
    if (payload.challengeId !== row.payload_ref || payload.generation !== challenge.generation)
      return { invalid: "superseded" };
    if (!new RegExp(`^[0-9]{${OTP_DIGITS}}$`).test(payload.code))
      throw new MailDataError("invalid_code_shape");
    addressValid(payload.address);
    return {
      mail: authTemplate(payload.address, payload.code, challenge.deadline),
      expiresAt: Math.min(challenge.deadline, state.recent?.session_expiry ?? Infinity),
      guard: { sql: `(${AUTH_SQL}) = ?`, params: [...params, before] },
    };
  }
  if (
    row.payload_kind !== "notification_digest" ||
    row.payload_ref !== row.id ||
    !row.recipient_user_id ||
    !row.email_binding_id
  )
    throw new MailDataError("digest_reference");
  const params: SqlParam[] = [now, row.recipient_user_id, row.recipient_user_id, row.id];
  const before = await snapshot(db, DIGEST_SQL, params);
  const audience = await db
    .prepare("SELECT email_version,email_binding_id,email_ciphertext FROM users WHERE id=?")
    .bind(row.recipient_user_id)
    .first<{ email_version: number; email_binding_id: string; email_ciphertext: ArrayBuffer }>();
  if (
    !audience ||
    audience.email_version !== row.address_version ||
    audience.email_binding_id !== row.email_binding_id
  )
    return { invalid: "skipped" };
  const deliveries = (
    await db
      .prepare(`SELECT d.id,d.user_id,d.expires_at,e.title AS event_title,m.title AS node_title,m.node_type,d.kind,
    m.time_exact_ms,m.time_date,m.time_precision,m.source_timezone,m.time_basis,m.raw_expression,e.official_url,e.detail_path,
    (SELECT reason FROM event_revisions r WHERE r.event_id=e.id ORDER BY revision_no DESC LIMIT 1) AS reason
    FROM deliveries d JOIN milestones m ON m.id=d.milestone_id JOIN events e ON e.id=m.event_id WHERE d.mail_outbox_ref=? AND d.status IN ('pending','leased','retry_wait') ORDER BY d.id`)
      .bind(row.id)
      .all<DigestNode & { id: string; user_id: string; expires_at: number }>()
  ).results;
  if (deliveries.length === 0) return { invalid: "skipped" };
  const invalid: { id: string; status: Invalidation }[] = [];
  for (const delivery of deliveries) {
    if (delivery.user_id !== row.recipient_user_id) throw new MailDataError("mixed_recipients");
    const review = await reviewDeliveryBeforeSend(db, delivery.id, now);
    if (review !== "eligible")
      invalid.push({ id: delivery.id, status: review === "already_sent" ? "skipped" : review });
  }
  if (invalid.length) {
    const result = await conditionalCommit(db, {
      guard: {
        sql: `UPDATE mail_outbox SET updated_at=? WHERE id=? AND status='leased' AND lease_version=?
        AND lease_owner IS ? AND (${DIGEST_SQL})=?`,
        params: [now, row.id, row.lease_version, row.lease_owner, ...params, before],
      },
      effects: [
        {
          kind: "update",
          table: "deliveries",
          set: {
            status: {
              sql: "(SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.id')=deliveries.id)",
              params: [JSON.stringify(invalid)],
            },
            skip_reason: "preflight_invalid",
            updated_at: now,
          },
          where: {
            sql: "mail_outbox_ref=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
            params: [row.id, JSON.stringify(invalid)],
          },
        },
      ],
    });
    if (result.outcome !== "committed") throw new Error("preflight_changed");
    if (invalid.length === deliveries.length)
      return {
        invalid: invalid.every((d) => d.status === invalid[0].status)
          ? invalid[0].status
          : "skipped",
      };
    return prepareMail(db, row, now, deps);
  }
  if (!deps.unsubscribe) throw new MailDataError("unsubscribe_unconfigured");
  const address = await decryptDeliveryAddress(
    await deps.fieldKey(),
    row.recipient_user_id,
    asEnvelopeBytes(audience.email_ciphertext),
  );
  addressValid(address);
  return {
    mail: digestTemplate(
      address,
      deliveries,
      deps.origin,
      await deps.unsubscribe(row.email_binding_id),
    ),
    expiresAt: Math.min(...deliveries.map((d) => d.expires_at), JSON.parse(before).audience.lease),
    guard: { sql: `(${DIGEST_SQL}) = ?`, params: [...params, before] },
  };
}
