// A-P2-PREAUTH · 申请验证码前的准入管线（任务卡 P2-01 交付物二/四）。
//
// 覆盖（docs/ACCEPTANCE.md A-P2-PREAUTH）：
// - 七步固定检查顺序：每一步单独失败时后续步骤不执行（spy + D1 计数代理断言），
//   ★ 限速在 Turnstile 之前（否则攻击者能用限速额度耗 Turnstile 配额）；
// - ★ 四条路径（已注册 / 未注册 / 满额 / 关闭注册）响应体、状态码、字节数一致，
//   耗时无系统性差异（中位数比值钉住）；
// - 关闭注册 / 满额 / 预算枯竭时未知邮箱不生成实际发信任务（落库为零）；
// - 已有用户登录不占新注册槽（存量计数不变）；
// - 并发同邮箱预占不超卖（Promise.all，真实 D1）；
// - Turnstile token 重放被拒（无发信任务产生）；
// - 注册槽预占的到期释放原语（§4.2 过期释放）。
// 迁移重放纪律与 A-P1-CAS 相同：空库顺序重放，本文件自足。

import { env } from "cloudflare:test";
import {
  ACCOUNT_MAX_STORED,
  AUTH_CHALLENGES_PER_EMAIL,
  assertResponsesFolded,
  BUDGET_PERIOD_KIND,
  MAIL_SIGNUP_AUTH_DAY,
  OTP_COOLDOWN,
  OTP_TTL,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  poolOfMailIntent,
  SECRET_BITS,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS_TOTAL_CAPACITY_KEY,
  listExpiredRegistrations,
  releaseExpiredRegistration,
  writeRegistrationOpen,
} from "../../accounts/admission/registration";
import { createApiShell, mintCsrfToken, parseCookieHeader, type ShellRoute } from "../../shell";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { computeEmailKey } from "../../storage/crypto/mac";
import { splitSqlStatements } from "../../storage/split-sql";
import { mintPreauthCookieValue, PREAUTH_COOKIE_NAME } from "./cookie";
import {
  type ChallengeAndMailTaskContext,
  type CreateChallengeAndMailTask,
  type PreauthAdmissionDeps,
  runPreauthAdmission,
} from "./pipeline";
import type { ApproximateRateGate, RateGateDecision } from "./rate-gate";
import type { TurnstileCheckResult, TurnstileVerifier } from "./turnstile";

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

const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const ADMISSION_PATH = "/api/v2/auth/challenges";

// —— 迁移重放（空库顺序重放） ——

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return (await stmt.all<T>()).results ?? [];
}

async function run(sql: string, ...params: unknown[]): Promise<void> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  await stmt.run();
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
    expect(statements.length, `迁移 ${name} 切分后为空`).toBeGreaterThan(0);
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
}, 180_000);

// —— 种子工具（全部合成数据） ——

let orderSeq = 1;

async function seedUser(emailKey: string): Promise<void> {
  await run(
    'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, auth_epoch, recovery_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)',
    `u_${orderSeq}`,
    orderSeq++,
    "active",
    emailKey,
    `eb_${orderSeq}`,
    new Uint8Array([1, 2, 3, 4]),
    T0,
    T0,
  );
}

async function seedCapacity(key: string, value: number): Promise<void> {
  await run(
    "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
    T0,
  );
}

async function seedChallenge(
  emailKey: string,
  createdAt: number,
  deadline = T0 + OTP_TTL * SECOND,
): Promise<void> {
  await run(
    "INSERT INTO auth_challenges (id, purpose, email_key, address_version, preauth_id, mac, deadline, created_at, updated_at) VALUES (?, 'login', ?, 0, 'seed', 'seed', ?, ?, ?)",
    `ch_${crypto.randomUUID()}`,
    emailKey,
    deadline,
    createdAt,
    createdAt,
  );
}

async function seedBudget(
  pool: "new_registration" | "existing_auth",
  occupancy: number,
): Promise<void> {
  const day = utcDayPeriod(T0);
  await run(
    "INSERT INTO usage_periods (id, pool, period_kind, period_key, user_id, reserved, settled, uncertain, period_start, period_end, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?)",
    `up_${crypto.randomUUID()}`,
    pool,
    BUDGET_PERIOD_KIND,
    day.key,
    occupancy,
    day.startMs,
    day.endMsExclusive,
    T0,
    T0,
  );
}

