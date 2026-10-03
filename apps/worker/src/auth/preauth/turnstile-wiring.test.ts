// E2：真实 Worker 入口、生产校验器、本地 D1；仅 Siteverify fetch 被替换。
import { env } from "cloudflare:test";
import { AUTH_INTENT_PUBLIC_BODY } from "@hoyo/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { CSRF_HEADER_NAME } from "../../shell";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { seedOperationalControls } from "../../shell/observability/test-support";
import { fakeExecutionContext } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { toHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey } from "../../storage/crypto/mac";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { makePendingSession } from "../consume/session";
import { hashRecoverySecret } from "../recovery/credential";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}

const migrationFiles = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
// glob 深度防呆：路径写错时集合为空、重放静默跳过（曾因此误判「表不存在」）。
expect(Object.keys(migrationFiles).length).toBeGreaterThan(0);

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return (await stmt.all<T>()).results ?? [];
}

const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

async function resetToEmptyDatabase(): Promise<void> {
  const objects = await query<{ type: string; name: string }>(
    `SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND ${USER_OBJECT_FILTER}`,
  );
  for (const obj of objects) {
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  }
  let remaining = (
    await query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
    )
  ).map((row) => row.name);
  for (let round = 0; remaining.length > 0 && round < 20; round++) {
    let progress = false;
    for (const table of [...remaining]) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table}";`);
        progress = true;
      } catch {
        // 外键依赖未解除，下一轮重试
      }
    }
    if (!progress) break;
    remaining = (
      await query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
      )
    ).map((row) => row.name);
  }
  expect(remaining, "清库失败：空库重放前提不成立").toEqual([]);
}

beforeAll(async () => {
  await resetToEmptyDatabase();
  for (const name of Object.keys(migrationFiles).sort()) {
    const statements = splitSqlStatements(migrationFiles[name] ?? "");
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
}, 180_000);

// Request origin deliberately differs: the allowed hostname must come from SITE_ORIGIN.
const requestOrigin = "https://request.example.invalid";
const siteOrigin = "https://configured.example.invalid";
let sequence = 0;
function runtime(origin = siteOrigin) {
  return {
    ...env,
    SITE_ORIGIN: origin,
    AUTH_MAIL_FROM: "auth@example.invalid",
    BIZ_MAIL_FROM: "business@example.invalid",
    TURNSTILE_SECRET_KEY: "synthetic-secret",
    CRYPTO_MASTER_SECRET: toHex(generateSecretToken().bytes),
    CRYPTO_OTP_PEPPER: toHex(generateSecretToken().bytes),
    CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic-key",
  };
}
type Runtime = ReturnType<typeof runtime>;
function post(config: Runtime, path: string, body: unknown, cookie = "", csrf = "") {
  return worker.fetch(
    new Request(`${requestOrigin}/api/v2/${path}`, {
      method: "POST",
      headers: {
        origin: requestOrigin,
        "content-type": "application/json",
        cookie,
        [CSRF_HEADER_NAME]: csrf,
      },
      body: JSON.stringify(body),
    }),
    config,
    fakeExecutionContext,
  );
}
async function preauth(config: Runtime) {
  const res = await post(config, "auth/preauth", {});
  expect(res.status).toBe(200);
  return {
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    csrf: ((await res.json()) as { csrf_token: string }).csrf_token,
  };
}
async function openMail() {
  await seedOperationalControls(env.DB);
  await env.DB.prepare(
    "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',1) ON CONFLICT(key) DO UPDATE SET value_json='true'",
  ).run();
}
async function owner(config: Runtime) {
  const keys = await Keyring.create({
    masterSecret: Uint8Array.from(config.CRYPTO_MASTER_SECRET.match(/../g) ?? [], (x) =>
      Number.parseInt(x, 16),
    ),
    otpPepper: Uint8Array.from(config.CRYPTO_OTP_PEPPER.match(/../g) ?? [], (x) =>
      Number.parseInt(x, 16),
    ),
    unsubscribeMacCurrentKeyId: config.CRYPTO_UNSUBSCRIBE_KEY_ID,
  });
  const userId = crypto.randomUUID(),
    now = Date.now();
  const email = `synthetic-${++sequence}@example.invalid`;
  const emailKey = await computeEmailKey(keys.emailLookup(), email);
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id: userId },
    email,
  );
  await env.DB.prepare(`INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,auth_epoch,recovery_epoch,created_at,updated_at)
    VALUES (?,?,'active',?,?,?,1,0,0,?,?)`)
    .bind(userId, sequence, emailKey, crypto.randomUUID(), ciphertext, now, now)
    .run();
  const made = await makePendingSession(now);
  await env.DB.prepare(`INSERT INTO sessions
    (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,recovery_code_required,activated_at,created_at,updated_at)
    VALUES (?,?,?,'active',?,?,?,?,?,?,0,0,0,?,?,?)`)
    .bind(
      made.id,
      userId,
      made.tokenHash,
      made.label,
      made.platformHint,
      now,
      made.absoluteExpiresAt,
      made.expiresAt,
      now,
      now,
      now,
      now,
    )
    .run();
  const recoveryId = crypto.randomUUID(),
    secret = "synthetic-recovery-secret";
  await env.DB.prepare(`INSERT INTO recovery_credentials (id,user_id,secret_hash,generation,saved_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?)`)
    .bind(recoveryId, userId, await hashRecoverySecret(secret), now, now, now)
    .run();
  const cookie = `${USER_SESSION_COOKIE_NAME}=${made.cookieValue}`;
  const sessions = await worker.fetch(
    new Request(`${requestOrigin}/api/v2/me/sessions`, { headers: { cookie } }),
    config,
    fakeExecutionContext,
  );
  expect(sessions.status).toBe(200);
  return {
    email,
    recoveryId,
    secret,
    cookie: [cookie, ...sessions.headers.getSetCookie().map((c) => c.split(";")[0])].join("; "),
    csrf: ((await sessions.json()) as { csrf_token: string }).csrf_token,
  };
}
function upstream(hostname: string, action: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ success: true, hostname, action }));
}
afterEach(() => vi.restoreAllMocks());

