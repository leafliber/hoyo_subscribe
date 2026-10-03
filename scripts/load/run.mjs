#!/usr/bin/env node
// A-P5-RELEASE. No remote target option; local Wrangler + actual assets routing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as C from "../../packages/contracts/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = await mkdtemp(join(tmpdir(), "hoyo-p504-load-"));
const nonce = randomBytes(32).toString("hex");
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((k) =>
    process.env[k] === undefined ? [] : [[k, process.env[k]]],
  ),
);
Object.assign(env, {
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
});
let server,
  closed,
  output = "",
  origin;
const report = {
  schema: 1,
  synthetic: true,
  evidence: "E2_local_workerd",
  at: new Date().toISOString(),
  topology: "one local Worker + built assets; test-only wrapper for seeding and D1 metering",
  samples: [],
  platform: { workers: null, d1: null, do: null, queue: null, mail: null },
  finalRelease: "not_decided",
};
function stop() {
  if (server?.pid && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
}
async function request(path, init = {}) {
  const res = await fetch(origin + path, {
    ...init,
    headers: { ...init.headers, "x-load-local": nonce },
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  return res;
}
async function control(action, extra = {}) {
  const r = await request("/api/__load", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  assert.equal(r.status, 200, `local fixture ${action} failed`);
  return r.json();
}
async function measured(label, count, concurrency, fn) {
  await control("reset");
  const times = [];
  let next = 0;
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const i = next++;
        const at = performance.now();
        await fn(i);
        times.push(performance.now() - at);
      }
    }),
  );
  const wallMs = performance.now() - begin;
  const sorted = [...times].sort((a, b) => a - b);
  const metrics = await control("metrics");
  report.samples.push({
    label,
    count,
    concurrency,
    wallMs,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    requestsPerSecond: (count * 1000) / wallMs,
    ...metrics,
  });
  console.error(`PASS A-P5-RELEASE ${label} (${count})`);
}
try {
  assert.equal(process.argv.length, 2, "load runner accepts no remote target or credentials");
  for (const dir of [root, join(root, "apps"), join(root, "apps/worker")])
    assert.ok(
      !(await readdir(dir)).some((n) => n.startsWith(".dev.vars")),
      "checkout must not contain .dev.vars",
    );
  const config = JSON.parse(
    (await readFile(join(root, "apps/worker/wrangler.jsonc"), "utf8")).replace(/^\s*\/\/.*$/gm, ""),
  );
  config.main = join(root, "scripts/load/worker.ts");
  config.assets.directory = join(root, "apps/web/dist");
  config.d1_databases[0].migrations_dir = join(root, "migrations");
  // Local harness does not attach mail, queues or scheduled triggers. Workloads call local fakes explicitly.
  delete config.send_email;
  delete config.queues;
  delete config.triggers;
  config.vars = { LOAD_LOCAL_ONLY: nonce };
  const cfg = join(scratch, "wrangler.json");
  await writeFile(cfg, JSON.stringify(config));
  server = spawn(
    process.execPath,
    [
      join(root, "apps/worker/node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--config",
      cfg,
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--inspector-port",
      "0",
      "--persist-to",
      join(scratch, "state"),
      "--show-interactive-dev-session=false",
    ],
    { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  closed = once(server, "close");
  server.stdout.on("data", (c) => {
    output += c;
  });
  server.stderr.on("data", (c) => {
    output += c;
  });
  const deadline = Date.now() + 60000;
  while (!/Ready on http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    assert.equal(server.exitCode, null, "local Worker exited before ready");
    assert.ok(Date.now() < deadline, "local startup timeout");
    await delay(50);
  }
  origin = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)[1];
  for (const migration of (await readdir(join(root, "migrations")))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await control("migrate", { sql: await readFile(join(root, "migrations", migration), "utf8") });
  const credentials = await control("seed");
  for (let next = 0; next !== null; ) next = (await control("nodes", { offset: next })).next;
  await measured("static-assets", 12, 4, async () => {
    const r = await request("/help/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /使用帮助/);
  });
  assert.equal(report.samples.at(-1).queries, 0);
  const publicPath = "/api/v2/calendar/nodes";
  await measured("public-cold", 1, 1, async () => {
    const r = await request(publicPath);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).nodes.length > 0);
  });
  await measured("public-warm", 12, 4, async () => {
    const r = await request(publicPath);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  });
  await measured("public-status", 8, 2, async () => {
    const r = await request("/api/v2/status");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).sources));
  });
  const feed = `/feeds/u/${credentials.token}.ics`;
  let etag;
  await control("cold");
  await measured("authorized-feed-cold", 1, 1, async () => {
    const r = await request(feed);
    assert.equal(r.status, 200);
    etag = r.headers.get("etag");
    assert.ok(etag);
    assert.equal((await r.text()).match(/BEGIN:VEVENT/g)?.length, credentials.nodes);
  });
  await measured("authorized-feed-warm", 8, 2, async () => {
    const r = await request(feed);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  });
  for (const [label, method, status, headers] of [
    ["authorized-head", "HEAD", 200, {}],
    ["authorized-304", "GET", 304, { "if-none-match": etag }],
  ])
    await measured(label, 8, 2, async () => {
      const r = await request(feed, { method, headers });
      assert.equal(r.status, status);
      assert.equal((await r.arrayBuffer()).byteLength, 0);
    });
  const cookie = `__Host-session=${credentials.cookie}`;
  let pages = 0,
    items = 0,
    cursor = null;
  await measured("private-preview-complete", 1, 1, async () => {
    do {
      const r = await request(
        `/api/v2/me/calendar/preview${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: { cookie } },
      );
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.outcome, "ok");
      items += b.items.length;
      pages++;
      cursor = b.nextCursor;
    } while (cursor);
    assert.equal(items, credentials.nodes);
  });
  report.preview = { pages, items, complete: true, sampleOnly: true };
  await control("revoke");
  await measured("revoked-hot-feed-and-session", 1, 1, async () => {
    for (const init of [{}, { method: "HEAD" }, { headers: { "if-none-match": etag } }]) {
      const r = await request(feed, init);
      assert.equal(r.status, 404);
      await r.arrayBuffer();
    }
    const r = await request("/api/v2/me/calendar/preview", { headers: { cookie } });
    assert.equal(r.status, 401);
    await r.arrayBuffer();
  });
  const mail = [];
  await measured("local-fake-provider", 12, 1, async (i) => {
    const r = await control("mail", { offset: i });
    assert.equal(r.reservation, "committed");
    assert.equal(r.calls, 1);
    assert.equal(r.status, ["accepted", "unknown", "retry_wait"][i % 3]);
    mail.push(r);
  });
  report.mail = {
    calls: mail.length,
    accepted: mail.filter((m) => m.status === "accepted").length,
    unknown: mail.filter((m) => m.status === "unknown").length,
    retryableRejected: mail.filter((m) => m.status === "retry_wait").length,
    ledger: mail.at(-1).ledger,
    realSends: 0,
  };
  for (let next = 0; next !== null; )
    next = (await control("capacity-seed", { offset: next })).next;
  await measured("full-capacity-manual-reclaim", 1, 1, async () => {
    const r = await control("capacity");
    assert.deepEqual(r.before, {
      accounts: C.ACCOUNT_MAX_STORED,
      seats: C.MAIL_SEATS_MAX,
      routine: C.MAIL_ROUTINE_SEATS_MAX,
    });
    assert.equal(r.scanned, C.ACCOUNT_MAX_STORED);
    assert.equal(r.pauseRefused, true);
    assert.equal(r.done, true);
    assert.equal(r.after.accounts, C.ACCOUNT_MAX_STORED - 1);
    assert.equal(r.after.seats, C.MAIL_SEATS_MAX - 1);
    assert.equal(r.ledgerUnchanged, true);
    assert.equal(r.feedOnlyRenewed, true);
    report.capacity = r;
  });
  for (let next = 0; next !== null; )
    next = (await control("feedback-seed", { offset: next })).next;
  await measured("full-feedback-rounds-shared-reclaim", 1, 1, async () => {
    const r = await control("combined");
    assert.ok(r.totalQueries <= C.PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit);
    assert.ok(r.reclaimQueries > 0);
    report.maintenance = r;
  });
  assert.ok(report.samples.at(-1).queries <= C.PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit);
  const feedbackProof = await control("feedback-check");
  assert.equal(feedbackProof.doneFeedback, C.FEEDBACK_BATCH * C.FEEDBACK_MAINTENANCE_ROUNDS);
  assert.equal(feedbackProof.leftUnknown, 1);
  report.maintenance = { ...report.maintenance, ...feedbackProof };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Assertion diagnostics contain counts and scenario labels only. Never emit Wrangler output or URLs.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : "A-P5-RELEASE local load failed; no sensitive runtime output emitted",
  );
  process.exitCode = 1;
} finally {
  stop();
  if (closed) await closed;
  await rm(scratch, { recursive: true, force: true });
}