async function tableCount(table: string): Promise<number> {
  const row = await query<{ c: number }>(`SELECT count(*) AS c FROM ${table}`);
  return row[0]?.c ?? 0;
}

/** 范围计数（本文件内 D1 跨用例共享，断言必须按 email/主键收窄而不是全表）。 */
async function countWhere(sql: string, ...params: unknown[]): Promise<number> {
  const rows = await query<{ c: number }>(sql, ...params);
  return rows[0]?.c ?? 0;
}

async function capacityValue(key: string): Promise<number | null> {
  const rows = await query<{ value: number }>(
    "SELECT value FROM capacity_state WHERE key = ?",
    key,
  );
  return rows[0]?.value ?? null;
}

// —— 管线测试替身 ——

function fakeGate(decision: RateGateDecision = { allowed: true }) {
  const calls = { check: 0, record: 0 };
  const gate: ApproximateRateGate = {
    check() {
      calls.check += 1;
      return decision;
    },
    recordIntent() {
      calls.record += 1;
    },
  };
  return {
    gate,
    calls,
    setDecision(next: RateGateDecision) {
      decision = next;
    },
  };
}

function fakeTurnstile(result: TurnstileCheckResult = "passed", singleUse = false) {
  const calls = { verify: 0 };
  const seenPassed = new Set<string>();
  const verifier: TurnstileVerifier = {
    async verify({ token }) {
      calls.verify += 1;
      if (!singleUse) {
        return result;
      }
      // siteverify 的单次验证语义（[R09]）：同一 token 第二次校验必失败（timeout-or-duplicate）。
      if (seenPassed.has(token)) {
        return "failed";
      }
      seenPassed.add(token);
      return result;
    },
  };
  return { verifier, calls };
}

function recordingEffect() {
  const contexts: ChallengeAndMailTaskContext[] = [];
  const effect: CreateChallengeAndMailTask = async (ctx) => {
    contexts.push(ctx);
  };
  return { effect, contexts };
}

function writingEffect() {
  const contexts: ChallengeAndMailTaskContext[] = [];
  const effect: CreateChallengeAndMailTask = async (ctx) => {
    contexts.push(ctx);
    // 第 7 步替身：按 P2-02 将要落库的最小形状写挑战与发信任务（真实验证码生成不在本卡）。
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO auth_challenges (id, purpose, email_key, address_version, preauth_id, mac, deadline, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 'mac-placeholder', ?, ?, ?)",
        )
        .bind(
          crypto.randomUUID(),
          ctx.intent,
          ctx.emailKey,
          ctx.preauthId,
          ctx.challengeDeadline,
          ctx.now,
          ctx.now,
        ),
      ctx.db
        .prepare(
          "INSERT INTO mail_outbox (id, purpose, priority, period_key, address_version, payload_kind, status, created_at, updated_at) VALUES (?, ?, 0, ?, 0, 'synthetic', 'pending', ?, ?)",
        )
        .bind(
          crypto.randomUUID(),
          poolOfMailIntent(ctx.intent),
          OUTBOX_UNRESERVED_PERIOD_KEY,
          ctx.now,
          ctx.now,
        ),
    ]);
  };
  return { effect, contexts };
}

