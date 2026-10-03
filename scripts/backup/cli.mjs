// Run: CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs ...

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SECRET_BITS } from "../../packages/contracts/src/params/registry.ts";
import {
  BACKUP_COPIES,
  BACKUP_INTERVAL,
  capture,
  demand,
  digest,
  dump,
  importSql,
  keyring,
  materialize,
  privateFile,
  restore,
  seal,
  unseal,
  validate,
  writePrivate,
} from "./core.mjs";

const options = Object.fromEntries(
  ["input", "output", "key-file", "master-file", "current-file", "directory"].map((key) => [
    key,
    { type: "string" },
  ]),
);
async function main() {
  const { positionals, values: v } = parseArgs({ options, allowPositionals: true });
  const command = positionals[0];
  if (command === "policy") {
    console.log(JSON.stringify({ BACKUP_INTERVAL, BACKUP_COPIES }));
    return;
  }
  if (command === "keygen") {
    writePrivate(v.output, randomBytes(SECRET_BITS / 8));
    console.log("backup key created privately");
    return;
  }
  if (command === "retention") {
    // Never delete automatically: authenticate every candidate before suggesting rotation.
    const key = privateFile(v["key-file"]);
    const entries = readdirSync(v.directory)
      .filter((name) => name.endsWith(".hbk"))
      .map((name) => {
        const payload = unseal(privateFile(resolve(v.directory, name)), key);
        return {
          sha256: digest(readFileSync(resolve(v.directory, name))),
          capturedAt: payload.capturedAt,
        };
      })
      .sort((a, b) => b.capturedAt - a.capturedAt);
    demand(
      new Set(entries.map((e) => e.sha256)).size === entries.length,
      "duplicate_backup_copies",
    );
    demand(
      entries.every((e) => Number.isSafeInteger(e.capturedAt) && e.capturedAt <= Date.now()),
      "invalid_backup_time",
    );
    console.log(
      JSON.stringify({
        BACKUP_INTERVAL,
        BACKUP_COPIES,
        overdue: !entries.length || Date.now() - entries[0].capturedAt > BACKUP_INTERVAL * 1000,
        keep: entries.slice(0, BACKUP_COPIES),
        ownerMayRemoveAfterRestoreVerified: entries.slice(BACKUP_COPIES),
      }),
    );
    return;
  }
  demand(["backup", "verify", "restore"].includes(command), "command_required");
  const key = privateFile(v["key-file"]);
  const master = privateFile(v["master-file"]);
  demand(!key.equals(master), "backup_key_must_be_independent");
  for (const secret of [v["key-file"], v["master-file"], v["current-file"]].filter(Boolean)) {
    demand(dirname(resolve(secret)) !== dirname(resolve(v.input)), "separate_custody_required");
    if (v.output)
      demand(dirname(resolve(secret)) !== dirname(resolve(v.output)), "separate_custody_required");
  }
  const ring = await keyring(master);
  const input = privateFile(v.input);
  if (command === "backup") {
    const db = importSql(input.toString("utf8"));
    try {
      const payload = await capture(db, ring);
      const bytes = seal(payload, key);
      writePrivate(v.output, bytes);
      console.log(
        JSON.stringify({
          result: "encrypted",
          sha256: digest(bytes),
          ...payload.checked,
          BACKUP_INTERVAL,
          BACKUP_COPIES,
        }),
      );
    } finally {
      db.close();
    }
    return;
  }
  const payload = unseal(input, key);
  if (command === "verify") {
    const db = materialize(payload);
    try {
      console.log(JSON.stringify({ result: "verified", ...(await validate(db, ring)) }));
    } finally {
      db.close();
    }
    return;
  }
  demand(!lstatSync(v.input).isSymbolicLink(), "symlink_rejected");
  const current = JSON.parse(privateFile(v["current-file"]));
  const result = await restore(payload, ring, current);
  try {
    writePrivate(v.output, dump(result.db));
    console.log(JSON.stringify(result.report));
  } finally {
    result.db.close();
  }
}
try {
  await main();
} catch {
  // Intentionally constant: filesystem/SQLite errors can contain paths, SQL and private values.
  console.error(
    "backup operation failed closed; check private inputs and runbook; no release authorized",
  );
  process.exitCode = 1;
}
