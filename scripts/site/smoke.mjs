#!/usr/bin/env node
// A-P5-SITE：先 pnpm build，再 node scripts/site/smoke.mjs。
// 只用锁定的 wrangler dev --local、本次临时 D1 和合成无效能力路径；不注入秘密、不发信。
// 使用产物副本放入碰撞文件，验证动态前缀优先级；_redirects 原样复制，绝不另写规则。
// 下列等待/超时只控制测试进程，不是业务参数。stdout 只输出用例标签和计数，不输出能力 URL。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worker = join(root, "apps/worker");
const dist = join(root, "apps/web/dist");
const wrangler = join(worker, "node_modules/wrangler/bin/wrangler.js");
const scratch = await mkdtemp(join(tmpdir(), "hoyo-p5-site-"));
const assets = join(scratch, "assets");
const state = join(scratch, "state");
// 仅继承启动 Node/工具所需的公开环境；不继承 Cloudflare 凭证或应用秘密。
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
Object.assign(env, {
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  NO_COLOR: "1",
});
let server;
let serverClosed;
let output = "";
let expectedCalls = 0;
let cases = 0;

function start(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: worker,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

function stop(child) {
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function until(predicate, label, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${label} timed out`);
    await delay(50);
  }
}

function calls() {
  return (output.match(/"event":"http_request"/g) ?? []).length;
}

function passed(label) {
  cases++;
  console.log(`PASS A-P5-SITE ${label}`);
}

try {
  // .dev.vars 会被 Wrangler 自动加载；有本地秘密文件时直接拒绝本次冒烟。
  for (const directory of [root, join(root, "apps"), worker]) {
    assert.ok(
      !(await readdir(directory)).some((name) => name.startsWith(".dev.vars")),
      "smoke requires a checkout without .dev.vars files",
    );
  }
  await cp(dist, assets, { recursive: true });
  assert.equal(
    await readFile(join(assets, "_redirects"), "utf8"),
    await readFile(join(root, "apps/web/public/_redirects"), "utf8"),
  );
  const collisions = [
    "api/v2/status",
    "feeds/u/synthetic-invalid",
    "unsubscribe/synthetic-invalid",
    "email/one-click/synthetic-invalid",
  ];
  for (const path of collisions) {
    const file = join(assets, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "STATIC_COLLISION_MUST_NOT_WIN");
  }
  const migration = start(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
  // 丢弃工具原始输出（包括能力路径）；错误时只给退出码，不泄露 URL 或环境。
  migration.stdout.resume();
  migration.stderr.resume();
  const migrationClosed = once(migration, "close");
  const migrationTimeout = setTimeout(() => stop(migration), 60_000);
  const [migrationCode] = await migrationClosed;
  clearTimeout(migrationTimeout);
  assert.equal(migrationCode, 0, "local D1 migration failed");
  passed("isolated local D1 migrations");

  server = start([
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "0",
    "--inspector-port",
    "0",
    "--persist-to",
    state,
    "--assets",
    assets,
    "--show-interactive-dev-session=false",
  ]);
  serverClosed = once(server, "close");
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await until(
    () => {
      assert.equal(server.exitCode, null, "local dev exited before ready");
      return /Ready on http:\/\/127\.0\.0\.1:\d+/.test(output);
    },
    "local dev startup",
    60_000,
  );
  const origin = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)[1];

  async function request(path, options = {}) {
    const response = await fetch(new URL(path, origin), {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.headers.get("set-cookie"), null);
    return response;
  }

  for (const [path, file] of [
    ["/", "index.html"],
    ["/subscription", "subscription/index.html"],
    ["/login", "login/index.html"],
    ["/recover", "recover/index.html"],
    ["/account", "account/index.html"],
    ["/help", "help/index.html"],
    ["/status", "status/index.html"],
    ["/admin/", "admin/index.html"],
  ]) {
    let response = await request(path);
    // Astro 的目录 index 使用平台默认的尾斜杠规范化，最多一次同站跳转。
    if (response.status === 307 || response.status === 308) {
      const location = new URL(response.headers.get("location"), origin);
      assert.equal(location.origin, origin);
      assert.equal(location.pathname, `${path}/`);
      response = await request(location.pathname);
    }
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    assert.equal(body, await readFile(join(dist, file), "utf8"));
    if (path === "/admin/") {
      assert.match(body, /<meta name="robots" content="noindex, nofollow"/);
    }
    passed(`static ${path}${path === "/admin/" ? " + existing noindex" : ""}`);
  }
  const bundle = (await readdir(join(dist, "_astro"))).find((file) => file.endsWith(".js"));
  assert.ok(bundle, "built JavaScript asset exists");
  const bundleResponse = await request(`/_astro/${bundle}`);
  assert.equal(bundleResponse.status, 200);
  assert.equal(await bundleResponse.text(), await readFile(join(dist, "_astro", bundle), "utf8"));
  passed("static JavaScript asset");

  assert.equal(calls(), 0, "static hits must not execute Worker shell");
  passed("static Worker shell calls = 0");

  async function dynamic(path, status, options = {}) {
    const response = await request(path, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = await response.json();
    expectedCalls++;
    await until(() => calls() >= expectedCalls, "Worker request log");
    assert.equal(calls(), expectedCalls);
    return body;
  }
  const status = await dynamic("/api/v2/status", 200, {
    headers: { "sec-fetch-mode": "navigate" },
  });
  assert.equal(status.registration_open, false);
  assert.equal(status.mail_sending_available, false);
  assert.ok(Array.isArray(status.sources));
  passed("status API: Worker JSON beats colliding static file");

  for (const [label, path, method, code] of [
    ["Feed invalid shape", "/feeds/u/synthetic-invalid", "GET", 404],
    ["Feed method refusal", "/feeds/u/synthetic-invalid", "POST", 405],
    ["unsubscribe explicit refusal", "/unsubscribe/synthetic-invalid", "GET", 503],
    ["one-click explicit refusal", "/email/one-click/synthetic-invalid", "POST", 503],
    ["one-click static collision", "/email/one-click/synthetic-invalid", "GET", 405],
    ["unknown API", "/api/p5-synthetic-missing", "GET", 404],
    ["unknown navigation", "/p5-synthetic-missing", "GET", 404],
  ]) {
    const body = await dynamic(path, code, {
      method,
      headers:
        method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded" }
          : { "sec-fetch-mode": "navigate" },
      ...(method === "POST" ? { body: "List-Unsubscribe=One-Click" } : {}),
    });
    if (code === 503) {
      // 无秘密基线只能证明配置不足时失败关闭；无效 token 的 410 由业务测试覆盖。
      assert.equal(body.error.code, "temporarily_unavailable");
    } else {
      assert.equal(body.error.code, "validation");
      assert.equal(
        body.error.details.fields[0].reason,
        code === 405 ? "method_not_allowed" : "not_found",
      );
    }
    passed(`${label}: Worker ${code}, no static fallback`);
  }
  for (const id of ["synthetic-arbitrary-event", "00000000-0000-4000-8000-000000000001"]) {
    for (const navigation of ["direct", "refresh"]) {
      const path = `/events/${id}`;
      const response = await request(path, { headers: { "sec-fetch-mode": "navigate" } });
      assert.equal(
        response.status,
        200,
        `event shell: content-type=${response.headers.get("content-type")}, Worker calls=${calls()}`,
      );
      assert.equal(response.headers.get("location"), null);
      assert.equal(new URL(response.url).pathname, path);
      assert.equal(
        await response.text(),
        await readFile(join(dist, "events/detail/index.html"), "utf8"),
      );
      passed(`arbitrary event ${navigation}: 200 shell, unchanged URL`);
    }
  }
  assert.equal(calls(), expectedCalls, "detail rewrites must not execute Worker shell");
  console.log(`PASS A-P5-SITE ${cases} cases; dynamic/unknown Worker calls = ${expectedCalls}`);
  console.log("Unsubscribe refusals are NOT successful unsubscriptions; no E3 billing evidence.");
} finally {
  stop(server);
  if (serverClosed) await serverClosed;
  await rm(scratch, { recursive: true, force: true });
}