/** D1 计数代理：统计 prepare 次数，用于钉住第 4 步失败后不触任何数据库读。 */
function countingDb(base: D1Database): { db: D1Database; count: () => number } {
  let prepares = 0;
  const db = new Proxy(base, {
    get(target, prop) {
      if (prop === "prepare") {
        return (...args: Parameters<D1Database["prepare"]>) => {
          prepares += 1;
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db, count: () => prepares };
}

function admissionShell(deps: PreauthAdmissionDeps) {
  const route: ShellRoute = {
    method: "POST",
    pattern: ADMISSION_PATH,
    domain: "public",
    write: true,
    bodySchema: {
      fields: { email: { type: "string" }, turnstile_token: { type: "string" } },
    },
    csrfBinding: async ({ request }) =>
      parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME)?.split(".")[0] ?? "",
    handler: async (ctx) =>
      runPreauthAdmission(deps, {
        request: ctx.request,
        email: String(ctx.body?.email),
        turnstileToken: String(ctx.body?.turnstile_token),
      }),
  };
  return createApiShell({
    authenticator: {
      async authenticate() {
        return { kind: "none" } as const;
      },
    },
    csrfKey: async () => (await testKeyring).csrf(),
    routes: [route],
  });
}

interface AdmissionOptions {
  readonly email: string;
  readonly token?: string;
  readonly preauthValue?: string;
  readonly csrfToken?: string;
  readonly origin?: string | null;
  readonly rawBody?: string;
  readonly omitCsrf?: boolean;
}

async function admissionRequest(options: AdmissionOptions): Promise<Request> {
  const key = (await testKeyring).csrf();
  const preauthValue = options.preauthValue ?? (await mintPreauthCookieValue(key, T0)).value;
  const preauthId = preauthValue.split(".")[0];
  const headers = new Headers({ "content-type": "application/json" });
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "https://app.test");
  }
  headers.set("cookie", `${PREAUTH_COOKIE_NAME}=${preauthValue}`);
  if (!options.omitCsrf) {
    const token =
      options.csrfToken ?? (await mintCsrfToken(key, preauthId, randomBytes(SECRET_BITS / 8)));
    headers.set("cookie", `${PREAUTH_COOKIE_NAME}=${preauthValue}; __Host-hoyo_csrf=${token}`);
    headers.set("x-csrf-token", token);
  }
  return new Request(`https://app.test${ADMISSION_PATH}`, {
    method: "POST",
    headers,
    body:
      options.rawBody ??
      JSON.stringify({ email: options.email, turnstile_token: options.token ?? "tok-ok" }),
  });
}

function fixedClock(): { now: () => number } {
  return { now: () => T0 };
}

const fakeEnv = {} as Env;
const fakeCtx = { waitUntil() {} } as unknown as ExecutionContext;

async function foldShape(res: Response): Promise<{ status: number; bodyText: string }> {
  return { status: res.status, bodyText: await res.text() };
}

// —— 七步固定检查顺序 ——

describe("A-P2-PREAUTH 检查顺序（§4.2：顺序是安全属性）", () => {
  it("第 1 步结构失败 → 后续全部不执行（限速/Turnstile/数据库零调用）", async () => {
    const gate = fakeGate();
    const turnstile = fakeTurnstile();
    const effect = recordingEffect();
    const db = countingDb(env.DB);
    const shell = admissionShell({
      db: db.db,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "a@order.test", rawBody: "{not-json" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    expect(gate.calls.check).toBe(0);
    expect(turnstile.calls.verify).toBe(0);
    expect(effect.contexts.length).toBe(0);
    expect(db.count()).toBe(0);
  });

  it("第 2 步同源失败 → 限速与 Turnstile 零调用", async () => {
    const gate = fakeGate();
    const turnstile = fakeTurnstile();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: recordingEffect().effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "a@order.test", origin: "https://evil.test" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(401);
    expect(gate.calls.check).toBe(0);
    expect(turnstile.calls.verify).toBe(0);
  });

  it("第 2 步 CSRF 失败 → 限速与 Turnstile 零调用", async () => {
    const gate = fakeGate();
    const turnstile = fakeTurnstile();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: recordingEffect().effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "a@order.test", omitCsrf: true }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(401);
    expect(gate.calls.check).toBe(0);
    expect(turnstile.calls.verify).toBe(0);
  });

  it("预认证上下文无效（MAC 不成立）→ 401 no_session，先于限速", async () => {
    const gate = fakeGate();
    const turnstile = fakeTurnstile();
    const deps = {
      db: env.DB,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: recordingEffect().effect,
      now: fixedClock().now,
    } as const;
    const shell = admissionShell(deps);
    // 伪造 Cookie：为其绑定一个真实签发的 CSRF（shell 层通过），管线必须靠 MAC 拒绝。
    const forgedValue = "forged.1.2.mac";
    const forgedCsrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      "forged",
      randomBytes(SECRET_BITS / 8),
    );
    const res = await shell.fetch(
      await admissionRequest({
        email: "a@order.test",
        preauthValue: forgedValue,
        csrfToken: forgedCsrf,
      }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.details?.reason).toBe("no_session");
    expect(gate.calls.check).toBe(0);
    expect(turnstile.calls.verify).toBe(0);
  });

  it("★ 第 3 步限速在第 4 步 Turnstile 之前：限速拒绝时 siteverify 零调用", async () => {
    const gate = fakeGate({ allowed: false, reason: "cooldown_mirror", retryAfterMs: 5_000 });
    const turnstile = fakeTurnstile();
    const db = countingDb(env.DB);
    const shell = admissionShell({
      db: db.db,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: recordingEffect().effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "burst@order.test" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; details?: { retry_after_ms?: number } };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details?.retry_after_ms).toBe(5_000);
    expect(turnstile.calls.verify).toBe(0);
    expect(db.count()).toBe(0);
  });

  it("第 4 步 Turnstile 失败 → 邮箱与全局配额读零调用（countingDb = 0）", async () => {
    const turnstile = fakeTurnstile("failed");
    const db = countingDb(env.DB);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: db.db,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: turnstile.verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "a@order.test" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { fields: { path: string; reason: string }[] } };
    };
    expect(body.error.code).toBe("validation");
    expect(body.error.details.fields).toContainEqual({
      path: "turnstile_token",
      reason: "verification_failed",
    });
    expect(db.count()).toBe(0);
    expect(effect.contexts.length).toBe(0);
  });

  it("邮箱形状非法（第 1 步语义，管线内规范化）→ 400，先于限速与 Turnstile", async () => {
    const gate = fakeGate();
    const turnstile = fakeTurnstile();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: gate.gate,
      turnstile: turnstile.verifier,
      effect: recordingEffect().effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "not-an-email" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    expect(gate.calls.check).toBe(0);
    expect(turnstile.calls.verify).toBe(0);
  });

  it("第 5 步邮箱冷却中 → 429 带可公开等待，第 6/7 步未执行（无预占行、无效果）", async () => {
    const email = "cool@order.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    await seedChallenge(emailKey, T0 - 10 * SECOND);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { details?: { retry_after_ms?: number } } };
    expect(body.error.details?.retry_after_ms).toBe((OTP_COOLDOWN - 10) * SECOND);
    expect(effect.contexts.length).toBe(0);
    expect(await tableCount("admission_reservations")).toBe(0);
    expect(await tableCount("mail_outbox")).toBe(0);
  });

  it("第 5 步同邮箱有效挑战已满（AUTH_CHALLENGES_PER_EMAIL）→ 429，无发信任务", async () => {
    const email = "open@order.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    for (let i = 0; i < AUTH_CHALLENGES_PER_EMAIL; i++) {
      await seedChallenge(emailKey, T0 - (OTP_COOLDOWN + i + 1) * SECOND);
    }
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(429);
    expect(effect.contexts.length).toBe(0);
    expect(await tableCount("mail_outbox")).toBe(0);
  });

  it("第 5 步发信预算枯竭（MAIL_SIGNUP_AUTH_DAY 子额度满）→ 同形 202，无预占无发信任务", async () => {
    await seedBudget("new_registration", MAIL_SIGNUP_AUTH_DAY);
    const email = "budget@order.test";
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(JSON.stringify({ message: "符合条件的请求将发送验证码。" }));
    expect(effect.contexts.length).toBe(0);
    expect(await tableCount("admission_reservations")).toBe(0);
    expect(await tableCount("mail_outbox")).toBe(0);
    // 本文件内 D1 共享：清掉种下的占用行，避免毒化后续用例的预算判定。
    await run("DELETE FROM usage_periods");
  });

  it("第 6/7 步：注册开放时未知邮箱 → 原子预占成立 + 挑战及发信任务（效果替身）执行", async () => {
    await writeRegistrationOpen(env.DB, true, T0);
    const email = "fresh@order.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    const outboxBefore = await tableCount("mail_outbox");
    const effect = writingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(202);
    expect(effect.contexts.length).toBe(1);
    const ctx = effect.contexts[0];
    expect(ctx.intent).toBe("signup_auth");
    expect(ctx.emailKey).toBe(emailKey);
    expect(ctx.reservationId).not.toBeNull();
    expect(ctx.challengeDeadline).toBe(T0 + OTP_TTL * SECOND);
    // 预占行落库且到期=挑战截止（§4.2 验证码有效期间保留注册槽）。
    const rows = await query<{ state: string; expires_at: number; email_key: string }>(
      "SELECT state, expires_at, email_key FROM admission_reservations WHERE id = ?",
      ctx.reservationId ?? "",
    );
    expect(rows[0]?.state).toBe("reserved");
    expect(rows[0]?.expires_at).toBe(T0 + OTP_TTL * SECOND);
    expect(rows[0]?.email_key).toBe(emailKey);
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(1);
    expect(await tableCount("mail_outbox")).toBe(outboxBefore + 1);
    expect(
      await countWhere("SELECT count(*) AS c FROM auth_challenges WHERE email_key = ?", emailKey),
    ).toBe(1);
  });
});

