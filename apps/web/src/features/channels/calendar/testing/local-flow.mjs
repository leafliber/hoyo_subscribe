// F3-04 local production Worker + real Miniflare D1. Synthetic credentials remain in memory.
// After pnpm build, run from repository root: CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx apps/web/src/features/channels/calendar/testing/local-flow.mjs
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALENDAR_PREVIEW_RATE_LIMIT,
  CalendarPreviewResponseSchema,
  calendarViewSchema,
  SECRET_BITS,
  SUBSCRIPTION_SCHEMA_VERSION,
} from "@hoyo/contracts";
import { makePendingSession } from "../../../../../../worker/src/auth/consume/session.ts";
import { encryptField } from "../../../../../../worker/src/storage/crypto/aead.ts";
import { Keyring } from "../../../../../../worker/src/storage/crypto/keyring.ts";
import { splitSqlStatements } from "../../../../../../worker/src/storage/split-sql.ts";

import { CalendarRequestError, errorDetail } from "../api.ts";

const root = process.cwd();
const require = createRequire(
  realpathSync(join(root, "apps/worker/node_modules/wrangler/package.json")),
);
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require("miniflare");

const scratch = await mkdtemp(join(tmpdir(), "f3-04-local-"));
const bytes = () => crypto.getRandomValues(new Uint8Array(SECRET_BITS / 8));
const master = bytes(),
  pepper = bytes();
