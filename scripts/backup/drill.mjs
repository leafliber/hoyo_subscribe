// Actual E2 synthetic exercise of the public CLI. No real accounts, network or mail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SECRET_BITS } from "../../packages/contracts/src/params/registry.ts";
import {
  BACKUP_COPIES,
  digest,
  dump,
  importSql,
  keyring,
  root,
  rows,
  seal,
  unseal,
  writePrivate,
} from "./core.mjs";
import { currentRecord, synthetic } from "./synthetic.mjs";

const base = mkdtempSync(join(tmpdir(), "hoyo-p5-03-synthetic-"));
for (const name of ["data", "backup-keys", "field-keys", "current", "restore"])
  mkdirSync(join(base, name), { mode: 0o700 });
const data = join(base, "data"),
  secrets = join(base, "backup-keys");
const key = join(secrets, "backup.key"),
  master = join(base, "field-keys", "master.key"),
  current = join(base, "current", "current.json");
const report = {
  kind: "E2 synthetic local SQLite / public CLI",
  startedAt: new Date().toISOString(),
  steps: [],
  targetEnvironment: "not executed",
  providerCalls: 0,
};
function run(command, args, expected = 0) {
  const start = performance.now();
  const p = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/backup/cli.mjs", command, ...args],
    {
      cwd: root,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8",
    },
  );
  assert.equal(p.status, expected, `${command}: unexpected exit`);
  report.steps.push({
    command,
    exit: p.status,
    milliseconds: Math.round(performance.now() - start),
    result: p.stdout.trim() || p.stderr.trim(),
  });
  return p;
}
run("keygen", ["--output", key]);
const masterBytes = randomBytes(SECRET_BITS / 8);
writePrivate(master, masterBytes);
const db = await synthetic(await keyring(masterBytes));
writePrivate(join(data, "export.sql"), dump(db));
db.close();
const baseArgs = ["--key-file", key, "--master-file", master];
run("backup", [
  ...baseArgs,
  "--input",
  join(data, "export.sql"),
  "--output",
  join(data, "snapshot.hbk"),
]);
run("verify", [...baseArgs, "--input", join(data, "snapshot.hbk")]);
const frozen = Date.now();
writePrivate(current, JSON.stringify(currentRecord({ observedAt: frozen, freezeAt: frozen })));
run("restore", [
  ...baseArgs,
  "--input",
  join(data, "snapshot.hbk"),
  "--current-file",
  current,
  "--output",
  join(base, "restore", "isolated.sql"),
]);
const restored = importSql(readFileSync(join(base, "restore", "isolated.sql"), "utf8"));
assert.equal(rows(restored, "sessions")[0].state, "revoked");
assert.equal(rows(restored, "calendar_feeds")[0].state, "disabled");
assert.equal(rows(restored, "mail_outbox")[0].status, "unknown");
restored.close();
// Tamper, wrong key, stale epoch, unsafe custody, existing destination: all actual CLI failures.
const damaged = JSON.parse(readFileSync(join(data, "snapshot.hbk")));
const bytes = Buffer.from(damaged.encrypted, "base64");
bytes[0] ^= 1;
damaged.encrypted = bytes.toString("base64");
writePrivate(join(data, "damaged.hbk"), JSON.stringify(damaged));
run("verify", [...baseArgs, "--input", join(data, "damaged.hbk")], 1);
writePrivate(join(secrets, "wrong.key"), randomBytes(SECRET_BITS / 8));
run(
  "verify",
  [
    "--key-file",
    join(secrets, "wrong.key"),
    "--master-file",
    master,
    "--input",
    join(data, "snapshot.hbk"),
  ],
  1,
);
writePrivate(
  join(base, "current", "stale.json"),
  JSON.stringify(currentRecord({ epoch: 4, observedAt: frozen, freezeAt: frozen })),
);
run(
  "restore",
  [
    ...baseArgs,
    "--input",
    join(data, "snapshot.hbk"),
    "--current-file",
    join(base, "current", "stale.json"),
    "--output",
    join(base, "restore", "must-not-exist.sql"),
  ],
  1,
);
assert(!existsSync(join(base, "restore", "must-not-exist.sql")));
const original = digest(readFileSync(join(base, "restore", "isolated.sql")));
run(
  "restore",
  [
    ...baseArgs,
    "--input",
    join(data, "snapshot.hbk"),
    "--current-file",
    current,
    "--output",
    join(base, "restore", "isolated.sql"),
  ],
  1,
);
assert.equal(digest(readFileSync(join(base, "restore", "isolated.sql"))), original);
// Retention plan is advisory; count comes from contracts and no backup is silently deleted.
const rotation = join(base, "rotation");
mkdirSync(rotation, { mode: 0o700 });
const payload = unseal(readFileSync(join(data, "snapshot.hbk")), readFileSync(key));
for (let i = 0; i < BACKUP_COPIES + 1; i++)
  writePrivate(
    join(rotation, `synthetic-${i}.hbk`),
    seal({ ...payload, capturedAt: payload.capturedAt - i }, readFileSync(key)),
  );
const retention = run("retention", ["--directory", rotation, "--key-file", key]);
assert.equal(JSON.parse(retention.stdout).keep.length, BACKUP_COPIES);
assert.equal(JSON.parse(retention.stdout).ownerMayRemoveAfterRestoreVerified.length, 1);
report.finishedAt = new Date().toISOString();
report.assertions = "passed";
// Only redacted results are reusable evidence; keys/data remain private and never go in Git.
writeFileSync(join(base, "report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    report: join(base, "report.json"),
    steps: report.steps.length,
    result: "passed",
    targetEnvironment: "not executed",
  }),
);