describe("A-P2-PREAUTH Worker 入口的 Turnstile 绑定", () => {
  it.each([false, true])("登录与注册共享 login 和同形响应（已有账号 %s）", async (existing) => {
    await openMail();
    await env.DB.prepare(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('registration_open','true',1) ON CONFLICT(key) DO UPDATE SET value_json='true'",
    ).run();
    const config = runtime();
    const email = existing
      ? (await owner(config)).email
      : `synthetic-new-${++sequence}@example.invalid`;
    const context = await preauth(config);
    const key = crypto.randomUUID();
    const check = upstream("configured.example.invalid", "login");
    const res = await post(
      config,
      "auth/challenges",
      { email, idempotency_key: key, turnstile_token: "synthetic-token" },
      context.cookie,
      context.csrf,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(AUTH_INTENT_PUBLIC_BODY);
    expect(check).toHaveBeenCalledOnce();
    const challenge = await env.DB.prepare(
      "SELECT purpose FROM auth_challenges WHERE idempotency_key=?",
    )
      .bind(key)
      .first();
    expect(challenge).toEqual({ purpose: existing ? "login" : "signup" });
  });
  it.each([
    ["request.example.invalid", "login"],
    ["configured.example.invalid", "account_delete_current"],
  ])("登录拒绝错误域名或用途 %s %s", async (hostname, action) => {
    await openMail();
    const config = runtime(),
      context = await preauth(config);
    const check = upstream(hostname, action);
    const res = await post(
      config,
      "auth/challenges",
      {
        email: `reject-${++sequence}@example.invalid`,
        idempotency_key: crypto.randomUUID(),
        turnstile_token: "synthetic-token",
      },
      context.cookie,
      context.csrf,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("verification_failed");
    expect(check).toHaveBeenCalledOnce();
  });
  for (const [action, role, expected] of [
    ["email_change", "current", "email_change_current"],
    ["email_change", "new_address", "email_change_new_address"],
    ["recovery_code_rotate", "current", "recovery_code_rotate_current"],
    ["account_delete", "current", "account_delete_current"],
  ] as const) {
    it.each(["valid", "hostname", "action"])(`最近认证 ${expected}：%s`, async (mode) => {
      await openMail();
      const config = runtime(),
        context = await owner(config);
      const check = upstream(
        mode === "hostname" ? "request.example.invalid" : "configured.example.invalid",
        mode === "action" ? "login" : expected,
      );
      const res = await post(
        config,
        "me/recent-auth/challenges",
        {
          action,
          role,
          ...(action === "email_change"
            ? { target_email: `target-${++sequence}@example.invalid` }
            : {}),
          idempotency_key: crypto.randomUUID(),
          turnstile_token: "synthetic-token",
        },
        context.cookie,
        context.csrf,
      );
      expect(res.status).toBe(mode === "valid" ? 202 : 400);
      if (mode !== "valid") expect(await res.text()).toContain("verification_failed");
      expect(check).toHaveBeenCalledOnce();
    });
  }
  it.each(["", "invalid", "https://localhost", "https://127.0.0.1"])(
    "配置无效时 Worker 失败关闭 %#",
    async (origin) => {
      await openMail();
      const config = runtime(origin),
        context = await preauth(config);
      const check = upstream("configured.example.invalid", "login");
      const res = await post(
        config,
        "auth/challenges",
        {
          email: "synthetic@example.invalid",
          idempotency_key: crypto.randomUUID(),
          turnstile_token: "synthetic-token",
        },
        context.cookie,
        context.csrf,
      );
      expect(res.status).toBe(503);
      expect(check).not.toHaveBeenCalled();
    },
  );
  it("不接受客户端自报 expectedAction；非法用途/角色也不触发 Siteverify", async () => {
    await openMail();
    const config = runtime(),
      context = await owner(config);
    const check = upstream("configured.example.invalid", "login");
    const send = (action: string, role: string, extra = {}) =>
      post(
        config,
        "me/recent-auth/challenges",
        {
          action,
          role,
          idempotency_key: crypto.randomUUID(),
          turnstile_token: "synthetic-token",
          ...extra,
        },
        context.cookie,
        context.csrf,
      );
    for (const res of [
      await send("account_delete", "current", { expectedAction: "login" }),
      await send("login", "current"),
      await send("account_delete", "invalid"),
      await send("account_delete", "new_address"),
    ])
      expect(res.status).toBeGreaterThanOrEqual(400);
    expect(check).not.toHaveBeenCalled();
  });
  it("A-P2-RECOVERY 紧急停用无 Turnstile 配置仍可重复执行且不消费恢复码", async () => {
    const config = runtime("");
    config.TURNSTILE_SECRET_KEY = "";
    const account = await owner(config),
      context = await preauth(config);
    const check = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call"));
    for (let i = 0; i < 2; i++) {
      const res = await post(
        config,
        "auth/recovery",
        { action: "emergency_stop", recovery_id: account.recoveryId, secret: account.secret },
        context.cookie,
        context.csrf,
      );
      expect(res.status).toBe(200);
      expect(
        await env.DB.prepare("SELECT consumed_at FROM recovery_credentials WHERE id=?")
          .bind(account.recoveryId)
          .first(),
      ).toEqual({ consumed_at: null });
    }
    expect(check).not.toHaveBeenCalled();
  });
});
