import { randomBytes } from "node:crypto";
import { articleContentHash } from "../../apps/worker/src/sources/articles/blocks.ts";
import { encryptField } from "../../apps/worker/src/storage/crypto/aead.ts";
import { SECRET_BITS } from "../../packages/contracts/src/params/registry.ts";
import { closeControls, digest, q, schema } from "./core.mjs";

export const syntheticTime = Date.UTC(2026, 9, 3);
export function insert(db, table, row) {
  db.prepare(
    `INSERT INTO ${q(table)} (${Object.keys(row).map(q).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}
export async function synthetic(ring) {
  const db = schema();
  const t = syntheticTime;
  const dates = { created_at: t, updated_at: t };
  insert(db, "sources", {
    source_id: "synthetic-source",
    game: "genshin",
    region: "cn",
    adapter: "synthetic",
    approved_hosts_json: "[]",
    verified_publishers_json: "[]",
    cursor_json: "{}",
    poll_policy_json: "{}",
    verification_state: "synthetic",
    ...dates,
  });
  insert(db, "articles", {
    id: "synthetic-article",
    source_id: "synthetic-source",
    external_id: "synthetic",
    official_url: "https://example.invalid/synthetic",
    first_seen_at: t,
    last_checked_at: t,
    ...dates,
  });
  const blocks = [{ type: "text", text: "synthetic event evidence" }];
  insert(db, "article_versions", {
    id: "synthetic-version",
    article_id: "synthetic-article",
    version_no: 1,
    content_hash: await articleContentHash(blocks, []),
    body_blocks_json: JSON.stringify(blocks),
    media_refs_json: "[]",
    completeness: "complete",
    fetched_at: t,
    created_at: t,
  });
  insert(db, "events", {
    id: "synthetic-event",
    game: "genshin",
    region: "cn",
    event_type: "limited_event",
    status: "scheduled",
    title: "synthetic event",
    official_url: "https://example.invalid/synthetic",
    detail_path: "/events/synthetic-event",
    event_revision: 7,
    schedule_revision: 3,
    human_locked: 0,
    ...dates,
  });
  insert(db, "milestones", {
    id: "synthetic-node",
    event_id: "synthetic-event",
    milestone_key: "start",
    node_type: "start",
    title: "synthetic",
    time_exact_ms: t,
    source_timezone: "UTC",
    raw_expression: "synthetic",
    time_basis: "official_explicit",
    time_precision: "datetime",
    public_ical_revision: 9,
    ...dates,
  });
  insert(db, "evidence", {
    id: "synthetic-evidence",
    event_id: "synthetic-event",
    milestone_id: "synthetic-node",
    article_version_id: "synthetic-version",
    block_ref: "blocks/0",
    created_at: t,
  });
  insert(db, "event_revisions", {
    id: "synthetic-revision",
    event_id: "synthetic-event",
    revision_no: 7,
    change_kind: "important_change",
    actor_path: "human",
    diff_json: "{}",
    created_at: t,
  });
  const address = await encryptField(
    ring.fieldEncryption(),
    { type: "delivery-email-address", id: "synthetic-user" },
    "synthetic@example.invalid",
  );
  insert(db, "users", {
    id: "synthetic-user",
    order: 1,
    status: "active",
    email_key: "synthetic-lookup",
    email_binding_id: "synthetic-binding",
    email_ciphertext: address,
    email_version: 1,
    auth_epoch: 2,
    recovery_epoch: 4,
    ...dates,
  });
  insert(db, "sessions", {
    id: "synthetic-session",
    user_id: "synthetic-user",
    token_hash: "synthetic-session-hash",
    state: "active",
    label: "synthetic",
    platform_hint: "desktop",
    issued_at: t,
    absolute_expires_at: t + 1000,
    expires_at: t + 1000,
    renewed_at: t,
    auth_epoch: 2,
    recovery_epoch: 4,
    ...dates,
  });
  insert(db, "recovery_credentials", {
    id: "synthetic-recovery",
    user_id: "synthetic-user",
    secret_hash: "synthetic-hash",
    generation: 1,
    saved_confirmed_at: t,
    ...dates,
  });
  insert(db, "email_channels", {
    user_id: "synthetic-user",
    enabled: 1,
    routine_enabled: 1,
    consent_version: 2,
    address_version: 1,
    ...dates,
  });
  insert(db, "consent_events", {
    id: "synthetic-consent",
    user_id: "synthetic-user",
    email_binding_id: "synthetic-binding",
    layer: "seat",
    action: "enable",
    consent_version: 2,
    created_at: t,
  });
  insert(db, "suppressions", {
    id: "synthetic-suppression",
    address_key: "synthetic-address-key",
    email_binding_id: "synthetic-binding",
    kind: "complaint",
    read_only: 1,
    created_at: t,
  });
  const token = randomBytes(SECRET_BITS / 8).toString("hex");
  insert(db, "calendar_feeds", {
    user_id: "synthetic-user",
    namespace: "synthetic-namespace",
    state: "enabled",
    token_hash: digest(token),
    token_ciphertext: await encryptField(
      ring.fieldEncryption(),
      { type: "feed-token-owner-copy", id: "synthetic-namespace" },
      token,
    ),
    view_revision: 8,
    recovery_epoch: 4,
    changed_at: t,
    ...dates,
  });
  // P6 (ADR-0025): an active push binding whose endpoint/keys are controlled ciphertexts.
  insert(db, "push_bindings", {
    id: "synthetic-push-binding",
    user_id: "synthetic-user",
    endpoint_hash: digest("https://fcm.googleapis.com/fcm/send/synthetic"),
    endpoint_ciphertext: await encryptField(
      ring.fieldEncryption(),
      { type: "push-endpoint", id: "synthetic-push-binding" },
      "https://fcm.googleapis.com/fcm/send/synthetic",
    ),
    keys_ciphertext: await encryptField(
      ring.fieldEncryption(),
      { type: "push-keys", id: "synthetic-push-binding" },
      JSON.stringify({ p256dh: "synthetic-p256dh", auth: "synthetic-auth" }),
    ),
    state: "active",
    binding_version: 3,
    receipt_token_hash: digest("synthetic-receipt"),
    lease_expires_at: t + 1000,
    activated_at: t,
    push_service: "fcm",
    ...dates,
  });
  insert(db, "auth_challenges", {
    id: "synthetic-challenge",
    purpose: "login",
    email_key: "synthetic-lookup",
    address_version: 1,
    preauth_id: "synthetic-preauth",
    mac: "synthetic-mac",
    deadline: t + 1000,
    receipt_ciphertext: await encryptField(
      ring.fieldEncryption(),
      { type: "auth-completion-receipt", id: "synthetic-challenge" },
      "synthetic-receipt",
    ),
    ...dates,
  });
  insert(db, "mail_outbox", {
    id: "synthetic-mail",
    purpose: "existing_auth",
    priority: 0,
    period_key: "2026-10-03",
    recipient_user_id: "synthetic-user",
    address_version: 1,
    payload_kind: "otp-mail-payload",
    payload_ciphertext: await encryptField(
      ring.fieldEncryption(),
      { type: "otp-mail-payload", id: "synthetic-mail" },
      "synthetic-payload",
    ),
    status: "calling_provider",
    lease_version: 6,
    ...dates,
  });
  insert(db, "occurrences", {
    id: "synthetic-occurrence",
    event_id: "synthetic-event",
    milestone_id: "synthetic-node",
    schedule_revision: 3,
    kind: "new_event",
    due_at: t,
    expires_at: t + 1000,
    created_at: t,
  });
  insert(db, "deliveries", {
    id: "synthetic-delivery",
    occurrence_id: "synthetic-occurrence",
    user_id: "synthetic-user",
    channel: "email",
    target_ref: "synthetic-user",
    milestone_id: "synthetic-node",
    schedule_revision: 3,
    kind: "new_event",
    priority: 5,
    dedupe_family: "synthetic-family",
    mail_outbox_ref: "synthetic-mail",
    status: "pending",
    expires_at: t + 1000,
    ...dates,
  });
  insert(db, "jobs", {
    id: "synthetic-job",
    kind: "source_poll",
    payload_json: "{}",
    due_at: t,
    status: "leased",
    lease_version: 7,
    lease_owner: "synthetic-old-do",
    lease_expires_at: t + 1000,
    ...dates,
  });
  insert(db, "usage_periods", {
    id: "synthetic-usage",
    pool: "existing_auth",
    period_kind: "utc_day",
    period_key: "2026-10-03",
    reserved: 1,
    settled: 1,
    uncertain: 1,
    period_start: t,
    period_end: t + 1000,
    ...dates,
  });
  closeControls(db, t);
  return db;
}
export function currentRecord(overrides = {}) {
  return {
    isolated: true,
    outboundDetached: true,
    observedAt: syntheticTime + 1,
    freezeAt: syntheticTime + 1,
    epoch: 5,
    revocationsComplete: false,
    versionsComplete: false,
    ...overrides,
  };
}