// —— ★ 四条路径响应一致性与时序 ——

describe("A-P2-PREAUTH 四条路径同形（§4.2 折叠：已注册/未注册/满额/关闭注册）", () => {
  it("响应体、状态码、字节数逐对一致；耗时中位数无系统性差异", async () => {
    const keys = await testKeyring;
    const registeredEmail = "reg@fold.test";
    const registeredKey = await computeEmailKey(keys.emailLookup(), registeredEmail);
    await seedUser(registeredKey);
    const effect = recordingEffect();
    const deps: PreauthAdmissionDeps = {
      db: env.DB,
      keys,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    };
    const shell = admissionShell(deps);

    let signupSeq = 0;
    const requestFor = async (email: string) => admissionRequest({ email });

    // —— 形状：四条路径一次性采集 ——
    await writeRegistrationOpen(env.DB, true, T0);
    const registeredRes = await shell.fetch(await requestFor(registeredEmail), fakeEnv, fakeCtx);
    const unregisteredRes = await shell.fetch(
      await requestFor(`u${signupSeq++}@fold.test`),
      fakeEnv,
      fakeCtx,
    );
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, ACCOUNT_MAX_STORED);
    const fullRes = await shell.fetch(
      await requestFor(`u${signupSeq++}@fold.test`),
      fakeEnv,
      fakeCtx,
    );
    await writeRegistrationOpen(env.DB, false, T0);
    const closedRes = await shell.fetch(
      await requestFor(`u${signupSeq++}@fold.test`),
      fakeEnv,
      fakeCtx,
    );

    const shapes = await Promise.all(
      [registeredRes, unregisteredRes, fullRes, closedRes].map(foldShape),
    );
    expect(shapes.map((s) => s.status)).toEqual([202, 202, 202, 202]);
    for (const shape of shapes) {
      assertResponsesFolded(shape, shapes[0]);
      expect(shape.bodyText.length).toBe(shapes[0].bodyText.length);
    }
    // 只有两类「受理」路径产生发信意图（已注册登录、开放注册的未知邮箱）。
    expect(effect.contexts.map((ctx) => ctx.intent)).toEqual([
      "existing_auth_first_login",
      "signup_auth",
    ]);

    // —— 时序：中位数两两比较（开放态先测，再满额、再关闭，逐步收紧条件） ——

    async function medianMs(path: () => Promise<Response>, warmup = 3, n = 15): Promise<number> {
      for (let i = 0; i < warmup; i++) {
        await path();
      }
      const samples: number[] = [];
      for (let i = 0; i < n; i++) {
        const start = performance.now();
        await path();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)];
    }

    // 重新开放注册并把存量清回 0，恢复 admitted 形态。
    await writeRegistrationOpen(env.DB, true, T0);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 0);
    const registeredMs = await medianMs(async () =>
      shell.fetch(await requestFor(registeredEmail), fakeEnv, fakeCtx),
    );
    const unregisteredMs = await medianMs(async () =>
      shell.fetch(await requestFor(`t${signupSeq++}@fold.test`), fakeEnv, fakeCtx),
    );
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, ACCOUNT_MAX_STORED);
    const fullMs = await medianMs(async () =>
      shell.fetch(await requestFor(`f${signupSeq++}@fold.test`), fakeEnv, fakeCtx),
    );
    await writeRegistrationOpen(env.DB, false, T0);
    const closedMs = await medianMs(async () =>
      shell.fetch(await requestFor(`c${signupSeq++}@fold.test`), fakeEnv, fakeCtx),
    );

    const ratioBound = 2.5;
    expect(registeredMs / unregisteredMs).toBeLessThan(ratioBound);
    expect(unregisteredMs / registeredMs).toBeLessThan(ratioBound);
    expect(fullMs / closedMs).toBeLessThan(ratioBound);
    expect(closedMs / fullMs).toBeLessThan(ratioBound);
    // 恢复开放，避免影响后续用例。
    await writeRegistrationOpen(env.DB, true, T0);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 0);
  }, 60_000);

  it("★ 关闭注册时未知邮箱：无发信任务落库（mail_outbox / auth_challenges / 预占均为零）", async () => {
    await writeRegistrationOpen(env.DB, false, T0);
    const before = {
      outbox: await tableCount("mail_outbox"),
      challenges: await tableCount("auth_challenges"),
      reservations: await tableCount("admission_reservations"),
    };
    const effect = writingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(
      await admissionRequest({ email: "closed@fold.test" }),
      fakeEnv,
      fakeCtx,
    );
    expect(res.status).toBe(202);
    expect(effect.contexts.length).toBe(0);
    expect(await tableCount("mail_outbox")).toBe(before.outbox);
    expect(await tableCount("auth_challenges")).toBe(before.challenges);
    expect(await tableCount("admission_reservations")).toBe(before.reservations);
    await writeRegistrationOpen(env.DB, true, T0);
  });

  it("★ 已有用户登录不占新注册槽：存量计数不变、无预占行、意图为登录", async () => {
    const email = "login@fold.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    await seedUser(emailKey);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 7);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(202);
    expect(effect.contexts.length).toBe(1);
    expect(effect.contexts[0]?.intent).toBe("existing_auth_first_login");
    expect(effect.contexts[0]?.reservationId).toBeNull();
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(7);
    expect(
      await countWhere(
        "SELECT count(*) AS c FROM admission_reservations WHERE email_key = ?",
        emailKey,
      ),
    ).toBe(0);
  });

  it("满额时未知邮箱：无预占行、无发信任务、响应与关闭注册同形", async () => {
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, ACCOUNT_MAX_STORED);
    const email = "full@fold.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const res = await shell.fetch(await admissionRequest({ email }), fakeEnv, fakeCtx);
    expect(res.status).toBe(202);
    expect(effect.contexts.length).toBe(0);
    expect(
      await countWhere(
        "SELECT count(*) AS c FROM admission_reservations WHERE email_key = ?",
        emailKey,
      ),
    ).toBe(0);
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(ACCOUNT_MAX_STORED);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 0);
  });
});

