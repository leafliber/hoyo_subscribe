// F3-05: built browser pages -> unchanged production Worker -> isolated real workerd/D1.
// Only Turnstile is replaced at the external boundary. OTP comes from the encrypted local outbox;
// there is no mail binding, delivery DO, Cron, remote resource or outgoing network connection.
// After pnpm build: CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx apps/web/src/features/subscription/testing/local-flow.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, relative, resolve } from "node:path";
import {
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  SECRET_BITS,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";
import { decryptOtpPayload } from "../../../../../worker/src/auth/challenges/payload.ts";
import { encryptField } from "../../../../../worker/src/storage/crypto/aead.ts";
import { Keyring } from "../../../../../worker/src/storage/crypto/keyring.ts";
import { computeEmailKey } from "../../../../../worker/src/storage/crypto/mac.ts";
import { splitSqlStatements } from "../../../../../worker/src/storage/split-sql.ts";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));
const { chromium, devices, expect } = require("@playwright/test");
const workerRequire = createRequire(
  realpathSync(join(root, "apps/worker/node_modules/wrangler/package.json")),
);
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
const evidenceDir = process.env.HOYO_LOCAL_FLOW_EVIDENCE_DIR;
if (evidenceDir)
  assert.ok(relative(root, resolve(evidenceDir)).startsWith(".."), "logs must stay outside source");
const checks = [];
const statuses = [];
let step = "initialize";
let failed = false;
let externalAttempts = 0;
let turnstileChecks = 0;
let browser;
const random = () => crypto.getRandomValues(new Uint8Array(SECRET_BITS / 8));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const pass = () => {
  checks.push({ step, result: "passed" });
  console.log(`PASS ${step}`);
};
const builtWorker = await readFile(join(root, "apps/worker/dist/index.js"));
const buildHash = createHash("sha256").update(builtWorker).digest("hex");

