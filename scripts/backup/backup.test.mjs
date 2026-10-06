import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SECRET_BITS } from "../../packages/contracts/src/params/registry.ts";
import {
  capture,
  digest,
  dump,
  importSql,
  keyring,
  materialize,
  restore,
  rotateFields,
  rows,
  seal,
  unseal,
  validate,
} from "./core.mjs";
import { currentRecord, synthetic, syntheticTime } from "./synthetic.mjs";

const master = randomBytes(SECRET_BITS / 8),
  key = randomBytes(SECRET_BITS / 8);
const ring = await keyring(master);
async function fixture() {
  const db = await synthetic(ring);
  const payload = await capture(db, ring, syntheticTime);
  db.close();
  return payload;
}
test("A-P5-BACKUP full SQL export / authenticated encryption / verified isolated restore", async () => {
  const db = await synthetic(ring),
    sql = dump(db);
  db.close();
  const imported = importSql(sql);
  const payload = await capture(imported, ring, syntheticTime);
  imported.close();
  const bytes = seal(payload, key);
  assert(!bytes.includes(Buffer.from("synthetic-user")));
  assert.notDeepEqual(seal(payload, key), bytes);
  const { db: restored, report } = await restore(
    unseal(bytes, key),
    ring,
    currentRecord(),
    syntheticTime + 2,
  );
  try {
    assert.equal(report.migrationRequired, 1);
    assert.equal(report.sendingEnabled, false);
    assert.equal(rows(restored, "events")[0].event_revision, 7);
    assert.equal(rows(restored, "milestones")[0].public_ical_revision, 9);
    assert.equal(rows(restored, "evidence").length, 1);
    assert.equal(rows(restored, "consent_events").length, 1);
    assert.equal(rows(restored, "suppressions")[0].read_only, 1);
    assert.equal(rows(restored, "users")[0].recovery_epoch, 5);
    assert.equal(rows(restored, "sessions")[0].state, "revoked");
    assert(rows(restored, "recovery_credentials")[0].consumed_at);
    assert.equal(rows(restored, "auth_challenges")[0].receipt_ciphertext, null);
    assert.equal(rows(restored, "email_channels")[0].enabled, 0);
    assert.equal(rows(restored, "calendar_feeds")[0].state, "disabled");
    // P6 (ADR-0025): restored push bindings stay paused, receipts revoked, ciphertexts still valid.
    assert.deepEqual(
      (({ state, paused_reason, receipt_token_hash }) => ({
        state,
        paused_reason,
        receipt_token_hash,
      }))(rows(restored, "push_bindings")[0]),
      { state: "paused", paused_reason: "restore", receipt_token_hash: null },
    );
    assert.notEqual(
      rows(restored, "calendar_feeds")[0].token_hash,
      payload.tables.find((t) => t.name === "calendar_feeds").rows[0].token_hash,
    );
    assert(rows(restored, "occurrences")[0].invalidated_at);
    assert.equal(rows(restored, "deliveries")[0].status, "skipped");
    assert.equal(rows(restored, "mail_outbox")[0].status, "unknown");
    assert.equal(rows(restored, "mail_outbox")[0].payload_ciphertext, null);
    assert.equal(rows(restored, "usage_periods")[0].reserved, 1);
    assert.equal(
      rows(restored, "system_state").find((r) => r.key === "outbound_enabled").value_json,
      "false",
    );
    const again = importSql(dump(restored));
    await validate(again, ring);
    again.close();
  } finally {
    restored.close();
  }
});
test("A-P5-BACKUP damaged backup and wrong key fail authentication", async () => {
  const bytes = seal(await fixture(), key);
  const bad = JSON.parse(bytes);
  const c = Buffer.from(bad.encrypted, "base64");
  c[0] ^= 1;
  bad.encrypted = c.toString("base64");
  assert.throws(() => unseal(JSON.stringify(bad), key), /authentication/);
  assert.throws(() => unseal(bytes, randomBytes(SECRET_BITS / 8)), /authentication/);
});
test("A-P5-BACKUP schema, missing evidence and field ciphertext corruption fail closed", async () => {
  for (const change of [
    (p) => p.migrations.pop(),
    (p) => p.tables.find((t) => t.name === "article_versions").rows.splice(0),
    (p) => {
      p.tables.find((t) => t.name === "article_versions").rows[0].content_hash = digest("wrong");
    },
    (p) => {
      p.tables.find((t) => t.name === "evidence").rows[0].block_ref = "blocks/999";
    },
    (p) => {
      p.tables.find((t) => t.name === "users").rows[0].email_ciphertext.blob =
        Buffer.from("corrupt").toString("base64");
    },
    (p) => {
      // Moving a push endpoint ciphertext to another record id must fail AAD authentication.
      p.tables.find((t) => t.name === "push_bindings").rows[0].id = "synthetic-moved-binding";
    },
  ]) {
    const p = await fixture();
    change(p);
    await assert.rejects(() => restore(p, ring, currentRecord(), syntheticTime + 2));
  }
});
test("A-P5-BACKUP separate current epoch, freeze and isolation are mandatory", async () => {
  const p = await fixture();
  for (const patch of [
    { epoch: 4 },
    { epoch: undefined },
    { isolated: false },
    { outboundDetached: false },
    { observedAt: syntheticTime - 1 },
    { freezeAt: 0 },
  ])
    await assert.rejects(() => restore(p, ring, currentRecord(patch), syntheticTime + 2));
});
test("A-P5-BACKUP proved SEQUENCE high water retains namespace and increases sum", async () => {
  const p = await fixture();
  const { db, report } = await restore(
    p,
    ring,
    currentRecord({
      versionsComplete: true,
      feedHighWater: [{ namespace: "synthetic-namespace", maxSequence: 99 }],
    }),
    syntheticTime + 2,
  );
  try {
    const f = rows(db, "calendar_feeds")[0];
    assert.equal(f.namespace, "synthetic-namespace");
    assert(f.view_revision + 9 > 99);
    assert.equal(report.migrationRequired, 0);
    assert.equal(f.state, "disabled");
  } finally {
    db.close();
  }
});
test("A-P5-BACKUP current revocations do not revive unknown or changed identity", async () => {
  for (const patch of [
    {},
    {
      revocationsComplete: true,
      activeIdentities: [
        {
          id: "synthetic-user",
          email_binding_id: "new-binding",
          email_version: 2,
          email_key: "new-key",
        },
      ],
    },
  ]) {
    const { db, report } = await restore(
      await fixture(),
      ring,
      currentRecord(patch),
      syntheticTime + 2,
    );
    try {
      assert.equal(report.unresolvedAccounts, 1);
      assert.equal(rows(db, "sessions")[0].state, "revoked");
      assert.equal(rows(db, "email_channels")[0].enabled, 0);
    } finally {
      db.close();
    }
  }
});
test("A-P5-BACKUP known identity can reach later account control but never auto sends", async () => {
  const { db } = await restore(
    await fixture(),
    ring,
    currentRecord({
      revocationsComplete: true,
      activeIdentities: [
        {
          id: "synthetic-user",
          email_binding_id: "synthetic-binding",
          email_version: 1,
          email_key: "synthetic-lookup",
        },
      ],
    }),
    syntheticTime + 2,
  );
  try {
    assert.equal(rows(db, "users")[0].status, "active");
    assert.equal(rows(db, "email_channels")[0].enabled, 0);
  } finally {
    db.close();
  }
});
test("A-P5-BACKUP missing DO wakeup and stale leases cannot replay historical mail", async () => {
  const { db } = await restore(await fixture(), ring, currentRecord(), syntheticTime + 2);
  try {
    assert.equal(
      db.prepare("UPDATE jobs SET status='done' WHERE id='synthetic-job' AND lease_version=7").run()
        .changes,
      0,
    );
    assert.equal(rows(db, "jobs")[0].status, "failed");
    assert.equal(
      db
        .prepare(
          "UPDATE mail_outbox SET status='accepted' WHERE id='synthetic-mail' AND lease_version=6",
        )
        .run().changes,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('pending','leased')").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
test("A-P5-BACKUP backup key rotation and field key re-encryption require correct keys", async () => {
  const p = await fixture();
  const newKey = randomBytes(SECRET_BITS / 8);
  const rotated = seal(unseal(seal(p, key), key), newKey);
  assert.throws(() => unseal(rotated, key));
  assert.equal(unseal(rotated, newKey).format, p.format);
  const db = materialize(p),
    newRing = await keyring(randomBytes(SECRET_BITS / 8));
  try {
    await rotateFields(db, ring, newRing);
    await validate(db, newRing);
    await assert.rejects(() => validate(db, ring));
  } finally {
    db.close();
  }
});
test("A-P5-BACKUP hostile SQL cannot attach a file", () => {
  assert.throws(
    () => importSql("ATTACH DATABASE '/tmp/forbidden-backup-test.sqlite' AS other;"),
    /rejected/,
  );
});

test("A-P5-BACKUP completed deletion tombstone validates but empty active ciphertext fails", async () => {
  const db = await synthetic(ring);
  try {
    db.exec("UPDATE users SET status='deleting',deletion_completed_at=1,email_ciphertext=X''");
    await validate(db, ring);
    db.exec("UPDATE users SET status='active'");
    await assert.rejects(() => validate(db, ring));
  } finally {
    db.close();
  }
});
test("A-P5-BACKUP omitted formal evidence is rejected", async () => {
  const p = await fixture();
  p.tables.find((t) => t.name === "evidence").rows = [];
  await assert.rejects(
    () => restore(p, ring, currentRecord(), syntheticTime + 2),
    /formal_event_evidence_missing/,
  );
});