// —— Turnstile 单次验证 ——

describe("A-P2-PREAUTH Turnstile 单次验证（[R09]，用过即废）", () => {
  it("同一 token 第二次申请被拒：无发信任务、无预占；两次各校验一次 siteverify", async () => {
    await writeRegistrationOpen(env.DB, true, T0);
    const turnstile = fakeTurnstile("passed", true);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: turnstile.verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const outboxBefore = await tableCount("mail_outbox");
    const first = await shell.fetch(
      await admissionRequest({ email: "replay1@t.test", token: "tok-single" }),
      fakeEnv,
      fakeCtx,
    );
    expect(first.status).toBe(202);
    expect(effect.contexts.length).toBe(1);
    const second = await shell.fetch(
      await admissionRequest({ email: "replay2@t.test", token: "tok-single" }),
      fakeEnv,
      fakeCtx,
    );
    // 重放 → 校验失败 → validation（不携带存在性信息）。
    expect(second.status).toBe(400);
    expect(effect.contexts.length).toBe(1);
    expect(turnstile.calls.verify).toBe(2);
    // 只有第一次（新 token）拿到预占与发信任务；重放的一无所有。
    for (const email of ["replay1@t.test", "replay2@t.test"]) {
      const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
      const expected = email === "replay1@t.test" ? 1 : 0;
      expect(
        await countWhere(
          "SELECT count(*) AS c FROM admission_reservations WHERE email_key = ?",
          emailKey,
        ),
      ).toBe(expected);
    }
    expect(await tableCount("mail_outbox")).toBe(outboxBefore);
  });
});

