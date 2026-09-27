// A-P2-OTP · OTP 挑战生命周期（任务卡 P2-02；主方案 §4.1、§4.3、§7.2、附录 A.2/A.5）。
//
// 覆盖（docs/ACCEPTANCE.md A-P2-OTP）：
// - ★ 重发只旋转本挑战 generation：不重置累计失败次数、不延长最初截止、不废其他浏览器挑战；
// - ★ 错误尝试持久扣减，不被返回错误的事务回滚抵消；
// - ★ 活动 Cookie 临近到期不影响新验证码；Cookie 丢失 / 无开放挑战不误报为验证码错误；
// - ★ PREAUTH_MIN_TTL 下限本身满足 A.5 不等式；续期覆盖最晚挑战截止 + 完成余量；
// - 大小写不同的登录请求 → 同一账号且投递地址不被改写（§4.1）；
// - 并发重发不产生多份有效码（同键 / 异键）；
// - 挑战数达到 AUTH_CHALLENGES_PER_EMAIL 后拒绝；重发冷却与当日合计；
// - 认证池 floor 降级：重发暂停、既有账号首次登录放行、新注册发信暂停（§7.2）；
// - MAC 绑定六元组：任一字段变化则 MAC 不同；验证码原值只在短期受控密文中；
// - 网络重试幂等（idempotency_key）；过期清除原语；三端点路由挂载冒烟。
//
// 迁移重放纪律与 A-P2-PREAUTH 相同：空库顺序重放，本文件自足。
// 隔离纪律：共享 D1 与可控时钟；每个用例先跳到独立 UTC 日（usage_periods 按日分桶，
// 跨用例共用同一天会互相吃掉认证池额度），邮箱逐用例唯一。

import { env } from "cloudflare:test";
import {
  AUTH_COMPLETION_TTL,
  assertResponsesFolded,
  authDayTotalLimit,
  BUDGET_PERIOD_KIND,
  MAIL_AUTH_FLOOR,
  OTP_ATTEMPTS,
  OTP_COOLDOWN,
  OTP_DIGITS,
  OTP_TTL,
  PREAUTH_MARGIN,
  PREAUTH_MIN_TTL,
  SECRET_BITS,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { writeRegistrationOpen } from "../../accounts/admission/registration";
import { createApiShell, mintCsrfToken, parseCookieHeader, type ShellRoute } from "../../shell";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { computeEmailKey, macOtpVerification } from "../../storage/crypto/mac";
import { splitSqlStatements } from "../../storage/split-sql";
import { mintPreauthCookieValue, PREAUTH_COOKIE_NAME } from "../preauth/cookie";
import { runPreauthAdmission } from "../preauth/pipeline";
import type { ApproximateRateGate, RateGateDecision } from "../preauth/rate-gate";
import type { TurnstileVerifier } from "../preauth/turnstile";
import { clearExpiredOtpPayloads } from "./cleanup";
import { createChallengeAndMailTask } from "./create-challenge";
import { decryptOtpPayload } from "./payload";
import { runResendOtp } from "./resend";
import { makeChallengeRoutes } from "./routes";
import { runVerifyOtp } from "./verify";

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
// glob 深度防呆：路径写错时集合为空、重放静默跳过（A-P2-PREAUTH 踩过的坑）。
expect(Object.keys(migrationFiles).length).toBeGreaterThan(0);

const SECOND = 1_000;

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
  await writeRegistrationOpen(env.DB, true, 0);
}, 180_000);

// —— 可控时钟（多数用例共享；冒烟用例用真实时钟） ——

let clockMs = utcDayStart(1_800_000_000_000) + SECOND;
const clock = () => clockMs;

/** 推进到独立 UTC 日（+1s 避开边界），隔离 usage_periods 日桶。 */
function isolateDay(): void {
  clockMs = utcDayPeriod(clockMs).endMsExclusive + SECOND;
}

function utcDayStart(ms: number): number {
  return utcDayPeriod(ms).startMs;
}

// —— 壳与请求构造 ——

const fakeEnv = {} as Env;
const fakeCtx = { waitUntil() {} } as unknown as ExecutionContext;

function allowAllGate(): ApproximateRateGate {
  const decision: RateGateDecision = { allowed: true };
  return {
    check: () => decision,
    recordIntent() {},
  };
}

const passTurnstile: TurnstileVerifier = { verify: () => Promise.resolve("passed") };

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function localShell(): ReturnType<typeof createApiShell> {
  const csrfBinding = async ({ request }: { request: Request }) =>
    parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME)?.split(".")[0] ?? "";
  const routes: ShellRoute[] = [
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          turnstile_token: { type: "string" },
          idempotency_key: {
            type: "string",
            optional: true,
            minLength: 1,
            maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
          },
        },
      },
      csrfBinding,
      handler: async (ctx) =>
        runPreauthAdmission(
          {
            db: env.DB,
            keys: await testKeyring,
            rateGate: allowAllGate(),
            turnstile: passTurnstile,
            effect: createChallengeAndMailTask,
            now: clock,
          },
          {
            request: ctx.request,
            email: String(ctx.body?.email),
            turnstileToken: String(ctx.body?.turnstile_token ?? ""),
            idempotencyKey:
              typeof ctx.body?.idempotency_key === "string" && ctx.body.idempotency_key.length > 0
                ? ctx.body.idempotency_key
                : null,
          },
        ),
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges/resend",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          idempotency_key: {
            type: "string",
            minLength: 1,
            maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
          },
        },
      },
      csrfBinding,
      handler: async (ctx) =>
        runResendOtp(
          { db: env.DB, keys: await testKeyring, now: clock },
          {
            request: ctx.request,
            email: String(ctx.body?.email),
            idempotencyKey: String(ctx.body?.idempotency_key ?? ""),
          },
        ),
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges/verify",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          code: { type: "string", minLength: 1, maxLength: 32 },
        },
      },
      csrfBinding,
      handler: async (ctx) =>
        runVerifyOtp(
          { db: env.DB, keys: await testKeyring, now: clock },
          {
            request: ctx.request,
            email: String(ctx.body?.email),
            code: String(ctx.body?.code ?? ""),
          },
        ),
    },
  ];
  return createApiShell({
    authenticator: {
      async authenticate() {
        return { kind: "none" } as const;
      },
    },
    csrfKey: async () => (await testKeyring).csrf(),
    routes,
  });
}

