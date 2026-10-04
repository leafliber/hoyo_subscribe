import { spawn } from "node:child_process";
import { createHmac, hkdfSync } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { SOURCE_REGISTRY } from "../../apps/worker/src/sources/registry";
import {
  EMAIL_CONSENT_VERSION,
  OPERATIONAL_CONTROLS,
  SECRET_BITS,
} from "../../packages/contracts/src";

// 合成数据 + 真实 wrangler dev --local / D1 / 生产 Worker 入口。
// 浏览器只访问无能力的别名；route 仅转发原始 HTTP 请求/响应，不制作页面或模拟退订。
// token 只在 Node 内存里使用，禁用 trace/video/失败截图；Wrangler 日志丢弃。
test.use({ trace: "off", video: "off", screenshot: "off" });
const root = fileURLToPath(new URL("../..", import.meta.url));
const worker = path.join(root, "apps/worker");
const wrangler = path.join(worker, "node_modules/wrangler/bin/wrangler.js");

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("local_port_unavailable");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

test("U26 真实本地 Worker/D1 全关/read_only：GET→确认→幂等→重新开启→旧链接→换绑；one-click 无交互", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const scratch = await mkdtemp(path.join(tmpdir(), "hoyo-f4-03-synthetic-"));
  await symlink("/dev/null", path.join(scratch, "wrangler.log"));
  const state = path.join(scratch, "state");
  const config = path.join(scratch, "wrangler.jsonc");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  Object.assign(env, {
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: path.join(scratch, "wrangler.log"),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  });
  const master = crypto.getRandomValues(new Uint8Array(SECRET_BITS / 8));
  const pepper = crypto.getRandomValues(new Uint8Array(SECRET_BITS / 8));
  const keyId = "synthetic";
  const binding = crypto.randomUUID();
  // 独立构造合成协议夹具；真实 Worker 仍执行生产 MAC 校验，不替换 token 验证器。
  const macKey = hkdfSync(
    "sha256",
    master,
    new Uint8Array(),
    `hoyo-crypto:v1:unsubscribe-mac:key:${keyId}`,
    SECRET_BITS / 8,
  );
  const signature = createHmac("sha256", macKey)
    .update(JSON.stringify(["unsubscribe-mac:v1", binding, "business"]))
    .digest("base64url");
  const token = `${Buffer.from(binding).toString("base64url")}.business.v1.${keyId}.${signature}`;
  const source = (await readFile(path.join(worker, "wrangler.jsonc"), "utf8"))
    .replace('"src/index.ts"', JSON.stringify(path.join(worker, "src/index.ts")))
    .replace('"../web/dist"', JSON.stringify(path.join(root, "apps/web/dist")))
    .replace('"../../migrations"', JSON.stringify(path.join(root, "migrations")));
  await writeFile(
    config,
    source.replace(
      /}\s*$/,
      `,"vars":${JSON.stringify({
        CRYPTO_MASTER_SECRET: Buffer.from(master).toString("hex"),
        CRYPTO_OTP_PEPPER: Buffer.from(pepper).toString("hex"),
        CRYPTO_UNSUBSCRIBE_KEY_ID: keyId,
        SITE_ORIGIN: "https://synthetic.example",
      })}}`,
    ),
  );

  const start = (args: string[], capture = false) =>
    spawn(process.execPath, [wrangler, ...args, "--config", config], {
      cwd: scratch,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
  async function command(args: string[]) {
    const child = start(args, true);
    let output = "";
    let diagnostic = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      diagnostic += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
    const [code] = await once(child, "close");
    clearTimeout(timeout);
    if (code !== 0) {
      const safe = (output + diagnostic)
        .replaceAll(Buffer.from(master).toString("hex"), "[redacted]")
        .replaceAll(Buffer.from(pepper).toString("hex"), "[redacted]")
        .replaceAll(token, "[redacted]")
        .replace(/https?:[^\s]+/g, "[URL omitted]");
      throw new Error(`local D1 command failed: ${safe.slice(-3000)}`);
    }
    return output;
  }
  async function sql(statement: string) {
    const file = path.join(scratch, "synthetic.sql");
    await writeFile(file, statement);
    const output = await command([
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      state,
      "--file",
      file,
      "--json",
    ]);
    return JSON.parse(output) as { results: Record<string, unknown>[] }[];
  }
  let server: ReturnType<typeof start> | undefined;
  try {
    await command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
    await sql(`INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
      VALUES ('synthetic-f4-03',1,'active','synthetic-f4-03','${binding}',X'00',1,1,1);
      INSERT INTO email_channels(user_id,enabled,routine_enabled,consent_version,address_version,created_at,updated_at)
      VALUES ('synthetic-f4-03',1,1,${EMAIL_CONSENT_VERSION},1,1,1);`);
    const controlKeys = [
      ...OPERATIONAL_CONTROLS.filter((key) => key !== "source_enabled"),
      ...SOURCE_REGISTRY.map((source) => `source:${source.sourceId}`),
    ];
    // 仅合成数据库显式关闭所有运行门；不改变生产默认或借缺失配置冒充 false。
    await sql(`INSERT INTO system_state(key,value_json,updated_at)
      SELECT value,CASE WHEN value='read_only' THEN 'true' ELSE 'false' END,1
      FROM json_each('${JSON.stringify(controlKeys)}')
      WHERE true ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json;`);
    const controls = await sql("SELECT key,value_json FROM system_state ORDER BY key;");
    expect(controls[0].results).toEqual(
      controlKeys.sort().map((key) => ({
        key,
        value_json: key === "read_only" ? "true" : "false",
      })),
    );
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    server = start([
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      state,
      "--log-level",
      "none",
      "--show-interactive-dev-session=false",
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        ready = (await fetch(`${origin}/api/v2/status`)).ok;
      } catch {
        /* starting */
      }
      if (ready) break;
      await delay(250);
    }
    expect(ready, "real local Worker ready").toBe(true);
    const request = async (oneClick: boolean, method = "GET", body?: string, invalid = false) => {
      try {
        return await fetch(
          `${origin}/${oneClick ? "email/one-click" : "unsubscribe"}/${invalid ? "synthetic-invalid" : token}`,
          {
            method,
            body,
            redirect: "manual",
            ...(body ? { headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
          },
        );
      } catch {
        throw new Error("synthetic_local_request_failed (capability omitted)");
      }
    };
    const snapshot = async () =>
      (
        await sql(
          "SELECT enabled,routine_enabled,channel_revision FROM email_channels; SELECT COUNT(*) n FROM consent_events;",
        )
      ).map((result) => result.results);
    let invalidPage = false;
    let getCount = 0;
    let postCount = 0;
    let securityChecked = false;
    await page.route("**/synthetic-unsubscribe", async (route) => {
      const req = route.request();
      const res = await request(false, req.method(), req.postData() ?? undefined, invalidPage);
      if (req.method() === "POST") postCount++;
      else getCount++;
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
      const body = await res.text();
      expect(body.includes(token), "HTML does not expose capability").toBe(false);
      securityChecked = true;
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body });
    });
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    const screenshot = async (name: string) => {
      const destination =
        process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
          ? path.join(root, "tests/e2e/evidence/f4-03", `${info.project.name}-${name}.png`)
          : info.outputPath(`${name}.png`);
      await mkdir(path.dirname(destination), { recursive: true });
      await page.screenshot({ path: destination, fullPage: true });
    };
    const before = await snapshot();
    await page.goto("/synthetic-unsubscribe");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("关闭业务邮件");
    expect(await snapshot()).toEqual(before);
    expect(postCount).toBe(0);
    await screenshot("confirm");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "关闭此邮箱的业务邮件" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("业务邮件已关闭");
    await expect(
      page.getByText("日历订阅、浏览器通知（Push）、账号和验证码邮件不受影响。"),
    ).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    expect(postCount).toBe(1);
    const closed = await snapshot();
    expect(closed).toEqual([[{ enabled: 0, routine_enabled: 0, channel_revision: 1 }], [{ n: 2 }]]);
    await screenshot("closed");
    await page.goto("/synthetic-unsubscribe");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("业务邮件已关闭");
    expect((await request(false, "POST", "confirm=unsubscribe")).status).toBe(200);
    expect(await snapshot()).toEqual(closed);
    await sql(
      "UPDATE email_channels SET enabled=1,routine_enabled=1 WHERE user_id='synthetic-f4-03';",
    );
    // 同一旧 token 在重新开启之后仍有效；标准 one-click 没有 Cookie/CSRF/登录/重定向。
    const oneClick = await request(true, "POST", "List-Unsubscribe=One-Click");
    expect(oneClick.status).toBe(204);
    expect(oneClick.headers.get("set-cookie")).toBeNull();
    expect(oneClick.headers.get("location")).toBeNull();
    expect(await oneClick.text()).toBe("");
    expect((await snapshot())[0]).toEqual([
      { enabled: 0, routine_enabled: 0, channel_revision: 2 },
    ]);
    await sql(
      "UPDATE users SET email_binding_id='synthetic-new-binding',email_version=2; UPDATE email_channels SET enabled=1,routine_enabled=1;",
    );
    const changed = await snapshot();
    const stale = await page.goto("/synthetic-unsubscribe");
    expect(stale?.status()).toBe(410);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("旧绑定已失效");
    await expect(page.getByText(/此链接不适用于当前邮箱/)).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    await screenshot("stale");
    expect((await request(false, "POST", "confirm=unsubscribe")).status).toBe(410);
    expect((await request(true, "POST", "List-Unsubscribe=One-Click")).status).toBe(410);
    expect(await snapshot()).toEqual(changed);
    invalidPage = true;
    await page.goto("/synthetic-unsubscribe");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("退订链接已失效");
    await screenshot("invalid");
    expect(await snapshot()).toEqual(changed);
    expect(getCount).toBe(4);
    expect(securityChecked).toBe(true);
    // 页面只额外加载同源的固定样式表与站点图标（no-referrer，不带能力 token），没有其他请求。
    expect(
      requests.every((p) =>
        ["/synthetic-unsubscribe", "/mail-page.css", "/favicon.svg"].includes(p),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    if (server && server.exitCode === null) {
      const stopped = once(server, "close");
      server.kill("SIGTERM");
      await stopped;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