// —— 并发不超卖（真实 D1） ——

describe("A-P2-PREAUTH 并发预占不超卖（§4.2 同一规范邮箱共享有限预占）", () => {
  it("同一邮箱 8 路并发申请：恰好 1 条 reserved、计数 +1、效果至多一次", async () => {
    await writeRegistrationOpen(env.DB, true, T0);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 0);
    const email = "race@conc.test";
    const emailKey = await computeEmailKey((await testKeyring).emailLookup(), email);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const preauthValue = (await mintPreauthCookieValue((await testKeyring).csrf(), T0)).value;
    const csrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      preauthValue.split(".")[0],
      randomBytes(SECRET_BITS / 8),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, async () =>
        shell.fetch(
          await admissionRequest({ email, preauthValue, csrfToken: csrf }),
          fakeEnv,
          fakeCtx,
        ),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(202);
    }
    expect(
      await countWhere(
        "SELECT count(*) AS c FROM admission_reservations WHERE email_key = ? AND state = 'reserved'",
        emailKey,
      ),
    ).toBe(1);
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(1);
    expect(effect.contexts.length).toBe(1);
    expect(effect.contexts[0]?.emailKey).toBe(emailKey);
  }, 30_000);

  it("剩 1 个名额、5 个不同邮箱并发：恰好 1 成功，无超卖", async () => {
    await writeRegistrationOpen(env.DB, true, T0);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, ACCOUNT_MAX_STORED - 1);
    const effect = recordingEffect();
    const shell = admissionShell({
      db: env.DB,
      keys: await testKeyring,
      rateGate: fakeGate().gate,
      turnstile: fakeTurnstile().verifier,
      effect: effect.effect,
      now: fixedClock().now,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) =>
        shell.fetch(await admissionRequest({ email: `c${i}@conc.test` }), fakeEnv, fakeCtx),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(202);
    }
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(ACCOUNT_MAX_STORED);
    expect(effect.contexts.length).toBe(1);
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 0);
  }, 30_000);
});