const keys = await Keyring.create({
  masterSecret: master,
  otpPepper: pepper,
  unsubscribeMacCurrentKeyId: "synthetic",
});
const hex = (bytes) => Buffer.from(bytes).toString("hex");
let mf;
try {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: join(root, "apps/worker/dist/index.js"),
      compatibilityDate: "2026-08-01",

      d1Databases: ["DB"],
      durableObjects: {
        PIPELINE_DO: { className: "PipelineDO", useSQLite: true },
        DELIVERY_DO: { className: "DeliveryDO", useSQLite: true },
      },
      bindings: {
        CRYPTO_MASTER_SECRET: hex(master),
        CRYPTO_OTP_PEPPER: hex(pepper),
        CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
        SITE_ORIGIN: "https://synthetic.invalid",
      },
      log: new Log(LogLevel.NONE),
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir(join(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.batch(
      splitSqlStatements(await readFile(join(root, "migrations", name), "utf8")).map((sql) =>
        db.prepare(sql),
      ),
    );
  }
  const sql = (text, ...args) =>
    db
      .prepare(text)
      .bind(...args)
      .run();
  // Explicit synthetic opt-in only. Production missing controls remain closed.
  const setControl = async (name, value) => {
    if (value === null) await sql("DELETE FROM system_state WHERE key=?", name);
    else
      await sql(
        "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        name,
        JSON.stringify(value),
        Date.now(),
      );
  };
  const openSyntheticCalendar = async () => {
    await setControl("calendar_enabled", true);
    await setControl("read_only", false);
  };
  await openSyntheticCalendar();
  const now = Date.now(),
    id = crypto.randomUUID(),
    session = await makePendingSession(now);
  const encrypted = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id },
    "synthetic@example.invalid",
  );
  await sql(
    "INSERT INTO users(id,\"order\",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at) VALUES (?,1,'active',?,?,?,1,?,?)",
    id,
    id,
    id,
    encrypted,
    now,
    now,
  );
  await sql(
    "INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,activated_at,created_at,updated_at) VALUES (?,?,?,'active','synthetic','unknown',?,?,?,?,0,0,?,?,?)",
    session.id,
    id,
    session.tokenHash,
    now,
    session.absoluteExpiresAt,
    session.expiresAt,
    now,
    now,
    now,
    now,
  );
  await sql(
    "INSERT INTO recovery_credentials(id,user_id,secret_hash,generation,saved_confirmed_at,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
    crypto.randomUUID(),
    id,
    hex(bytes()),
    now,
    now,
    now,
  );
  await sql(
    "INSERT INTO user_subscriptions(user_id,state,schema_version,revision,created_at,updated_at) VALUES (?,'uninitialized',?,0,?,?)",
    id,
    SUBSCRIPTION_SCHEMA_VERSION,
    now,
    now,
  );
  const origin = "https://synthetic.invalid";
  let csrf;
  const call = async (path, method = "GET", body, key) =>
    mf.dispatchFetch(origin + path, {
      method,
      headers: {
        cookie: `__Host-session=${session.cookieValue}${csrf ? `; __Host-hoyo_csrf=${csrf}` : ""}`,
        ...(method !== "GET"
          ? {
              origin,
              "content-type": "application/json",
              "x-csrf-token": csrf,
              ...(key ? { "idempotency-key": key } : {}),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const sessions = await call("/api/v2/me/sessions");
  assert.equal(sessions.status, 200, "sessions");
  csrf = (await sessions.json()).csrf_token;
  const config = {
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
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
  const saved = await call("/api/v2/me/subscription", "PATCH", { expected_revision: 0, config });
  assert.equal(saved.status, 200, "save");
  await sql(
    "INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES ('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?)",
    now,
    now,
    now,
  );
  await sql(
    "INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,human_locked,created_at,updated_at) VALUES ('synthetic-event','genshin','CN','limited_event','scheduled','synthetic',1,1,0,?,?)",
    now,
    now,
  );
  await sql(
    "INSERT INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,public_ical_revision,human_locked,created_at,updated_at) VALUES ('synthetic-node','synthetic-event','start','start','synthetic','UTC','synthetic','official_explicit','unknown',1,0,?,?)",
    now,
    now,
  );
  await sql(
    "INSERT INTO public_snapshots(id,generation,state,published_at,node_count,created_at) VALUES ('synthetic-snapshot',31,'current',?,1,?)",
    now,
    now,
  );
  const node = {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    public_changed_at: now,
    source_projection_json: null,
    patch: null,
    tombstone: false,
    projection: {
      event_id: "synthetic-event",
      milestone_id: "synthetic-node",
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "synthetic",
        summary: null,
        official_url: null,
        human_locked: false,
      },
      milestone: {
        milestone_key: "start",
        node_type: "start",
        title: "synthetic",
        human_locked: false,
        time: {
          precision: "datetime",
          utc_ms: now + 86400000,
          source_timezone: "UTC",
          raw_expression: "synthetic",
          time_basis: "official_explicit",
        },
      },
    },
  };
  await sql(
    "INSERT INTO public_snapshot_nodes(snapshot_id,milestone_id,node_json) VALUES ('synthetic-snapshot','synthetic-node',?)",
    JSON.stringify(node),
  );
  const before = await call("/api/v2/me/calendar");
  assert.equal(before.status, 200, "view");
  const initial = await before.json();
  const previewResponse = await call("/api/v2/me/calendar/preview");
  assert.equal(previewResponse.status, 200, "preview");
  const preview = CalendarPreviewResponseSchema.parse(await previewResponse.json());
  assert.equal(preview.outcome, "ok", "preview outcome");
  assert.equal(preview.nextCursor, null);
  assert.equal(preview.items.length, 1);
  const body = {
    confirmed: true,
    expected_generation: initial.token_generation,
    expected_revision: preview.subscription.revision,
    publication_generation: preview.publication.generation,
  };
  const stale = await call(
    "/api/v2/me/calendar/enable",
    "POST",
    { ...body, publication_generation: body.publication_generation + 1 },
    crypto.randomUUID(),
  );
  assert.equal(stale.status, 409, "stale preview refused");
  assert.equal(
    errorDetail(new CalendarRequestError(stale.status, await stale.json())).reason,
    "preview_outdated",
    "web adapter reads real 409 details",
  );
  await sql("UPDATE recovery_credentials SET saved_confirmed_at=NULL WHERE user_id=?", id);
  const unsavedCode = await call("/api/v2/me/calendar/enable", "POST", body, crypto.randomUUID());
  assert.equal(unsavedCode.status, 401, "recovery code gate");
  assert.equal(
    errorDetail(new CalendarRequestError(unsavedCode.status, await unsavedCode.json())).reason,
    "recovery_code_not_saved",
    "web adapter reads real 401 details",
  );
  await sql("UPDATE recovery_credentials SET saved_confirmed_at=? WHERE user_id=?", now, id);
  await sql("UPDATE sessions SET recovery_code_required=1 WHERE id=?", session.id);
  const restricted = await call("/api/v2/me/calendar/enable", "POST", body, crypto.randomUUID());
  assert.equal(restricted.status, 401, "restricted recovery session gate");
  assert.equal((await restricted.json()).error.details.reason, "recovery_code_unconfirmed");
  await sql("UPDATE sessions SET recovery_code_required=0 WHERE id=?", session.id);
  const key = crypto.randomUUID();
  const enabled = await call("/api/v2/me/calendar/enable", "POST", body, key);
  assert.equal(enabled.status, 200, "enable");
  const receipt = await enabled.json();
  const replay = await call("/api/v2/me/calendar/enable", "POST", body, key);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).token_generation, receipt.token_generation);
  const view = await (await call("/api/v2/me/calendar")).json();
  assert.equal(view.address_state, "enabled");
  const feed = await mf.dispatchFetch(view.url);
  assert.equal(feed.status, 200, "cookie-free ICS");
  const text = await feed.text();
  assert.ok(text.includes("BEGIN:VEVENT") && text.includes("BEGIN:VALARM"), "ICS and alarm");
  const stopped = await call(
    "/api/v2/me/calendar/disable",
    "POST",
    { confirmed: true, expected_generation: view.token_generation },
    crypto.randomUUID(),
  );
  assert.equal(stopped.status, 200, "disable");
  assert.notEqual((await mf.dispatchFetch(view.url)).status, 200, "old feed revoked");
  assert.equal((await (await call("/api/v2/me/calendar")).json()).address_state, "disabled");
  // U20 / P5-01: independent gates, not a second implementation of their policy.
  // calendar_enabled protects enable; read_only protects enable AND reset.
  // Each refusal checks persisted state before any subsequent legitimate read.
  const persistedState = async () =>
    JSON.stringify(
      await Promise.all(
        ["calendar_feeds", "users", "sessions", "user_subscriptions", "capacity_state"].map(
          async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results,
        ),
      ),
    );
  const ownerView = async () => {
    const response = await call("/api/v2/me/calendar");
    assert.equal(response.status, 200, "owner read remains available");
    return calendarViewSchema.parse(await response.json());
  };
  const completePreview = async () => {
    const response = await call("/api/v2/me/calendar/preview");
    assert.equal(response.status, 200, "saved preview remains readable");
    const value = CalendarPreviewResponseSchema.parse(await response.json());
    assert.equal(value.outcome, "ok");
    assert.equal(value.nextCursor, null);
    assert.equal(value.items.length, value.totals.items);
    return value;
  };
  const refuseWithoutMutation = async (action, input, label) => {
    const beforeState = await persistedState();
    const response = await call(
      `/api/v2/me/calendar/${action}`,
      "POST",
      input,
      crypto.randomUUID(),
    );
    assert.equal(response.status, 503, `${label}: ${action} refused by runtime gate`);
    assert.equal((await response.json()).error.code, "temporarily_unavailable");
    // Boolean comparison prevents assertion failures from dumping private stored credentials.
    assert.ok((await persistedState()) === beforeState, `${label}: refusal changed no state`);
  };
  for (const scenario of [
    { name: "calendar_enabled missing", calendar: null, readOnly: false },
    { name: "calendar_enabled false", calendar: false, readOnly: false },
    { name: "read_only true", calendar: true, readOnly: true },
  ]) {
    await openSyntheticCalendar();
    const previous = await ownerView();
    const fresh = await completePreview();
    const currentBinding = {
      confirmed: true,
      expected_generation: previous.token_generation,
      expected_revision: fresh.subscription.revision,
      publication_generation: fresh.publication.generation,
    };
    const reenabled = await call(
      "/api/v2/me/calendar/enable",
      "POST",
      currentBinding,
      crypto.randomUUID(),
    );
    assert.equal(reenabled.status, 200, `${scenario.name}: explicit positive setup`);
    const activeView = await ownerView();
    assert.equal(activeView.address_state, "enabled");
    await setControl("calendar_enabled", scenario.calendar);
    await setControl("read_only", scenario.readOnly);
    const activeBinding = { ...currentBinding, expected_generation: activeView.token_generation };
    await refuseWithoutMutation("enable", activeBinding, scenario.name);
    if (scenario.readOnly)
      await refuseWithoutMutation(
        "reset",
        { confirmed: true, expected_generation: activeView.token_generation },
        scenario.name,
      );
    const readable = await ownerView();
    assert.equal(readable.address_state, "enabled");
    assert.equal(readable.token_generation, activeView.token_generation);
    assert.ok(readable.url === activeView.url, "gate refusal preserves the private address");
    await completePreview();
    const readableFeed = await mf.dispatchFetch(readable.url);
    assert.equal(readableFeed.status, 200, `${scenario.name}: cookie-free feed remains readable`);
    const readableText = await readableFeed.text();
    assert.ok(readableText.includes("BEGIN:VEVENT") && readableText.includes("BEGIN:VALARM"));
    const disabled = await call(
      "/api/v2/me/calendar/disable",
      "POST",
      { confirmed: true, expected_generation: readable.token_generation },
      crypto.randomUUID(),
    );
    assert.equal(disabled.status, 200, `${scenario.name}: termination remains available`);
    const disabledView = await ownerView();
    assert.equal(disabledView.address_state, "disabled");
    assert.ok(disabledView.url === null, "disabled address is no longer disclosed");
    assert.equal((await mf.dispatchFetch(readable.url)).status, 404, "old address revoked");
    await refuseWithoutMutation(
      "enable",
      { ...currentBinding, expected_generation: disabledView.token_generation },
      scenario.name,
    );
    console.log(
      `PASS U20 real Worker/D1 runtime gate: ${scenario.name}; rejection preserves state; owner/preview/ICS reads and disable remain available.`,
    );
  }
  await openSyntheticCalendar();
  let rateLimited = false;
  for (let count = 0; count < CALENDAR_PREVIEW_RATE_LIMIT; count++) {
    const response = await call("/api/v2/me/calendar/preview");
    if (response.status === 429) {
      const detail = errorDetail(new CalendarRequestError(response.status, await response.json()));
      assert.ok(
        typeof detail.retry_after_ms === "number" && detail.retry_after_ms > 0,
        "web adapter reads real 429 retry_after_ms",
      );
      rateLimited = true;
      break;
    }
    assert.equal(response.status, 200, "preview remains readable");
  }
  assert.ok(rateLimited, "real preview limiter reached");
  console.log(
    "PASS F3-04 real local Worker/D1: save -> complete saved preview -> stale refusal -> recovery gates -> enable -> idempotent replay -> owner GET -> cookie-free ICS+VALARM -> disable -> old URL refused -> real 401/409/429 frontend error adapter. Synthetic data only; no external mail/resources.",
  );
} finally {
  await mf?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
