// P5-03: local-only backup tooling. No network, provider, Wrangler or deployment calls.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { articleContentHash } from "../../apps/worker/src/sources/articles/blocks.ts";
import { decryptField, encryptField } from "../../apps/worker/src/storage/crypto/aead.ts";
import { Keyring } from "../../apps/worker/src/storage/crypto/keyring.ts";
import { ACCOUNT_DELETING_STATUS } from "../../packages/contracts/src/account-lifecycle.ts";
import { OPERATIONAL_CONTROLS } from "../../packages/contracts/src/observability/index.ts";
import {
  BACKUP_COPIES,
  BACKUP_INTERVAL,
  SECRET_BITS,
} from "../../packages/contracts/src/params/registry.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const format = "hoyo-independent-backup-v1";
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const q = (name) => `"${name.replaceAll('"', '""')}"`;
export function demand(value, code) {
  if (!value) throw new Error(code);
}
export function migrations() {
  return readdirSync(resolve(root, "migrations"))
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(root, "migrations", name), "utf8") }));
}
export function schema() {
  const db = new DatabaseSync(":memory:");
  for (const m of migrations()) db.exec(m.sql);
  return db;
}
export const tables = (db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
export const rows = (db, name) => db.prepare(`SELECT * FROM ${q(name)}`).all();
const encode = (value) =>
  value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : value;
const decode = (value) =>
  value && typeof value === "object" ? Buffer.from(value.blob, "base64") : value;
function shape(db) {
  return tables(db)
    .filter((n) => !["d1_migrations", "_cf_KV"].includes(n))
    .map((name) => ({
      name,
      columns: db.prepare(`PRAGMA table_info(${q(name)})`).all(),
      indexes: db
        .prepare(`PRAGMA index_list(${q(name)})`)
        .all()
        .map(({ name: index, unique, partial }) => ({
          name: index,
          unique,
          partial,
          columns: db
            .prepare(`PRAGMA index_info(${q(index)})`)
            .all()
            .map((r) => r.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
export function checkSchema(db) {
  const expected = schema();
  try {
    demand(JSON.stringify(shape(db)) === JSON.stringify(shape(expected)), "schema_mismatch");
    demand(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "integrity_failed");
    demand(
      db.prepare("PRAGMA foreign_key_check").all().length === 0,
      "evidence_or_foreign_key_missing",
    );
  } finally {
    expected.close();
  }
}
// Import only into memory; refuse SQL with filesystem side effects and never print SQL errors.
export function importSql(sql) {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
    allowExtension: false,
  });
  db.setAuthorizer((action, first) => {
    if (
      [constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_CREATE_VTABLE].includes(
        action,
      )
    )
      return constants.SQLITE_DENY;
    if (
      action === constants.SQLITE_PRAGMA &&
      !["foreign_keys", "defer_foreign_keys"].includes(first)
    )
      return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
  try {
    db.exec(sql);
    db.setAuthorizer(null);
    checkSchema(db);
    return db;
  } catch {
    db.close();
    throw new Error("sql_import_rejected");
  }
}
export function dump(db) {
  const objects = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const literal = (v) =>
    v === null
      ? "NULL"
      : v instanceof Uint8Array
        ? `X'${Buffer.from(v).toString("hex")}'`
        : typeof v === "number"
          ? String(v)
          : `'${v.replaceAll("'", "''")}'`;
  return [
    "PRAGMA defer_foreign_keys=ON;",
    ...objects.filter((o) => o.type === "table").map((o) => `${o.sql};`),
    ...tables(db).flatMap((name) =>
      rows(db, name).map(
        (row) =>
          `INSERT INTO ${q(name)} (${Object.keys(row).map(q).join(",")}) VALUES (${Object.values(row).map(literal).join(",")});`,
      ),
    ),
    ...objects.filter((o) => o.type !== "table").map((o) => `${o.sql};`),
  ].join("\n");
}
export async function keyring(master) {
  // Only the field key is used; never load an OTP or unsubscribe secret into the backup tool.
  return Keyring.create({
    masterSecret: master,
    otpPepper: randomBytes(SECRET_BITS / 8),
    unsubscribeMacCurrentKeyId: "k1",
  });
}
const fields = [
  ["users", "email_ciphertext", "delivery-email-address", "id"],
  ["auth_challenges", "delivery_address_ciphertext", "delivery-email-address", "id"],
  ["auth_challenges", "receipt_ciphertext", "auth-completion-receipt", "id"],
  ["calendar_feeds", "token_ciphertext", "feed-token-owner-copy", "namespace"],
  ["mail_outbox", "payload_ciphertext", "otp-mail-payload", "id"],
];
export async function validate(db, ring) {
  checkSchema(db);
  let ciphertexts = 0;
  for (const [table, column, type, id] of fields) {
    for (const row of rows(db, table)) {
      const blob = row[column];
      if (
        blob === null ||
        (blob.length === 0 &&
          ((table === "calendar_feeds" && row.state === "disabled") ||
            (table === "users" &&
              row.status === ACCOUNT_DELETING_STATUS &&
              row.deletion_completed_at !== null)))
      )
        continue;
      const plain = await decryptField(ring.fieldEncryption(), { type, id: row[id] }, blob);
      if (table === "calendar_feeds")
        demand(digest(plain) === row.token_hash, "feed_token_hash_mismatch");
      plain.fill(0);
      ciphertexts++;
    }
  }
  // P6 is not enabled and has no registered field-AAD format yet. Never pretend to validate it.
  demand(rows(db, "push_bindings").length === 0, "push_ciphertext_format_not_implemented");
  demand(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM events e WHERE NOT EXISTS (SELECT 1 FROM evidence v WHERE v.event_id=e.id)",
      )
      .get().n === 0,
    "formal_event_evidence_missing",
  );
  for (const row of rows(db, "article_versions")) {
    demand(
      (await articleContentHash(
        JSON.parse(row.body_blocks_json),
        JSON.parse(row.media_refs_json),
      )) === row.content_hash,
      "evidence_hash_mismatch",
    );
  }
  for (const row of db
    .prepare(
      "SELECT e.block_ref,v.body_blocks_json FROM evidence e JOIN article_versions v ON v.id=e.article_version_id",
    )
    .all()) {
    const match = /^blocks\/(\d+)$/.exec(row.block_ref);
    demand(
      match && JSON.parse(row.body_blocks_json)[Number(match[1])] !== undefined,
      "evidence_block_missing",
    );
  }
  return { tables: tables(db).length, ciphertexts, evidence: rows(db, "evidence").length };
}
export function seal(payload, key) {
  demand(key.length * 8 === SECRET_BITS, "backup_key_size");
  const iv = randomBytes(12); // AES-GCM protocol nonce size, not a business parameter.
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(format));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.from(
    JSON.stringify({
      format,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      encrypted: encrypted.toString("base64"),
    }),
  );
}
export function unseal(bytes, key) {
  try {
    const e = JSON.parse(bytes);
    demand(e.format === format, "format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
    decipher.setAAD(Buffer.from(format));
    decipher.setAuthTag(Buffer.from(e.tag, "base64"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(e.encrypted, "base64")), decipher.final()]),
    );
  } catch {
    throw new Error("backup_authentication_failed");
  }
}
export async function capture(db, ring, now = Date.now()) {
  const checked = await validate(db, ring);
  return {
    format,
    capturedAt: now,
    migrations: migrations().map(({ name, sql }) => ({ name, sha256: digest(sql) })),
    policy: { BACKUP_INTERVAL, BACKUP_COPIES },
    checked,
    tables: tables(db)
      .filter((n) => !["_cf_KV", "d1_migrations"].includes(n))
      .map((name) => ({
        name,
        rows: rows(db, name).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encode(v)])),
        ),
      })),
  };
}
export function materialize(payload) {
  demand(payload.format === format && Number.isSafeInteger(payload.capturedAt), "invalid_manifest");
  demand(
    JSON.stringify(payload.migrations) ===
      JSON.stringify(migrations().map(({ name, sql }) => ({ name, sha256: digest(sql) }))),
    "migration_chain_mismatch",
  );
  const db = schema();
  try {
    demand(
      JSON.stringify(payload.tables.map((t) => t.name)) === JSON.stringify(tables(db)),
      "table_coverage_mismatch",
    );
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    // Seed state and triggers must not modify the captured facts while loading.
    const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    for (const t of triggers) db.exec(`DROP TRIGGER ${q(t.name)}`);
    for (const t of payload.tables) {
      db.exec(`DELETE FROM ${q(t.name)}`);
      for (const row of t.rows) {
        const keys = Object.keys(row);
        db.prepare(
          `INSERT INTO ${q(t.name)} (${keys.map(q).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        ).run(...Object.values(row).map(decode));
      }
    }
    for (const t of triggers) db.exec(t.sql);
    db.exec("COMMIT; PRAGMA foreign_keys=ON");
    checkSchema(db);
    return db;
  } catch {
    db.close();
    throw new Error("snapshot_rejected");
  }
}
export function closeControls(db, now) {
  const put = db.prepare(
    "INSERT INTO system_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  );
  for (const key of OPERATIONAL_CONTROLS.filter((k) => k !== "source_enabled"))
    put.run(key, key === "read_only" ? "true" : "false", now);
  for (const row of rows(db, "sources")) put.run(`source:${row.source_id}`, "false", now);
}
export async function restore(payload, ring, current, now = Date.now()) {
  // current is separately kept, owner attested at the recovery freeze, never derived from payload.
  demand(current.isolated === true && current.outboundDetached === true, "isolation_required");
  demand(
    current.observedAt >= payload.capturedAt &&
      current.observedAt <= now &&
      current.freezeAt === current.observedAt,
    "current_record_required",
  );
  demand(Number.isSafeInteger(current.epoch) && current.epoch > 0, "current_epoch_required");
  const db = materialize(payload);
  try {
    closeControls(db, now);
    const checked = await validate(db, ring);
    const maximum = db.prepare("SELECT MAX(recovery_epoch) AS value FROM users").get().value ?? 0;
    demand(current.epoch > maximum, "epoch_must_advance");
    db.exec("BEGIN");
    db.prepare("UPDATE users SET recovery_epoch=?,auth_epoch=auth_epoch+1,updated_at=?").run(
      current.epoch,
      now,
    );
    db.prepare(
      "UPDATE sessions SET state='revoked',revoked_at=?,revoke_reason='disaster_restore',updated_at=?",
    ).run(now, now);
    db.prepare("UPDATE admin_sessions SET revoked_at=?").run(now);
    db.prepare(
      "UPDATE auth_challenges SET aborted_at=COALESCE(aborted_at,?),receipt_ciphertext=NULL,receipt_expires_at=NULL,delivery_address_ciphertext=NULL,updated_at=?",
    ).run(now, now);
    db.prepare(
      "UPDATE recent_auth_challenges SET aborted_at=COALESCE(aborted_at,?),updated_at=?",
    ).run(now, now);
    db.prepare(
      "UPDATE recent_auth_proofs SET consumed_at=COALESCE(consumed_at,?),expires_at=MIN(expires_at,?)",
    ).run(now, now);
    db.prepare("UPDATE recovery_rotations SET expires_at=MIN(expires_at,?)").run(now);
    // Disaster revocation, not the emergency-stop flow: unknown consumption cannot resurrect codes.
    db.prepare(
      "UPDATE recovery_credentials SET consumed_at=COALESCE(consumed_at,?),updated_at=?",
    ).run(now, now);
    db.prepare(
      "UPDATE email_channels SET enabled=0,routine_enabled=0,lease_expires_at=NULL,channel_revision=channel_revision+1,updated_at=?",
    ).run(now);
    db.prepare(
      "UPDATE push_bindings SET state='paused',receipt_token_hash=NULL,binding_version=binding_version+1,updated_at=?",
    ).run(now);
    // Reconcile identities conservatively. Missing, changed binding, or non-active live identity
    // blocks ALL account reopening until the owner has reconciled the current identity ledger.
    const active = new Map((current.activeIdentities ?? []).map((u) => [u.id, u]));
    demand(current.revocationsComplete === true || active.size === 0, "untrusted_identity_list");
    let unresolvedAccounts = 0;
    for (const u of rows(db, "users")) {
      if (u.status !== "active") continue;
      const live = active.get(u.id);
      if (
        !(
          current.revocationsComplete === true &&
          live?.email_binding_id === u.email_binding_id &&
          live?.email_version === u.email_version &&
          live?.email_key === u.email_key &&
          u.status === "active"
        )
      ) {
        unresolvedAccounts++;
      }
    }
    // No synthetic account status, no deletion requested on behalf of users. The output stays
    // offline/read-only with all authentication results revoked. Release is a separate owner gate.
    const heights = new Map((current.feedHighWater ?? []).map((h) => [h.namespace, h]));
    let migrationRequired = 0;
    const publicMaximum =
      db.prepare("SELECT MAX(public_ical_revision) AS n FROM milestones").get().n ?? 0;
    for (const feed of rows(db, "calendar_feeds")) {
      const high = heights.get(feed.namespace);
      const proved =
        current.versionsComplete === true &&
        Number.isSafeInteger(high?.maxSequence) &&
        high.maxSequence >= feed.view_revision + publicMaximum &&
        high.maxSequence < Number.MAX_SAFE_INTEGER - publicMaximum - 1;
      // Raising the feed component above every proven prior SEQUENCE preserves each UID and
      // makes the sum monotone without forging event/schedule/public revisions.
      const version = proved ? high.maxSequence + 1 : feed.view_revision;
      if (!proved) migrationRequired++;
      db.prepare(
        "UPDATE calendar_feeds SET state='disabled',token_hash=?,token_ciphertext=X'',token_generation=token_generation+1,view_revision=?,changed_at=?,updated_at=? WHERE user_id=?",
      ).run(digest(randomBytes(SECRET_BITS / 8)), version, now, now, feed.user_id);
    }
    // Keep historical dedupe/accepted facts, terminalize all uncertain or runnable old work.
    db.prepare(
      "UPDATE mail_outbox SET status=CASE WHEN status IN ('leased','calling_provider','unknown') THEN 'unknown' WHEN status IN ('pending','retry_wait') THEN 'skipped' ELSE status END,payload_ciphertext=NULL,lease_version=lease_version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=?",
    ).run(now);
    db.prepare(
      "UPDATE deliveries SET status=CASE WHEN status IN ('leased','calling_provider','unknown') THEN 'unknown' WHEN status IN ('pending','retry_wait') THEN 'skipped' ELSE status END,skip_reason=CASE WHEN status IN ('pending','retry_wait') THEN 'disaster_restore' ELSE skip_reason END,updated_at=?",
    ).run(now);
    db.prepare("UPDATE occurrences SET invalidated_at=COALESCE(invalidated_at,?)").run(now);
    db.prepare(
      "UPDATE jobs SET status='failed',lease_version=lease_version+1,lease_owner=NULL,lease_expires_at=NULL,last_error='disaster_restore_reconcile',updated_at=? WHERE status<>'done'",
    ).run(now);
    db.prepare(
      "UPDATE outbox SET dispatch_state='dispatched',dispatched_at=COALESCE(dispatched_at,?)",
    ).run(now);
    // Never refund historical daily budget; reservations and uncertain counts stay consumed.
    db.exec("COMMIT");
    checkSchema(db);
    return {
      db,
      report: {
        ...checked,
        stage: "isolated_reconciled",
        sendingEnabled: false,
        accountReleaseRequiresOwner: true,
        unresolvedAccounts,
        migrationRequired,
        oldCredentialsRevoked: true,
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
export function privateFile(path) {
  const stat = lstatSync(path);
  demand(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "private_file_required",
  );
  outsideRepo(path);
  return readFileSync(path);
}
export function outsideRepo(path) {
  const parent = realpathSync(dirname(resolve(path)));
  let ancestor = parent;
  while (ancestor !== dirname(ancestor)) {
    demand(!existsSync(resolve(ancestor, ".git")), "repository_secret_path_forbidden");
    ancestor = dirname(ancestor);
  }
  const rel = relative(root, resolve(parent, path.split("/").at(-1)));
  demand(
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel),
    "repository_secret_path_forbidden",
  );
}
export function writePrivate(path, bytes) {
  outsideRepo(path);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.partial`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    linkSync(temporary, path); // atomic publish; existing paths/symlinks are never overwritten
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export async function rotateFields(db, oldRing, newRing) {
  await validate(db, oldRing);
  const changes = [];
  for (const [table, column, type, id] of fields)
    for (const row of rows(db, table)) {
      if (!row[column]?.length) continue;
      const plain = await decryptField(
        oldRing.fieldEncryption(),
        { type, id: row[id] },
        row[column],
      );
      const encrypted = await encryptField(newRing.fieldEncryption(), { type, id: row[id] }, plain);
      plain.fill(0);
      changes.push([table, column, id, row[id], encrypted]);
    }
  db.exec("BEGIN");
  try {
    for (const [table, column, id, value, encrypted] of changes)
      db.prepare(`UPDATE ${q(table)} SET ${q(column)}=? WHERE ${q(id)}=?`).run(encrypted, value);
    await validate(db, newRing);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export { BACKUP_COPIES, BACKUP_INTERVAL };