// —— 注册槽过期释放 ——

describe("A-P2-PREAUTH 注册槽过期释放（§4.2：过期释放）", () => {
  it("过期 reserved 预占被列出并释放：状态 released、存量计数递减、审计落库", async () => {
    await seedCapacity(ACCOUNTS_TOTAL_CAPACITY_KEY, 1);
    await run(
      "INSERT INTO admission_reservations (id, kind, email_key, state, reserved_at, expires_at, created_at, updated_at) VALUES ('res-exp', 'registration', 'ek_exp', 'reserved', ?, ?, ?, ?)",
      T0 - OTP_TTL * SECOND,
      T0 - 1,
      T0 - OTP_TTL * SECOND,
      T0 - OTP_TTL * SECOND,
    );
    const expired = await listExpiredRegistrations(env.DB, T0);
    expect(expired.map((e) => e.id)).toContain("res-exp");
    const released = await releaseExpiredRegistration(env.DB, expired[0], T0);
    expect(released).toBe(true);
    expect(await capacityValue(ACCOUNTS_TOTAL_CAPACITY_KEY)).toBe(0);
    const rows = await query<{ state: string }>(
      "SELECT state FROM admission_reservations WHERE id = 'res-exp'",
    );
    expect(rows[0]?.state).toBe("released");
    expect(await tableCount("audit_log")).toBe(1);
  });

  it("未过期的 reserved 预占不出现在过期清单中（验证码有效期内保留注册槽）", async () => {
    await run(
      "INSERT INTO admission_reservations (id, kind, email_key, state, reserved_at, expires_at, created_at, updated_at) VALUES ('res-live', 'registration', 'ek_live', 'reserved', ?, ?, ?, ?)",
      T0,
      T0 + OTP_TTL * SECOND,
      T0,
      T0,
    );
    const expired = await listExpiredRegistrations(env.DB, T0);
    expect(expired.map((e) => e.id)).not.toContain("res-live");
    await run("DELETE FROM admission_reservations WHERE id = 'res-live'");
  });
});