const shell = localShell();

/** 每个用例唯一的邮箱（避免跨用例配额干扰）。 */
function freshEmail(tag: string): string {
  return `p202-${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

async function preauthContext(issuedAt = clockMs): Promise<{ value: string; id: string }> {
  const minted = await mintPreauthCookieValue((await testKeyring).preauthCookie(), issuedAt);
  return { value: minted.value, id: minted.context.preauthId };
}

interface RequestOptions {
  readonly email: string;
  readonly idempotencyKey?: string;
  readonly preauthValue?: string;
  readonly code?: string;
  /** 完全不带 Cookie（CSRF 也缺失）——用于 401 路径。 */
  readonly noCookies?: boolean;
  /** 带 CSRF 但故意不带 preauth Cookie——模拟「preauth Cookie 丢失」。 */
  readonly csrfOnly?: boolean;
}

async function buildRequest(
  path: string,
  options: RequestOptions,
  body: Record<string, unknown>,
): Promise<Request> {
  const preauthValue = options.preauthValue ?? (await preauthContext()).value;
  const preauthId = preauthValue.split(".")[0];
  const csrfToken = await mintCsrfToken(
    (await testKeyring).csrf(),
    preauthId,
    randomBytes(SECRET_BITS / 8),
  );
  const headers = new Headers({ "content-type": "application/json", origin: "https://app.test" });
  if (!options.noCookies) {
    headers.set("x-csrf-token", csrfToken);
    if (options.csrfOnly) {
      headers.set("cookie", `__Host-hoyo_csrf=${csrfToken}`);
    } else {
      headers.set(
        "cookie",
        `${PREAUTH_COOKIE_NAME}=${preauthValue}; __Host-hoyo_csrf=${csrfToken}`,
      );
    }
  }
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function apply(options: RequestOptions): Promise<Response> {
  const body: Record<string, unknown> = { email: options.email, turnstile_token: "tok-ok" };
  if (options.idempotencyKey !== undefined) {
    body.idempotency_key = options.idempotencyKey;
  }
  return shell.fetch(
    await buildRequest("/api/v2/auth/challenges", options, body),
    fakeEnv,
    fakeCtx,
  );
}

async function resend(options: RequestOptions & { idempotencyKey: string }): Promise<Response> {
  return shell.fetch(
    await buildRequest("/api/v2/auth/challenges/resend", options, {
      email: options.email,
      idempotency_key: options.idempotencyKey,
    }),
    fakeEnv,
    fakeCtx,
  );
}

async function verify(options: RequestOptions & { code: string }): Promise<Response> {
  return shell.fetch(
    await buildRequest("/api/v2/auth/challenges/verify", options, {
      email: options.email,
      code: options.code,
    }),
    fakeEnv,
    fakeCtx,
  );
}

// —— 种子与读侧辅助 ——

let userSeq = 1;

/** 种子既有账号：身份键 = canonicalEmail 的 HMAC，密文 = 投递地址原大小写（§4.1）。 */
async function seedUser(
  canonicalEmail: string,
  deliveryAddress: string,
): Promise<{ id: string; emailKey: string }> {
  const keys = await testKeyring;
  const emailKey = await computeEmailKey(keys.emailLookup(), canonicalEmail);
  const id = `u_${crypto.randomUUID().slice(0, 12)}`;
  // 受控密文 delivery-email-address；AAD 记录 ID = users.id（delivery.ts 读取侧约定）。
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id },
    deliveryAddress,
  );
  await run(
    'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, auth_epoch, recovery_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)',
    id,
    userSeq++,
    "active",
    emailKey,
    `eb_${userSeq}`,
    ciphertext,
    clockMs,
    clockMs,
  );
  return { id, emailKey };
}

async function emailKeyOf(canonicalEmail: string): Promise<string> {
  return computeEmailKey((await testKeyring).emailLookup(), canonicalEmail);
}

interface ChallengeDbRow {
  id: string;
  purpose: string;
  email_key: string;
  address_version: number;
  preauth_id: string;
  idempotency_key: string | null;
  mac: string;
  generation: number;
  attempts: number;
  deadline: number;
  reservation_id: string | null;
  consumed_at: number | null;
  aborted_at: number | null;
  created_at: number;
}

async function challengesOf(emailKey: string, preauthId?: string): Promise<ChallengeDbRow[]> {
  return preauthId
    ? query<ChallengeDbRow>(
        "SELECT * FROM auth_challenges WHERE email_key = ? AND preauth_id = ? ORDER BY created_at",
        emailKey,
        preauthId,
      )
    : query<ChallengeDbRow>(
        "SELECT * FROM auth_challenges WHERE email_key = ? ORDER BY created_at",
        emailKey,
      );
}

interface OutboxDbRow {
  id: string;
  purpose: string;
  period_key: string;
  recipient_user_id: string | null;
  address_version: number;
  payload_kind: string;
  payload_ref: string | null;
  payload_ciphertext: ArrayBuffer | Uint8Array | null;
  status: string;
  idempotency_key: string | null;
  created_at: number;
}

async function outboxOf(challengeId: string): Promise<OutboxDbRow[]> {
  return query<OutboxDbRow>(
    "SELECT * FROM mail_outbox WHERE payload_ref = ? ORDER BY created_at",
    challengeId,
  );
}

/** 最新可解密载荷（模拟发送阶段：服务器能解密——短期受控密文，非「不可读取」）。 */
async function latestPayload(challengeId: string) {
  const rows = await query<{ id: string; payload_ciphertext: ArrayBuffer | Uint8Array }>(
    "SELECT id, payload_ciphertext FROM mail_outbox WHERE payload_ref = ? AND payload_ciphertext IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    challengeId,
  );
  expect(rows.length, "找不到可解密载荷").toBe(1);
  return decryptOtpPayload(
    (await testKeyring).fieldEncryption(),
    rows[0].id,
    rows[0].payload_ciphertext instanceof Uint8Array
      ? rows[0].payload_ciphertext
      : new Uint8Array(rows[0].payload_ciphertext),
  );
}

async function usageOf(pool: string, periodKey: string): Promise<number> {
  const rows = await query<{ total: number }>(
    "SELECT coalesce(reserved + settled + uncertain, 0) AS total FROM usage_periods WHERE pool = ? AND period_kind = ? AND period_key = ? AND user_id IS NULL",
    pool,
    BUDGET_PERIOD_KIND,
    periodKey,
  );
  return rows[0]?.total ?? 0;
}

/** 直种子认证池占用（floor / 预算用尽用例；当日独立桶，直接插入）。 */
async function seedAuthOccupancy(occupancy: number): Promise<void> {
  const day = utcDayPeriod(clockMs);
  await run(
    "INSERT INTO usage_periods (id, pool, period_kind, period_key, user_id, reserved, settled, uncertain, period_start, period_end, created_at, updated_at) VALUES (?, 'existing_auth', ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?)",
    `up_${crypto.randomUUID()}`,
    BUDGET_PERIOD_KIND,
    day.key,
    occupancy,
    day.startMs,
    day.endMsExclusive,
    clockMs,
    clockMs,
  );
}

async function errorBody(res: Response): Promise<{ code: string }> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error;
}

async function fieldReason(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { details?: { fields?: { reason: string }[] } } };
  return body.error.details?.fields?.[0]?.reason ?? "";
}

/** 从响应 Set-Cookie 中取续期后的 preauth 值。 */
function renewedPreauthValue(res: Response): string {
  const value = parseCookieHeader(res.headers.get("set-cookie") ?? "", PREAUTH_COOKIE_NAME);
  expect(value).toBeDefined();
  return value as string;
}

// —— 用例 ——

describe("A-P2-OTP 申请与幂等", () => {
  it("申请创建挑战与发信任务：MAC 入库、验证码只在受控密文、注册预占与预算盖章", async () => {
    isolateDay();
    const email = freshEmail("create");
    const ctx = await preauthContext();
    const at = clockMs;
    const res = await apply({ email, idempotencyKey: "idem-1", preauthValue: ctx.value });
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toContain(PREAUTH_COOKIE_NAME);

    const emailKey = await emailKeyOf(email);
    const rows = await challengesOf(emailKey, ctx.id);
    expect(rows.length).toBe(1);
    const challenge = rows[0];
    expect(challenge.purpose).toBe("signup");
    expect(challenge.generation).toBe(0);
    expect(challenge.attempts).toBe(0);
    expect(challenge.idempotency_key).toBe("idem-1");
    expect(challenge.deadline).toBe(at + OTP_TTL * SECOND);
    expect(challenge.mac).toMatch(/^[0-9a-f]{64}$/); // 只存 MAC，不存验证码原值

    // 注册预占落在挑战上（§4.2：验证码有效期间保留）。
    expect(challenge.reservation_id).not.toBeNull();
    const reservation = await query<{ state: string }>(
      "SELECT state FROM admission_reservations WHERE id = ?",
      challenge.reservation_id as string,
    );
    expect(reservation[0]?.state).toBe("reserved");

    // 发信任务：pending、预算日已盖章（P1-07）、验证码原值只在密文里。
    const outbox = await outboxOf(challenge.id);
    expect(outbox.length).toBe(1);
    expect(outbox[0].status).toBe("pending");
    expect(outbox[0].purpose).toBe("new_registration");
    expect(outbox[0].period_key).toBe(utcDayPeriod(at).key);
    expect(outbox[0].payload_kind).toBe("otp-mail-payload");
    const payload = await latestPayload(challenge.id);
    expect(payload.code).toMatch(new RegExp(`^\\d{${OTP_DIGITS}}$`));
    expect(payload.challengeId).toBe(challenge.id);
    expect(payload.generation).toBe(0);
    expect(payload.address).toBe(email); // 新地址：按请求投递形态

    // 预算真的占了：new_registration 子额度 +1。
    expect(await usageOf("new_registration", utcDayPeriod(at).key)).toBe(1);
  });

  it("★ 四条路径同形：同时刻配对状态码/正文/Set-Cookie 全一致，跨日正文一致（续期取值路径无关）", async () => {
    // —— 日 1（预算充足）：已注册(发) vs 未注册开放(发)，同一时刻 ——
    isolateDay();
    const registered = freshEmail("fold-reg");
    await seedUser(registered, registered);
    const unregistered = freshEmail("fold-open");
    const ctx = await preauthContext();
    const sendRegistered = await apply({ email: registered, preauthValue: ctx.value });
    const sendUnregistered = await apply({ email: unregistered, preauthValue: ctx.value });
    expect(sendRegistered.status).toBe(202);
    expect(sendUnregistered.status).toBe(202);
    const a = { status: sendRegistered.status, bodyText: await sendRegistered.text() };
    const b = { status: sendUnregistered.status, bodyText: await sendUnregistered.text() };
    assertResponsesFolded(a, b);
    expect(sendRegistered.headers.get("set-cookie")).toBe(
      sendUnregistered.headers.get("set-cookie"),
    );
    // 两条路径都真实创建（发信意图存在）——折叠的不是「什么都不做」。
    expect((await challengesOf(await emailKeyOf(registered))).length).toBe(1);
    expect((await challengesOf(await emailKeyOf(unregistered))).length).toBe(1);

    // —— 日 2（认证池用尽 + 关闭注册）：已注册(不发) vs 未注册关闭(不发)，同一时刻 ——
    isolateDay();
    await seedAuthOccupancy(authDayTotalLimit());
    const budgetOut = freshEmail("fold-budget");
    await seedUser(budgetOut, budgetOut);
    const closed = freshEmail("fold-closed");
    const ctx2 = await preauthContext();
    let noSendRegistered: Response;
    let noSendClosed: Response;
    try {
      await writeRegistrationOpen(env.DB, false, clockMs);
      noSendRegistered = await apply({ email: budgetOut, preauthValue: ctx2.value });
      noSendClosed = await apply({ email: closed, preauthValue: ctx2.value });
    } finally {
      await writeRegistrationOpen(env.DB, true, clockMs);
    }
    expect(noSendRegistered.status).toBe(202);
    expect(noSendClosed.status).toBe(202);
    const c = { status: noSendRegistered.status, bodyText: await noSendRegistered.text() };
    const d = { status: noSendClosed.status, bodyText: await noSendClosed.text() };
    assertResponsesFolded(c, d);
    expect(noSendRegistered.headers.get("set-cookie")).toBe(noSendClosed.headers.get("set-cookie"));
    // 跨日四路径正文/状态一致（Set-Cookie 含时间因素，只做同时刻配对比较）。
    assertResponsesFolded(a, c);
    assertResponsesFolded(a, d);
    // 不发路径零落库（未生成实际发信任务）。
    expect((await challengesOf(await emailKeyOf(budgetOut))).length).toBe(0);
    expect((await challengesOf(await emailKeyOf(closed))).length).toBe(0);
  });

  it("网络重试幂等：同键并发申请只建一个挑战；冷却后同键重放不建新发送意图", async () => {
    isolateDay();
    const email = freshEmail("idem");
    const ctx = await preauthContext();
    const results = await Promise.all([
      apply({ email, idempotencyKey: "retry-1", preauthValue: ctx.value }),
      apply({ email, idempotencyKey: "retry-1", preauthValue: ctx.value }),
    ]);
    // 并发下至多一条 202、另一条可能被冷却挡（429）——响应取决于交错，落库必须唯一。
    expect(results.some((res) => res.status === 202)).toBe(true);
    const emailKey = await emailKeyOf(email);
    const rows = await challengesOf(emailKey, ctx.id);
    expect(rows.length).toBe(1);
    expect((await outboxOf(rows[0].id)).length).toBe(1);

    // 冷却窗口过后同一幂等键重放：不再创建任何行（明确重发才创建新发送意图）。
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    const replay = await apply({ email, idempotencyKey: "retry-1", preauthValue: ctx.value });
    expect(replay.status).toBe(202);
    expect((await challengesOf(emailKey, ctx.id)).length).toBe(1);
    expect((await outboxOf(rows[0].id)).length).toBe(1);
  });

  it("挑战数达到 AUTH_CHALLENGES_PER_EMAIL 后申请被拒（429），不建第 4 条", async () => {
    isolateDay();
    // signup 路径同一邮箱共享一条注册预占（P2-01 防超卖），到不了 3 条；
    // 用已注册邮箱走 login 路径（不占新注册槽）覆盖 PER_EMAIL 语义。
    const email = freshEmail("percap");
    await seedUser(email, email);
    const ctx = await preauthContext();
    const emailKey = await emailKeyOf(email);
    for (let i = 0; i < 3; i++) {
      const res = await apply({ email, idempotencyKey: `cap-${i}`, preauthValue: ctx.value });
      expect(res.status).toBe(202);
      clockMs += (OTP_COOLDOWN + 1) * SECOND; // 错开冷却与当日意图计数
    }
    expect((await challengesOf(emailKey, ctx.id)).length).toBe(3);
    const fourth = await apply({ email, idempotencyKey: "cap-3", preauthValue: ctx.value });
    expect(fourth.status).toBe(429);
    expect((await errorBody(fourth)).code).toBe("rate_limited");
    expect((await challengesOf(emailKey, ctx.id)).length).toBe(3);
  });
});

describe("A-P2-OTP 重发", () => {
  it("★ 重发只旋转本挑战 generation：不重置失败次数、不延长最初截止、不废其他浏览器挑战", async () => {
    isolateDay();
    // 已注册邮箱：login 挑战不受注册预占唯一索引约束，多浏览器可并存多条开放挑战。
    const email = freshEmail("rotate");
    await seedUser(email, email);
    const emailKey = await emailKeyOf(email);
    const tabA = await preauthContext();
    const tabB = await preauthContext();

    expect((await apply({ email, idempotencyKey: "a-1", preauthValue: tabA.value })).status).toBe(
      202,
    );
    const challengeA = (await challengesOf(emailKey, tabA.id))[0];
    const initialDeadline = challengeA.deadline;

    // 两次错误尝试 → attempts = 2。
    await verify({ email, code: "0".repeat(OTP_DIGITS), preauthValue: tabA.value });
    await verify({ email, code: "1".repeat(OTP_DIGITS), preauthValue: tabA.value });
    expect((await challengesOf(emailKey, tabA.id))[0].attempts).toBe(2);

    // 另一个浏览器（上下文 B）对同一邮箱的挑战：互不影响的地板。
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    expect((await apply({ email, idempotencyKey: "b-1", preauthValue: tabB.value })).status).toBe(
      202,
    );
    const challengeB = (await challengesOf(emailKey, tabB.id))[0];
    expect(challengeB.id).not.toBe(challengeA.id);
    const codeB = (await latestPayload(challengeB.id)).code;

    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    expect((await resend({ email, idempotencyKey: "r-1", preauthValue: tabA.value })).status).toBe(
      202,
    );

    const rotatedA = (await challengesOf(emailKey, tabA.id))[0];
    expect(rotatedA.generation).toBe(1); // 只旋转本挑战
    expect(rotatedA.attempts).toBe(2); // ★ 不重置累计失败次数
    expect(rotatedA.deadline).toBe(initialDeadline); // ★ 不延长挑战最初截止
    const untouchedB = (await challengesOf(emailKey, tabB.id))[0];
    expect(untouchedB.generation).toBe(0); // ★ 不废掉其他浏览器的挑战
    expect(untouchedB.mac).toBe(challengeB.mac);
    expect(untouchedB.attempts).toBe(0);

    // 旋转前的旧码失效；A 的新码与 B 的码各自有效。
    const staleA = await verify({ email, code: "0".repeat(OTP_DIGITS), preauthValue: tabA.value });
    expect(staleA.status).toBe(400);
    const newPayloadA = await latestPayload(challengeA.id);
    expect(newPayloadA.generation).toBe(1);
    const goodA = await verify({ email, code: newPayloadA.code, preauthValue: tabA.value });
    expect(goodA.status).toBe(200);
    const goodB = await verify({ email, code: codeB, preauthValue: tabB.value });
    expect(goodB.status).toBe(200);

    // 旧发送任务终止且密文清除；只剩一条 pending。
    const outbox = await outboxOf(challengeA.id);
    expect(outbox.filter((row) => row.status === "pending").length).toBe(1);
    expect(outbox.filter((row) => row.status === "superseded").length).toBe(1);
    expect(outbox.find((row) => row.status === "superseded")?.payload_ciphertext).toBeNull();
  });

  it("并发重发不产生多份有效码：同键只旋转一次；异键并发也只剩一个有效 generation", async () => {
    isolateDay();
    const email = freshEmail("conc");
    const ctx = await preauthContext();
    await apply({ email, idempotencyKey: "c-0", preauthValue: ctx.value });
    const emailKey = await emailKeyOf(email);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    const firstCode = (await latestPayload(challenge.id)).code;

    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    // 同键并发重发 ×3：恰一次旋转、一条 pending。
    const same = await Promise.all(
      ["rs-1", "rs-1", "rs-1"].map((key) =>
        resend({ email, idempotencyKey: key, preauthValue: ctx.value }),
      ),
    );
    for (const res of same) {
      expect(res.status).toBe(202);
    }
    expect((await challengesOf(emailKey, ctx.id))[0].generation).toBe(1);
    expect((await outboxOf(challenge.id)).filter((row) => row.status === "pending").length).toBe(1);

    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    // 异键并发重发 ×3：CAS 输家不追加旋转——任意时刻至多一个有效码。
    const distinct = await Promise.all(
      ["rd-1", "rd-2", "rd-3"].map((key) =>
        resend({ email, idempotencyKey: key, preauthValue: ctx.value }),
      ),
    );
    for (const res of distinct) {
      expect(res.status).toBe(202);
    }
    expect((await challengesOf(emailKey, ctx.id))[0].generation).toBe(2);
    expect((await outboxOf(challenge.id)).filter((row) => row.status === "pending").length).toBe(1);

    // 历史码全部失效，唯一有效码 = 最新 pending 行的码。
    const stale = await verify({ email, code: firstCode, preauthValue: ctx.value });
    expect(stale.status).toBe(400);
    const finalCode = (await latestPayload(challenge.id)).code;
    const good = await verify({ email, code: finalCode, preauthValue: ctx.value });
    expect(good.status).toBe(200);
  });

  it("认证池 floor 降级：重发暂停（429）、既有账号首次登录仍放行、新注册发信暂停零落库", async () => {
    isolateDay();
    const login = freshEmail("floor-login");
    await seedUser(login, login);
    const signup = freshEmail("floor-signup");
    // 认证池剩余恰好等于 MAIL_AUTH_FLOOR → 降级生效（等号属触发侧，A-P1-BUDGET 口径）。
    await seedAuthOccupancy(authDayTotalLimit() - MAIL_AUTH_FLOOR);

    const ctx = await preauthContext();
    // 首次登录放行（§7.2：认证降级期间唯一放行的认证意图）。
    expect(
      (await apply({ email: login, idempotencyKey: "f-1", preauthValue: ctx.value })).status,
    ).toBe(202);
    const emailKey = await emailKeyOf(login);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    expect(challenge.purpose).toBe("login");

    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    // 重发被暂停（§7.2：降级期间全部重发暂停）。
    const blocked = await resend({ email: login, idempotencyKey: "f-r1", preauthValue: ctx.value });
    expect(blocked.status).toBe(429);
    expect((await challengesOf(emailKey, ctx.id))[0].generation).toBe(0);

    // 新注册发信同样暂停：响应折叠 202，但零落库。
    const folded = await apply({ email: signup, idempotencyKey: "f-2", preauthValue: ctx.value });
    expect(folded.status).toBe(202);
    expect((await challengesOf(await emailKeyOf(signup))).length).toBe(0);

    // 账本只记了首次登录那一次（floor 下注册/重发都不产生新占用）。
    expect(await usageOf("existing_auth", utcDayPeriod(clockMs).key)).toBe(
      authDayTotalLimit() - MAIL_AUTH_FLOOR + 1,
    );
  });

  it("重发冷却与当日合计：OTP_COOLDOWN 内拒绝并给出 retry_after；发送数达 EMAIL_AUTH_INTENTS_DAY 拒绝", async () => {
    isolateDay();
    const email = freshEmail("cooldown");
    const ctx = await preauthContext();
    await apply({ email, idempotencyKey: "cd-0", preauthValue: ctx.value });

    const tooSoon = await resend({ email, idempotencyKey: "cd-r0", preauthValue: ctx.value });
    expect(tooSoon.status).toBe(429);
    const detail = (await tooSoon.json()) as {
      error: { details?: { retry_after_ms?: number } };
    };
    expect(detail.error.details?.retry_after_ms).toBeGreaterThan(0);

    // 1 次申请 + 4 次重发 = 5 次发送；第 6 次被当日合计拒绝（A.2：登录、重发及重新验证合计）。
    for (let i = 1; i <= 4; i++) {
      clockMs += (OTP_COOLDOWN + 1) * SECOND;
      const res = await resend({ email, idempotencyKey: `cd-r${i}`, preauthValue: ctx.value });
      expect(res.status).toBe(202);
    }
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    const capped = await resend({ email, idempotencyKey: "cd-r5", preauthValue: ctx.value });
    expect(capped.status).toBe(429);
    expect((await errorBody(capped)).code).toBe("rate_limited");
  });

  it("★ 重发地址解析失败关闭：login 载荷已清且 users 行缺失 → 503，零新发送意图（绝不按请求地址改投）", async () => {
    isolateDay();
    const localPart = `CaseHold-${crypto.randomUUID().slice(0, 8)}`;
    const canonical = `${localPart.toLowerCase()}@example.test`;
    const stored = `${localPart}@example.test`;
    const seeded = await seedUser(canonical, stored);
    const ctx = await preauthContext();
    await apply({ email: canonical, idempotencyKey: "fc-0", preauthValue: ctx.value });
    const emailKey = seeded.emailKey;
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    expect(challenge.purpose).toBe("login");
    const dayKey = utcDayPeriod(clockMs).key;
    expect(await usageOf("existing_auth", dayKey)).toBe(1);

    // 模拟「载荷已被清除」（如 P4 发送后清除）+ 账号已删除（users 行缺失；
    // 外键引用一并解除，与账号清理后的持久状态同形）。
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    await run(
      "UPDATE mail_outbox SET recipient_user_id = NULL, payload_ciphertext = NULL WHERE payload_ref = ?",
      challenge.id,
    );
    await run("DELETE FROM users WHERE id = ?", seeded.id);

    // 用不同大小写的请求地址重发：必须失败关闭（503），与创建路径判同一种结果。
    const requestForm = `${localPart.replace("CaseHold", "CASEHOLD")}@Example.Test`;
    const blocked = await resend({
      email: requestForm,
      idempotencyKey: "fc-r1",
      preauthValue: ctx.value,
    });
    expect(blocked.status).toBe(503);
    expect((await errorBody(blocked)).code).toBe("temporarily_unavailable");

    // ★ 断言没有任何发送意图以请求原文地址创建：挑战未旋转、无新 outbox 行、
    // 既无密文可解；预算也未被占用（失败关闭点在预占之前）。
    const after = (await challengesOf(emailKey, ctx.id))[0];
    expect(after.generation).toBe(0);
    expect(after.mac).toBe(challenge.mac);
    const outbox = await outboxOf(challenge.id);
    expect(outbox.length).toBe(1); // 只有初始行
    expect(outbox[0].payload_ciphertext).toBeNull(); // 无任何可解密载荷
    expect(await usageOf("existing_auth", dayKey)).toBe(1); // 失败不占预算
  });

  it("signup 挑战历史载荷清除后重发：仍以请求原文投递形态创建发送意图（首次绑定，不是改投）", async () => {
    isolateDay();
    const localPart = `Signup.Case-${crypto.randomUUID().slice(0, 8)}`;
    const email = `${localPart}@example.test`; // signup：请求原文即投递形态（本地部分保留大小写）
    const ctx = await preauthContext();
    await apply({ email, idempotencyKey: "sf-0", preauthValue: ctx.value });
    const emailKey = await emailKeyOf(email.toLowerCase());
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    expect(challenge.purpose).toBe("signup");

    // 历史载荷全部清除 → 兜底取请求投递形态。
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    await run(
      "UPDATE mail_outbox SET payload_ciphertext = NULL WHERE payload_ref = ?",
      challenge.id,
    );
    const resent = await resend({ email, idempotencyKey: "sf-r1", preauthValue: ctx.value });
    expect(resent.status).toBe(202);
    const after = (await challengesOf(emailKey, ctx.id))[0];
    expect(after.generation).toBe(1);
    const payload = await latestPayload(challenge.id);
    expect(payload.generation).toBe(1);
    expect(payload.address).toBe(email); // 请求投递形态（本地部分大小写保留）
    expect((await outboxOf(challenge.id)).filter((row) => row.status === "pending").length).toBe(1);
  });
});

describe("A-P2-OTP 校验", () => {
  it("★ 错误尝试持久扣减：错误响应返回后 attempts 已落库；耗尽后正确码也拒绝且不误报码错", async () => {
    isolateDay();
    const email = freshEmail("attempts");
    const ctx = await preauthContext();
    await apply({ email, idempotencyKey: "at-0", preauthValue: ctx.value });
    const emailKey = await emailKeyOf(email);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    const correct = (await latestPayload(challenge.id)).code;

    for (let i = 1; i <= OTP_ATTEMPTS; i++) {
      const wrong = await verify({ email, code: "9".repeat(OTP_DIGITS), preauthValue: ctx.value });
      expect(wrong.status).toBe(400);
      expect(await fieldReason(wrong)).toBe("mismatch");
      // ★ 持久扣减：错误响应已返回，自增必须已提交（无任何回滚可抵消）。
      expect((await challengesOf(emailKey, ctx.id))[0].attempts).toBe(i);
    }

    const exhausted = await verify({ email, code: correct, preauthValue: ctx.value });
    expect(exhausted.status).toBe(400);
    expect(await fieldReason(exhausted)).toBe("attempts_exhausted"); // ≠ mismatch
    expect((await challengesOf(emailKey, ctx.id))[0].attempts).toBe(OTP_ATTEMPTS);

    // 形状非法：结构问题不烧次数。
    const malformed = await verify({ email, code: "abc", preauthValue: ctx.value });
    expect(malformed.status).toBe(400);
    expect((await challengesOf(emailKey, ctx.id))[0].attempts).toBe(OTP_ATTEMPTS);
  });

  it("★ Cookie 临近到期不影响新验证码；Cookie 丢失 / 无开放挑战不误报为验证码错误", async () => {
    isolateDay();
    const email = freshEmail("cookie");
    const issuedAt = clockMs;
    const ctx = await preauthContext(issuedAt);
    // 剩余 ≈ OTP_TTL + 5s 时申请（临近到期）。
    clockMs += (PREAUTH_MIN_TTL - OTP_TTL - 5) * SECOND;
    const applied = await apply({ email, idempotencyKey: "ck-1", preauthValue: ctx.value });
    expect(applied.status).toBe(202);

    const emailKey = await emailKeyOf(email);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    expect(challenge).toBeDefined();
    const code = (await latestPayload(challenge.id)).code;

    // 202 附带同值续期：同 preauth_id、同 issuedAt，截止覆盖挑战截止 + 完成余量。
    const renewedFromApply = renewedPreauthValue(applied).split(".");
    expect(renewedFromApply[0]).toBe(ctx.id);
    expect(Number(renewedFromApply[1])).toBe(issuedAt);
    expect(Number(renewedFromApply[2])).toBeGreaterThanOrEqual(
      challenge.deadline + (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND,
    );

    const nearExpiry = await verify({ email, code, preauthValue: ctx.value });
    expect(nearExpiry.status).toBe(200); // ★ 临近到期不影响校验新验证码
    const renewedValue = renewedPreauthValue(nearExpiry).split(".");
    expect(renewedValue[0]).toBe(ctx.id); // 同一个随机值（§4.3 多标签页条款）
    expect(Number(renewedValue[1])).toBe(issuedAt);
    expect(Number(renewedValue[2])).toBeGreaterThanOrEqual(
      challenge.deadline + (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND,
    );

    // preauth Cookie 丢失（CSRF 仍在）：401 unauthorized，不是验证码错误。
    const lost = await verify({ email, code, csrfOnly: true });
    expect(lost.status).toBe(401);
    expect((await errorBody(lost)).code).toBe("unauthorized");
    const noCookies = await verify({ email, code, noCookies: true });
    expect(noCookies.status).toBe(401);

    // 上下文有效但该邮箱在此上下文无挑战（用户换了浏览器）：no_open_challenge ≠ mismatch。
    const otherTab = await preauthContext();
    const fresh = await verify({ email, code, preauthValue: otherTab.value });
    expect(fresh.status).toBe(400);
    expect(await fieldReason(fresh)).toBe("no_open_challenge");

    // 挑战过期后：同样是 no_open_challenge（不是码错）。
    clockMs += (OTP_TTL + 1) * SECOND;
    const expired = await verify({ email, code, preauthValue: ctx.value });
    expect(expired.status).toBe(400);
    expect(await fieldReason(expired)).toBe("no_open_challenge");
  });

  it("★ PREAUTH_MIN_TTL 下限本身满足 A.5 不等式；续期覆盖最晚挑战截止 + 完成余量", async () => {
    // 安全属性是**不等式**（CONTRACTS_BASELINE §8，P2-02 验收裁定）：安全性不挂在
    // 当前参数恰好取等（1320 = 600+600+120）的巧合上，调参只需保持不等式成立。
    expect(PREAUTH_MIN_TTL).toBeGreaterThanOrEqual(OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN);

    isolateDay();
    const email = freshEmail("ttl");
    const ctx = await preauthContext();
    const at = clockMs;
    const res = await apply({ email, idempotencyKey: "ttl-1", preauthValue: ctx.value });
    const parts = renewedPreauthValue(res).split(".");
    const emailKey = await emailKeyOf(email);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    expect(Number(parts[2])).toBe(at + PREAUTH_MIN_TTL * SECOND);
    expect(Number(parts[2])).toBeGreaterThanOrEqual(
      challenge.deadline + (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND,
    );

    // 更晚结束的存量挑战（A.5 第二式）：续期覆盖「最晚截止 + 完成余量」。
    const lateDeadline = at + 5_000 * SECOND;
    await run(
      "INSERT INTO auth_challenges (id, purpose, email_key, address_version, preauth_id, mac, deadline, created_at, updated_at) VALUES (?, 'login', ?, 1, ?, 'seed', ?, ?, ?)",
      `ch_late_${crypto.randomUUID().slice(0, 8)}`,
      emailKey,
      ctx.id,
      lateDeadline,
      at,
      at,
    );
    clockMs += (OTP_COOLDOWN + 1) * SECOND;
    const later = await apply({ email, idempotencyKey: "ttl-2", preauthValue: ctx.value });
    expect(later.status).toBe(202);
    expect(Number(renewedPreauthValue(later).split(".")[2])).toBe(
      lateDeadline + (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND,
    );
  });

  it("邮箱级防猜测边界 EMAIL_VERIFY_ATTEMPTS_HOUR：小时窗口内合计达上限即 429", async () => {
    isolateDay();
    const email = freshEmail("hour");
    const emailKey = await emailKeyOf(email);
    // 直接种子 4 条挑战 × OTP_ATTEMPTS 次错误 = 20 次已持久化的错误尝试。
    for (let i = 0; i < 4; i++) {
      await run(
        "INSERT INTO auth_challenges (id, purpose, email_key, address_version, preauth_id, mac, generation, attempts, deadline, created_at, updated_at) VALUES (?, 'login', ?, 1, 'seed', 'seed', 0, ?, ?, ?, ?)",
        `ch_h_${i}_${crypto.randomUUID().slice(0, 6)}`,
        emailKey,
        OTP_ATTEMPTS,
        clockMs + OTP_TTL * SECOND,
        clockMs,
        clockMs,
      );
    }
    const ctx = await preauthContext();
    const res = await verify({ email, code: "1".repeat(OTP_DIGITS), preauthValue: ctx.value });
    expect(res.status).toBe(429);
    expect((await errorBody(res)).code).toBe("rate_limited");
    // 种子行的 attempts 不因被拒而继续增长。
    const total = await query<{ t: number }>(
      "SELECT sum(attempts) AS t FROM auth_challenges WHERE email_key = ?",
      emailKey,
    );
    expect(total[0]?.t).toBe(4 * OTP_ATTEMPTS);
  });

  it("大小写不同的登录请求 → 同一账号，且投递地址不被改写（§4.1）", async () => {
    isolateDay();
    const localPart = `Mixed.Local-${crypto.randomUUID().slice(0, 8)}`;
    const canonical = `${localPart.toLowerCase()}@example.test`;
    const stored = `${localPart}@example.test`; // 注册时验证过的实际投递地址（保留大小写）
    const seeded = await seedUser(canonical, stored);
    const ctx = await preauthContext();
    const requestForm = `${localPart.replace("Mixed", "MIXED")}@Example.Test`;

    const res = await apply({
      email: requestForm,
      idempotencyKey: "mc-1",
      preauthValue: ctx.value,
    });
    expect(res.status).toBe(202);

    const emailKey = await emailKeyOf(canonical);
    const rows = await challengesOf(emailKey, ctx.id);
    expect(rows.length).toBe(1);
    expect(rows[0].email_key).toBe(seeded.emailKey); // 同一账号（身份键折叠大小写）
    expect(rows[0].purpose).toBe("login");
    expect(rows[0].address_version).toBe(1); // 来自 users 行（§4.1 消费时核对地址版本）

    // ★ 投递地址 = 数据库已验证地址，不按请求中的大小写改投。
    const payload = await latestPayload(rows[0].id);
    expect(payload.address).toBe(stored);
    expect(payload.address).not.toBe(requestForm);

    // 该码可验证。
    const good = await verify({ email: requestForm, code: payload.code, preauthValue: ctx.value });
    expect(good.status).toBe(200);
  });
});

describe("A-P2-OTP 密码学与清除", () => {
  it("MAC 绑定六元组：任一字段变化则 MAC 不同；同绑定重算稳定", async () => {
    const key = (await testKeyring).otpMac();
    const base = {
      purpose: "login",
      challengeId: "ch-fixed",
      emailKey: "ek-fixed",
      addressVersion: 1,
      generation: 0,
      code: "12345678",
    };
    const mac = await macOtpVerification(key, base);
    const variants = [
      { ...base, purpose: "signup" },
      { ...base, challengeId: "ch-other" },
      { ...base, emailKey: "ek-other" },
      { ...base, addressVersion: 2 },
      { ...base, generation: 1 },
      { ...base, code: "87654321" },
    ];
    for (const variant of variants) {
      expect(await macOtpVerification(key, variant)).not.toBe(mac);
    }
    expect(await macOtpVerification(key, base)).toBe(mac);
  });

  it("过期清除：密文清空、状态 expired、预留归还；重复执行幂等", async () => {
    isolateDay();
    const email = freshEmail("purge");
    const ctx = await preauthContext();
    const at = clockMs;
    await apply({ email, idempotencyKey: "pg-1", preauthValue: ctx.value });
    const emailKey = await emailKeyOf(email);
    const challenge = (await challengesOf(emailKey, ctx.id))[0];
    const dayKey = utcDayPeriod(at).key;
    expect(await usageOf("new_registration", dayKey)).toBe(1);

    clockMs = at + (OTP_TTL + 1) * SECOND; // 越过挑战截止（同日）
    // 原语清全库过期行（清理任务语义）：本挑战的行必在其中。
    const first = await clearExpiredOtpPayloads(env.DB, clockMs);
    expect(first.cleared).toBeGreaterThanOrEqual(1);
    expect(first.budgetReleased).toBeGreaterThanOrEqual(1);
    const rows = await outboxOf(challenge.id);
    expect(rows[0].status).toBe("expired");
    expect(rows[0].payload_ciphertext).toBeNull();
    expect(await usageOf("new_registration", dayKey)).toBe(0);

    const again = await clearExpiredOtpPayloads(env.DB, clockMs);
    expect(again.cleared).toBe(0);
    expect(again.budgetReleased).toBe(0);
  });

  it("三端点路由挂载冒烟（makeChallengeRoutes，真实时钟）", async () => {
    const email = freshEmail("route");
    await seedUser(email, email);
    const keys = await testKeyring;
    const routesShell = createApiShell({
      authenticator: {
        async authenticate() {
          return { kind: "none" } as const;
        },
      },
      csrfKey: async () => keys.csrf(),
      routes: makeChallengeRoutes({
        keys: async () => keys,
        rateGate: allowAllGate(),
        turnstile: () => passTurnstile,
      }),
    });
    const minted = await mintPreauthCookieValue(keys.preauthCookie(), Date.now());
    const csrf = await mintCsrfToken(keys.csrf(), minted.context.preauthId, randomBytes(32));
    const headers = new Headers({
      "content-type": "application/json",
      origin: "https://app.test",
      cookie: `${PREAUTH_COOKIE_NAME}=${minted.value}; __Host-hoyo_csrf=${csrf}`,
      "x-csrf-token": csrf,
    });
    const applied = await routesShell.fetch(
      new Request("https://app.test/api/v2/auth/challenges", {
        method: "POST",
        headers,
        body: JSON.stringify({ email, turnstile_token: "tok-ok", idempotency_key: "rt-1" }),
      }),
      env,
      fakeCtx,
    );
    expect(applied.status).toBe(202);

    const emailKey = await emailKeyOf(email);
    const challenge = (
      await query<ChallengeDbRow>(
        "SELECT * FROM auth_challenges WHERE email_key = ? AND preauth_id = ?",
        emailKey,
        minted.context.preauthId,
      )
    )[0];
    expect(challenge).toBeDefined();
    const code = (await latestPayload(challenge.id)).code;
    const verified = await routesShell.fetch(
      new Request("https://app.test/api/v2/auth/challenges/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ email, code }),
      }),
      env,
      fakeCtx,
    );
    expect(verified.status).toBe(200);
  });
});
