import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const run = (file, args) =>
  spawnSync(process.execPath, ["--import", "tsx", file, ...args], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
test("A-P5-RELEASE CLI 拒绝秘密字段且错误不回显输入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p504-cli-"));
  try {
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify({ secret: "synthetic-do-not-echo" }));
    const r = run("scripts/load/reconcile.mjs", [file]);
    assert.equal(r.status, 1);
    assert.ok(!`${r.stdout}${r.stderr}`.includes("synthetic-do-not-echo"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("A-P5-RELEASE 本地负载不接受远端目标参数", () => {
  const r = run("scripts/load/run.mjs", ["https://example.invalid"]);
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes("PASS"));
  assert.ok(!r.stderr.includes("example.invalid"));
});