async function scenario(name, existing) {
  let mf;
  let server;
  let context;
  let origin;
  const calls = [];
  const count = (path, method = "POST") =>
    calls.filter((c) => c.path === path && c.method === method).length;
  const renewals = () => count("/api/v2/auth/renew");
  const saves = () => count("/api/v2/me/subscription", "PATCH");
  try {
    const master = random(),
      pepper = random();
    const keys = await Keyring.create({
      masterSecret: master,
      otpPepper: pepper,
      unsubscribeMacCurrentKeyId: "synthetic",
    });
    const usedTurnstile = new Set();
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: join(root, "apps/worker/dist/index.js"),
        compatibilityDate: "2026-08-01",
        d1Databases: ["DB"],
        bindings: {
          CRYPTO_MASTER_SECRET: hex(master),
          CRYPTO_OTP_PEPPER: hex(pepper),
          CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
          TURNSTILE_SECRET_KEY: "synthetic-local-only",
          SITE_ORIGIN: "https://synthetic.invalid",
          AUTH_MAIL_FROM: "auth@example.invalid",
          BIZ_MAIL_FROM: "business@example.invalid",
        },
        outboundService: async (request) => {
          if (request.url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
            externalAttempts++;
            return new Response(null, { status: 503 });
          }
          turnstileChecks++;
          const token = (await request.formData()).get("response");
          const success =
            typeof token === "string" &&
            token.startsWith("synthetic-") &&
            !usedTurnstile.has(token);
          usedTurnstile.add(token);
          return Response.json({ success });
        },
        log: new Log(LogLevel.NONE),
      }),
    );
    const db = await mf.getD1Database("DB");
    for (const filename of (await readdir(join(root, "migrations")))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await db.batch(
        splitSqlStatements(await readFile(join(root, "migrations", filename), "utf8")).map((sql) =>
          db.prepare(sql),
        ),
      );
    }
    const sql = (text, ...args) =>
      db
        .prepare(text)
        .bind(...args)
        .run();
    const row = (text, ...args) =>
      db
        .prepare(text)
        .bind(...args)
        .first();
    const now = Date.now();
    // Opt in only the disposable positive fixture. No production defaults are changed.
    for (const [key, value] of Object.entries({
      calendar_enabled: true,
      read_only: false,
      registration_open: true,
      outbound_enabled: true,
      mail_sending_available: true,
    }))
      await sql(
        "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        key,
        JSON.stringify(value),
        now,
      );
    const email = `${existing ? "existing" : "new"}@example.invalid`;
    const emailKey = await computeEmailKey(keys.emailLookup(), email);
    const initialConfig = {
      schema_version: SUBSCRIPTION_SCHEMA_VERSION,
      scope: { games: ["hsr"], regions: [...SUPPORTED_SCOPE_REGIONS] },
      calendar: {
        event_types: [...DEFAULT_CALENDAR_EVENT_TYPES],
        node_types: [...DEFAULT_CALENDAR_NODE_TYPES],
        alarms_enabled: CALENDAR_ALARMS_DEFAULT,
      },
      notifications: { rule_ids: [...DEFAULT_RULE_IDS], ...CHANGE_DEFAULTS },
    };
    if (existing) {
      const id = crypto.randomUUID();
      const ciphertext = await encryptField(
        keys.fieldEncryption(),
        { type: "delivery-email-address", id },
        email,
      );
      await sql(
        "INSERT INTO users(id,\"order\",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at) VALUES (?,1,'active',?,?,?,1,?,?)",
        id,
        emailKey,
        crypto.randomUUID(),
        ciphertext,
        now,
        now,
      );
      await sql(
        "INSERT INTO user_subscriptions(user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES (?,'initialized',?,1,?,?,?,?,?)",
        id,
        SUBSCRIPTION_SCHEMA_VERSION,
        JSON.stringify(initialConfig.scope),
        JSON.stringify(initialConfig.calendar),
        JSON.stringify(initialConfig.notifications),
        now,
        now,
      );
    }
    await sql(
      "INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES ('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?)",
      now,
      now,
      now,
    );
    await sql(
      "INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,human_locked,created_at,updated_at) VALUES ('synthetic-event','genshin','CN','limited_event','scheduled','合成联调活动',1,1,0,?,?)",
      now,
      now,
    );
    await sql(
      "INSERT INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,public_ical_revision,human_locked,created_at,updated_at) VALUES ('synthetic-node','synthetic-event','end','end','合成结束节点','UTC','synthetic','official_explicit','unknown',1,0,?,?)",
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
          title: "合成联调活动",
          summary: null,
          official_url: null,
          human_locked: false,
        },
        milestone: {
          milestone_key: "end",
          node_type: "end",
          title: "合成结束节点",
          human_locked: false,
          time: {
            precision: "datetime",
            utc_ms: now + 2 * 86400000,
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
    // Loopback bridge serves unchanged built assets and passes every API request to production fetch.
    // Credentials are forwarded in memory, never included in diagnostics or result files.
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, origin);
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/feeds/")) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const response = await mf.dispatchFetch(url.href, {
            method: req.method,
            headers: req.headers,
            ...(body.length ? { body } : {}),
          });
          const path = url.pathname.startsWith("/feeds/") ? "/feeds/[redacted]" : url.pathname;
          calls.push({ path, method: req.method });
          statuses.push({ scenario: name, path, status: response.status });
          res.statusCode = response.status;
          for (const [key, value] of response.headers)
            if (key !== "set-cookie") res.setHeader(key, value);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader("set-cookie", cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        let filename = resolve(root, "apps/web/dist", `.${decodeURIComponent(url.pathname)}`);
        const dist = resolve(root, "apps/web/dist");
        if (filename !== dist && !filename.startsWith(`${dist}/`)) {
          res.writeHead(404).end();
          return;
        }
        if (!extname(filename)) filename = join(filename, "index.html");
        let content = await readFile(filename);
        if (url.pathname.replace(/\/$/, "") === "/login")
          content = Buffer.from(
            content
              .toString()
              .replace(/data-sitekey(?:="[^"]*")?/, 'data-sitekey="synthetic-local-only"'),
          );
        res.setHeader(
          "content-type",
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(filename)] ?? "application/octet-stream",
        );
        res.end(content);
      } catch {
        res.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({
      ...(name === "mobile" ? devices["Pixel 7"] : devices["Desktop Chrome"]),
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.href === "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")
        return route.fulfill({
          contentType: "application/javascript",
          body: "let o;window.turnstile={render:(el,v)=>{o=v;v.callback('synthetic-'+crypto.randomUUID());return 'synthetic'},reset:()=>o.callback('synthetic-'+crypto.randomUUID())};",
        });
      externalAttempts++;
      return route.abort();
    });
    const page = await context.newPage();
    const part = (key) => page.locator(`[data-calendar="${key}"]`);
    const api = (path) =>
      page.evaluate(async (path) => {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("local_api_read_failed");
        return response.json();
      }, path);
    step = `${name}: public browse and guest draft create no account or channel`;
    await page.goto(origin);
    await expect(page.getByRole("link", { name: "我的订阅", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "我的订阅", exact: true }).click();
    await expect(page.locator("#subscription-login")).toBeVisible();
    await page.locator('input[name="games"][value="hsr"]').uncheck();
    await page.locator('input[name="games"][value="zzz"]').uncheck();
    await page.locator("#change-settings summary").click();
    await page.locator('input[name="new_event"]').check();
    await expect(page.locator("#local-draft-status")).toContainText("仅保存在本机");
    assert.equal((await row("SELECT COUNT(*) AS n FROM users")).n, existing ? 1 : 0);
    assert.equal((await row("SELECT COUNT(*) AS n FROM sessions")).n, 0);
    assert.equal(saves(), 0);
    assert.equal(renewals(), 0);
    pass();

    step = `${name}: real OTP challenge, consumption and pending session without mail`;
    await page.locator("#subscription-login").click();
    await expect(page.locator("#turnstile-status")).toContainText("已完成");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-request-otp").click();
    await expect(page.locator("#code-section")).toBeVisible();
    const challenge = await row(
      "SELECT id,payload_ciphertext FROM mail_outbox WHERE payload_kind='otp-mail-payload' AND payload_ciphertext IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    );
    assert.ok(challenge, "local encrypted OTP outbox exists");
    const payload = await decryptOtpPayload(
      keys.fieldEncryption(),
      challenge.id,
      new Uint8Array(challenge.payload_ciphertext),
    );
    await page.locator("#login-code").fill(payload.code);
    payload.code = "";
    await page.locator("#verify").click();
    await expect(page.locator("#pending-section")).toBeVisible();
    assert.equal((await row("SELECT state FROM sessions")).state, "pending");
    assert.equal(count("/api/v2/auth/activate"), 0);
    assert.equal(
      (await row("SELECT COUNT(*) AS n FROM auth_challenges WHERE consumed_at IS NOT NULL")).n,
      1,
    );
    pass();

    step = `${name}: explicit activation returns to cloud/guest comparison without saving`;
    await page.locator("#activate").click();
    await expect(page).toHaveURL(/\/subscription\/?$/);
    await expect(page.locator("#save-comparison")).toBeVisible();
    await expect(page.locator("#save-subscription")).toBeDisabled();
    const user = await row("SELECT id FROM users WHERE email_key=?", emailKey);
    assert.equal((await row("SELECT state FROM sessions")).state, "active");
    assert.equal(saves(), 0);
    assert.equal(renewals(), 0);
    if (!existing) {
      assert.equal(
        (await row("SELECT email_version FROM users WHERE id=?", user.id)).email_version,
        0,
      );
      const sub = await row(
        "SELECT state,revision,scope_json,calendar_json,notifications_json FROM user_subscriptions WHERE user_id=?",
        user.id,
      );
      assert.deepEqual(sub, {
        state: "uninitialized",
        revision: 0,
        scope_json: null,
        calendar_json: null,
        notifications_json: null,
      });
      await expect(page.locator("#calendar-first-save")).toBeVisible();
      await expect(page.locator('#mail-channel [data-email="seat-start"]')).toBeDisabled();
      await expect(part("begin")).toBeDisabled();
    } else await expect(page.locator("#save-differences")).toContainText("游戏 · 不同");
    await page.locator("#keep-draft").click();
    pass();

    step = `${name}: explicit PATCH persists selected scope and renews exactly once`;
    const revision = existing ? 2 : 1;
    await page.locator("#save-subscription").click();
    await expect(page.locator("#cloud-state")).toContainText(`版本 ${revision}`);
    await expect.poll(renewals).toBe(1);
    assert.equal(saves(), 1);
    const saved = await api("/api/v2/me/subscription");
    assert.deepEqual(saved.config.scope.games, ["genshin"]);
    assert.equal(saved.config.notifications.new_event, true);
    // ADR-0026：恢复码可选，保存订阅后直接进入「接收方式」，不经过恢复页。
    await expect(page.locator("#save-recovery-link")).toBeHidden();
    await page.locator('[data-receive="calendar"]').click();
    await expect(page.locator("#panel-channels")).toBeVisible();
    assert.equal((await row("SELECT COUNT(*) AS n FROM recovery_credentials")).n, 0);
    pass();

    step = `${name}: real complete saved preview is read-only and requires confirmation`;
    await part("refresh").click();
    await expect(part("begin")).toBeEnabled();
    await part("begin").click();
    await expect(part("preview")).toContainText("完整预览");
    await expect(part("preview")).toContainText("合成联调活动");
    await expect(part("confirm")).toBeDisabled();
    assert.equal((await row("SELECT COUNT(*) AS n FROM calendar_feeds")).n, 0);
    assert.equal(renewals(), 1);
    pass();

    step = `${name}: publication changes return real 409 and require fresh confirmation`;
    await sql("UPDATE public_snapshots SET generation=generation+1 WHERE state='current'");
    await part("consent").check();
    await part("confirm").click();
    await expect(part("preview")).toContainText("完整预览");
    await expect(part("consent")).not.toBeChecked();
    await expect(part("confirm")).toBeDisabled();
    await expect.poll(() => count("/api/v2/me/calendar/enable")).toBe(1);
    assert.ok(
      statuses.some(
        (s) => s.scenario === name && s.path.endsWith("calendar/enable") && s.status === 409,
      ),
    );
    assert.equal((await row("SELECT COUNT(*) AS n FROM calendar_feeds")).n, 0);
    assert.equal(renewals(), 1);
    pass();

    step = `${name}: explicit enable and actual clipboard copy do not imply client addition`;
    await part("consent").check();
    await part("confirm").click();
    await expect(part("address")).toContainText("日历订阅地址已创建");
    await expect.poll(renewals).toBe(2);
    await part("copy").click();
    await expect(part("message")).toContainText("不等于外部客户端已添加");
    const owner = await api("/api/v2/me/calendar");
    let clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clipboard === owner.url, "copied value matches owner-only API");
    clipboard = "";
    await page.evaluate(() => navigator.clipboard.writeText(""));
    assert.equal(
      await page.evaluate(
        () =>
          document.body.innerHTML.includes("/feeds/u/") ||
          JSON.stringify([localStorage, sessionStorage]).includes("/feeds/u/"),
      ),
      false,
    );
    const feed = await mf.dispatchFetch(owner.url);
    assert.equal(feed.status, 200, "cookie-free Feed");
    const ics = await feed.text();
    assert.ok(ics.includes("BEGIN:VEVENT") && ics.includes("BEGIN:VALARM"));
    if (process.env.HOYO_E2E_WRITE_EVIDENCE === "1") {
      const target = join(root, "tests/e2e/evidence/f3-05", `${name}-real-local-completed.png`);
      await mkdir(join(root, "tests/e2e/evidence/f3-05"), { recursive: true });
      await page.locator("#calendar-channel").screenshot({ path: target });
    }
    pass();

    step = `${name}: disable alarms saves once, renews once and retains address/rules`;
    page.on("dialog", (d) => d.accept());
    await page.getByText("管理日历地址", { exact: true }).click();
    await part("alarms").click();
    await expect(part("config")).toContainText("日历提醒关闭");
    await expect(page.locator("#save-result")).toContainText("地址保持不变");
    await expect.poll(renewals).toBe(3);
    assert.equal(saves(), 2);
    const unchanged = await api("/api/v2/me/calendar");
    assert.ok(unchanged.url === owner.url);
    const configAfter = await api("/api/v2/me/subscription");
    assert.deepEqual(
      configAfter.config.notifications.rule_ids,
      saved.config.notifications.rule_ids,
    );
    pass();

    step = `${name}: independent disable then save-and-continue renew once per explicit action`;
    await part("disable").click();
    await expect(part("address")).toContainText("已停用");
    await expect.poll(renewals).toBe(4);
    await page.locator("#change-settings summary").click();
    await page.locator('input[name="new_event"]').uncheck();
    await part("begin").click();
    await part("save").click();
    await expect(part("preview")).toContainText("完整预览");
    await expect.poll(renewals).toBe(5);
    assert.equal(saves(), 3);
    await part("consent").check();
    await part("confirm").click();
    await expect(part("address")).toContainText("有效");
    await expect.poll(renewals).toBe(6);
    await page.reload();
    await expect(page.locator("#cloud-state")).toContainText(`版本 ${revision + 2}`);
    assert.equal(renewals(), 6);
    assert.equal(saves(), 3);
    pass();

    step = `${name}: mail and Push remain off, no external delivery or credential persistence`;
    assert.equal(
      (await row("SELECT COUNT(*) AS n FROM email_channels WHERE enabled=1 OR routine_enabled=1"))
        .n,
      0,
    );
    assert.equal((await row("SELECT COUNT(*) AS n FROM push_bindings")).n, 0);
    assert.equal((await row("SELECT COUNT(*) AS n FROM consent_events")).n, 0);
    assert.equal(
      (
        await row(
          "SELECT COUNT(*) AS n FROM mail_outbox WHERE attempts>0 OR message_id IS NOT NULL",
        )
      ).n,
      0,
    );
    assert.equal(
      calls.filter((c) => c.method !== "GET" && /\/me\/(email-channel|push-bindings)/.test(c.path))
        .length,
      0,
    );
    assert.equal(externalAttempts, 0);
    pass();
  } finally {
    await context?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await mf?.dispose();
  }
}
try {
  browser = await chromium.launch({ headless: true });
  await scenario("desktop", true);
  await scenario("mobile", false);
} catch (error) {
  failed = true;
  checks.push({ step, result: "failed", error: error.name });
  console.error(`FAIL ${step} (${error.name}; raw errors withheld to protect credentials)`);
  console.error(
    error.stack
      ?.split("\n")
      .filter((line) => line.trim().startsWith("at "))
      .join("\n"),
  );
} finally {
  await browser?.close();
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, "results.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          worker_sha256: buildHash,
          result: failed ? "failed" : "passed",
          checks,
          statuses,
          external_attempts: externalAttempts,
          synthetic_siteverify_calls: turnstileChecks,
          limits: [
            "Local workerd/D1 and real application routes; external Turnstile is synthetic.",
            "OTP read from encrypted disposable outbox in memory, never emailed.",
            "No deployment, remote resources or external calendar client verification.",
          ],
        },
        null,
        2,
      ),
    );
  }
}
process.exitCode = failed ? 1 : 0;
