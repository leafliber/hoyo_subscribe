// A-P2-CONSUME · P2-03 原子消费、账号建立与短期回执（真实 Miniflare D1）。
// 2026-09-27 裁定七条逐项测试；并发用 Promise.all + CAS 前屏障确保双方读完再争写。

import { env } from "cloudflare:test";
import {
  AUTH_COMPLETION_TTL,
  canonicalizeEmail,
  OTP_COOLDOWN,
  OTP_TTL,
  PREAUTH_MIN_TTL,
  SESSION_ABSOLUTE_JITTER,
  SESSION_ABSOLUTE_TTL,
  SUBSCRIPTION_INIT_STATE,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { reserveRegistrationSlot } from "../../accounts/admission/registration";
import { allocateUserOrder } from "../../accounts/users/order";
import { createApiShell, mintCsrfToken } from "../../shell";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { conditionalCommit } from "../../storage/cas";
import { encryptField } from "../../storage/crypto/aead";
import { computeEmailKey } from "../../storage/crypto/mac";
import { splitSqlStatements } from "../../storage/split-sql";
import { createChallengeAndMailTask } from "../challenges/create-challenge";
import { decryptDeliveryAddress } from "../challenges/delivery";
import { decryptOtpPayload } from "../challenges/payload";
import { runResendOtp } from "../challenges/resend";
import { runVerifyOtp } from "../challenges/verify";
import { mintPreauthCookieValue, type PreauthContext } from "../preauth/cookie";
import { activatedReceiptClearEffect, clearExpiredAuthMaterials } from "./cleanup";
import { runCompleteAuth } from "./complete";
import { consumeVerifiedOtp, type VerifiedChallenge } from "./consume";
import { makeCompleteRoute } from "./routes";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
expect(Object.keys(migrations).length).toBeGreaterThan(0);
const SECOND = 1_000;
let now = utcDayPeriod(1_900_000_000_000).startMs + SECOND;
const clock = () => now;

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return (await stmt.all<T>()).results ?? [];
}

async function run(sql: string, ...params: unknown[]): Promise<void> {
  await env.DB.prepare(sql)
    .bind(...params)
    .run();
}

async function resetDatabase(): Promise<void> {
  const objects = await query<{ type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'",
  );
  for (const item of objects) {
    await env.DB.exec(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}";`);
  }
  for (let round = 0; round < 20; round++) {
    const tables = await query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'",
    );
    if (tables.length === 0) break;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        // 外键依赖在下一轮解除。
      }
    }
  }
  expect(
    await query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'",
    ),
  ).toEqual([]);
}

beforeAll(async () => {
  await resetDatabase();
  for (const name of Object.keys(migrations).sort()) {
    await env.DB.batch(
      splitSqlStatements(migrations[name] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  }
}, 180_000);

function nextDay(): void {
  now = utcDayPeriod(now).endMsExclusive + SECOND;
}

async function context(): Promise<{ value: string; context: PreauthContext }> {
  return mintPreauthCookieValue((await testKeyring).preauthCookie(), now);
}

interface Challenge {
  id: string;
  purpose: "signup" | "login";
  email_key: string;
  address_version: number;
  generation: number;
  mac: string;
  consumed_at: number | null;
  delivery_address_ciphertext: ArrayBuffer | Uint8Array | null;
  receipt_ciphertext: ArrayBuffer | Uint8Array | null;
  pending_session_id: string | null;
}

async function createChallenge(
  email: string,
  preauth: PreauthContext,
): Promise<{ row: Challenge; code: string }> {
  const keys = await testKeyring;
  const canonical = canonicalizeEmail(email);
  if (!canonical.ok) throw new Error("invalid test email");
  const emailKey = await computeEmailKey(keys.emailLookup(), canonical.canonical);
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE email_key = ?",
    emailKey,
  );
  const purpose = existing.length ? "login" : "signup";
  const reservationId = purpose === "signup" ? crypto.randomUUID() : null;
  if (reservationId !== null) {
    expect(
      await reserveRegistrationSlot(env.DB, {
        reservationId,
        emailKey,
        now,
        challengeDeadline: now + OTP_TTL * SECOND,
        attempt: true,
      }),
    ).toBe("reserved");
  }
  await createChallengeAndMailTask({
    db: env.DB,
    keys,
    intent: purpose === "signup" ? "signup_auth" : "existing_auth_first_login",
    canonicalEmail: canonical.canonical,
    rawEmail: email,
    emailKey,
    preauthId: preauth.preauthId,
    idempotencyKey: crypto.randomUUID(),
    reservationId,
    challengeDeadline: now + OTP_TTL * SECOND,
    now,
  });
  const row = (
    await query<Challenge>(
      "SELECT * FROM auth_challenges WHERE preauth_id = ? AND email_key = ? ORDER BY created_at DESC LIMIT 1",
      preauth.preauthId,
      emailKey,
    )
  )[0];
  expect(row).toBeDefined();
  const payloadRow = (
    await query<{ id: string; payload_ciphertext: ArrayBuffer | Uint8Array }>(
      "SELECT id, payload_ciphertext FROM mail_outbox WHERE payload_ref = ? ORDER BY created_at DESC LIMIT 1",
      row.id,
    )
  )[0];
  const payload = await decryptOtpPayload(
    keys.fieldEncryption(),
    payloadRow.id,
    new Uint8Array(payloadRow.payload_ciphertext),
  );
  return { row, code: payload.code };
}

async function seedUser(email: string, deliveryAddress = email): Promise<string> {
  const keys = await testKeyring;
  const canonical = canonicalizeEmail(email);
  if (!canonical.ok) throw new Error("invalid test email");
  const emailKey = await computeEmailKey(keys.emailLookup(), canonical.canonical);
  const id = crypto.randomUUID();
  const order = await allocateUserOrder(env.DB, now);
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id },
    deliveryAddress,
  );
  await run(
    'INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
    id,
    order,
    "active",
    emailKey,
    crypto.randomUUID(),
    ciphertext,
    now,
    now,
  );
  return id;
}

function request(value: string, operationKey: string, email?: string, code?: string): Request {
  return new Request("https://app.test/api/v2/auth/challenges/verify", {
    method: "POST",
    headers: {
      cookie: `__Host-preauth=${value}`,
      "idempotency-key": operationKey,
      origin: "https://app.test",
    },
    body: JSON.stringify({ email, code }),
  });
}

async function verify(
  email: string,
  code: string,
  preauthValue: string,
  operationKey: string,
): Promise<Response> {
  return runVerifyOtp(
    { db: env.DB, keys: await testKeyring, now: clock },
    { request: request(preauthValue, operationKey, email, code), email, code },
  );
}

async function complete(preauthValue: string, operationKey: string): Promise<Response> {
  return runCompleteAuth(
    { db: env.DB, keys: await testKeyring, now: clock },
    request(preauthValue, operationKey),
  );
}

function sessionCookie(response: Response): string | null {
  return response.headers.get("set-cookie")?.match(/__Host-session=([^;]+)/)?.[1] ?? null;
}

function verified(row: Challenge): VerifiedChallenge {
  return {
    id: row.id,
    purpose: row.purpose,
    addressVersion: row.address_version,
    generation: row.generation,
    mac: row.mac,
  };
}

describe("A-P2-CONSUME 原子消费与回执", () => {
  it("A-P2-CONSUME 挑战投递串独立落库：Foo 申请、foo 校验仍保存 Foo；列缺失则消费失败关闭", async () => {
    nextDay();
    const email = `Foo-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const ctx = await context();
    const { row, code } = await createChallenge(email, ctx.context);
    expect(row.delivery_address_ciphertext).not.toBeNull();
    const result = await verify(email.toLowerCase(), code, ctx.value, "address-case");
    expect(result.status).toBe(200);
    const user = (
      await query<{ id: string; email_ciphertext: ArrayBuffer | Uint8Array }>(
        "SELECT id, email_ciphertext FROM users WHERE email_key = ?",
        row.email_key,
      )
    )[0];
    expect(
      await decryptDeliveryAddress(
        (await testKeyring).fieldEncryption(),
        user.id,
        new Uint8Array(user.email_ciphertext),
      ),
    ).toBe(email);
    const sub = (
      await query<{
        state: string;
        scope_json: string | null;
        calendar_json: string | null;
        notifications_json: string | null;
      }>(
        "SELECT state, scope_json, calendar_json, notifications_json FROM user_subscriptions WHERE user_id = ?",
        user.id,
      )
    )[0];
    expect(sub).toEqual({
      state: SUBSCRIPTION_INIT_STATE,
      scope_json: null,
      calendar_json: null,
      notifications_json: null,
    });
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id))[0]
        .delivery_address_ciphertext,
    ).toBeNull();

    const missingEmail = `Missing-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const missingCtx = await context();
    const missing = await createChallenge(missingEmail, missingCtx.context);
    await run(
      "UPDATE auth_challenges SET delivery_address_ciphertext = NULL WHERE id = ?",
      missing.row.id,
    );
    await expect(
      verify(missingEmail, missing.code, missingCtx.value, "missing-address"),
    ).rejects.toThrow();
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", missing.row.id))[0]
        .consumed_at,
    ).toBeNull();
  });

  it("A-P2-CONSUME 建号密文 AAD 使用 users.id，P2-02 login 申请能解出同一实际地址", async () => {
    nextDay();
    const email = `Mixed-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const ctx = await context();
    const signup = await createChallenge(email, ctx.context);
    expect((await verify(email.toLowerCase(), signup.code, ctx.value, "signup-aad")).status).toBe(
      200,
    );
    const other = await context();
    const login = await createChallenge(email.toLowerCase(), other.context);
    const address = await decryptDeliveryAddress(
      (await testKeyring).fieldEncryption(),
      login.row.id,
      new Uint8Array(login.row.delivery_address_ciphertext as ArrayBuffer),
    );
    expect(address).toBe(email);
  });

  it("A-P2-CONSUME 真实并发消费 CAS 最多一次成功；无会话已建但挑战仍可用", async () => {
    nextDay();
    const email = `parallel-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const userId = await seedUser(email);
    const ctx = await context();
    const { row } = await createChallenge(email, ctx.context);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeCommit = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    const keys = await testKeyring;
    const results = await Promise.all(
      ["parallel-a", "parallel-b"].map((operationKey) =>
        consumeVerifiedOtp(
          { db: env.DB, keys, beforeCommit },
          {
            verified: verified(row),
            preauth: ctx.context,
            emailKey: row.email_key,
            operationKey,
            now,
          },
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "condition_missed")).toHaveLength(1);
    expect(
      (
        await query<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)
      )[0].n,
    ).toBe(1);
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id))[0].consumed_at,
    ).not.toBeNull();
  });

  it("A-P2-CONSUME 两个不同邮箱并发注册得到不同 users.order，日完成计数与转换均一致", async () => {
    nextDay();
    const a = await context();
    const b = await context();
    const first = await createChallenge(
      `order-a-${crypto.randomUUID().slice(0, 6)}@x.test`,
      a.context,
    );
    const second = await createChallenge(
      `order-b-${crypto.randomUUID().slice(0, 6)}@x.test`,
      b.context,
    );
    const addresses = await Promise.all(
      [first, second].map(async ({ row }) =>
        decryptDeliveryAddress(
          (await testKeyring).fieldEncryption(),
          row.id,
          new Uint8Array(row.delivery_address_ciphertext as ArrayBuffer),
        ),
      ),
    );
    const success = await Promise.all([
      verify(addresses[0], first.code, a.value, "order-a"),
      verify(addresses[1], second.code, b.value, "order-b"),
    ]);
    expect(success.map((r) => r.status)).toEqual([200, 200]);
    const users = await query<{ order: number }>(
      'SELECT "order" FROM users WHERE email_key IN (?, ?) ORDER BY "order"',
      first.row.email_key,
      second.row.email_key,
    );
    expect(users).toHaveLength(2);
    expect(users[0].order).not.toBe(users[1].order);
    const day = (
      await query<{ value: number }>(
        "SELECT value FROM capacity_state WHERE key = ?",
        `registrations:${utcDayPeriod(now).key}`,
      )
    )[0];
    expect(day.value).toBe(2);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*) AS n FROM admission_reservations WHERE state = 'converted' AND email_key IN (?, ?)",
          first.row.email_key,
          second.row.email_key,
        )
      )[0].n,
    ).toBe(2);
  });

  it("A-P2-CONSUME pending 绝对期限创建时落在注册表 ± 抖动内且不可改写", async () => {
    nextDay();
    const email = `jitter-${crypto.randomUUID().slice(0, 8)}@x.test`;
    await seedUser(email);
    const ctx = await context();
    const { code } = await createChallenge(email, ctx.context);
    const response = await verify(email, code, ctx.value, "jitter");
    expect(response.status).toBe(200);
    const session = (
      await query<{ id: string; issued_at: number; absolute_expires_at: number; state: string }>(
        "SELECT id, issued_at, absolute_expires_at, state FROM sessions ORDER BY created_at DESC LIMIT 1",
      )
    )[0];
    const difference = session.absolute_expires_at - session.issued_at;
    expect(difference).toBeGreaterThanOrEqual(
      (SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER) * SECOND,
    );
    expect(difference).toBeLessThanOrEqual(
      (SESSION_ABSOLUTE_TTL + SESSION_ABSOLUTE_JITTER) * SECOND,
    );
    expect(session.state).toBe("pending");
    await expect(
      run(
        "UPDATE sessions SET absolute_expires_at = absolute_expires_at + 1 WHERE id = ?",
        session.id,
      ),
    ).rejects.toThrow();
  });

  it("A-P2-CONSUME signup 期间规范键被另一个实际地址建立时要求重新 login，不转为该账号", async () => {
    nextDay();
    const email = `Conflict-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const ctx = await context();
    const { row, code } = await createChallenge(email, ctx.context);
    const otherUser = await seedUser(email.toLowerCase(), email.toLowerCase());
    await expect(verify(email, code, ctx.value, "conflict")).rejects.toMatchObject({
      code: "validation",
      details: { fields: [{ path: "email", reason: "login_required" }] },
    });
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id))[0].consumed_at,
    ).toBeNull();
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*) AS n FROM sessions WHERE user_id = ?",
          otherUser,
        )
      )[0].n,
    ).toBe(0);
  });

  it("A-P2-CONSUME 完成回执需原 preauth+操作键+pending；激活与到期均拒绝并清密文", async () => {
    nextDay();
    const email = `receipt-${crypto.randomUUID().slice(0, 8)}@x.test`;
    await seedUser(email);
    const ctx = await context();
    const { row, code } = await createChallenge(email, ctx.context);
    const issued = await verify(email, code, ctx.value, "receipt-one");
    expect(issued.status).toBe(200);
    const recovered = await complete(ctx.value, "receipt-one");
    expect(recovered.status).toBe(200);
    expect(sessionCookie(recovered)).toBe(sessionCookie(issued));
    const tokenRow = (
      await query<{ token_hash: string }>(
        "SELECT token_hash FROM sessions WHERE id = (SELECT pending_session_id FROM auth_challenges WHERE id = ?)",
        row.id,
      )
    )[0];
    expect(tokenRow.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenRow.token_hash).not.toBe(sessionCookie(issued));
    await expect(complete(ctx.value, row.id)).rejects.toMatchObject({ code: "unauthorized" });
    const other = await context();
    await expect(complete(other.value, "receipt-one")).rejects.toMatchObject({
      code: "unauthorized",
    });
    const stored = (
      await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id)
    )[0];
    expect(stored.receipt_ciphertext).not.toBeNull();
    const activation = await conditionalCommit(env.DB, {
      guard: {
        sql: `UPDATE sessions SET state = 'active', activated_at = ?, updated_at = ?
               WHERE id = ? AND state = 'pending' AND expires_at > ?
                 AND EXISTS (SELECT 1 FROM auth_challenges c
                             WHERE c.pending_session_id = sessions.id
                               AND c.receipt_ciphertext IS NOT NULL AND c.receipt_expires_at > ?)`,
        params: [now, now, stored.pending_session_id, now, now],
      },
      effects: [activatedReceiptClearEffect(stored.pending_session_id as string, now)],
    });
    expect(activation.outcome).toBe("committed");
    await expect(complete(ctx.value, "receipt-one")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id))[0]
        .receipt_ciphertext,
    ).toBeNull();

    const ctx2 = await context();
    const second = await createChallenge(email, ctx2.context);
    expect((await verify(email, second.code, ctx2.value, "receipt-expire")).status).toBe(200);
    now += AUTH_COMPLETION_TTL * SECOND + 1;
    await expect(complete(ctx2.value, "receipt-expire")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await clearExpiredAuthMaterials(env.DB, now);
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", second.row.id))[0]
        .receipt_ciphertext,
    ).toBeNull();
  });

  it("A-P2-CONSUME /api/v2/auth/complete 经同源 CSRF 外壳领取，不接受 challenge_id 请求体", async () => {
    nextDay();
    const email = `route-${crypto.randomUUID().slice(0, 8)}@x.test`;
    await seedUser(email);
    const ctx = await context();
    const { code, row } = await createChallenge(email, ctx.context);
    expect((await verify(email, code, ctx.value, "route-key")).status).toBe(200);
    const keys = await testKeyring;
    const shell = createApiShell({
      authenticator: {
        async authenticate() {
          return { kind: "none" } as const;
        },
      },
      csrfKey: () => keys.csrf(),
      routes: [makeCompleteRoute(() => Promise.resolve(keys))],
    });
    const csrf = await mintCsrfToken(keys.csrf(), ctx.context.preauthId, randomBytes(32));
    const base = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
        cookie: `__Host-preauth=${ctx.value}; __Host-hoyo_csrf=${csrf}`,
        "x-csrf-token": csrf,
        "idempotency-key": "route-key",
      },
    };
    const good = await shell.fetch(
      new Request("https://app.test/api/v2/auth/complete", { ...base, body: "{}" }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(good.status).toBe(200);
    expect(sessionCookie(good)).not.toBeNull();
    const forbidden = await shell.fetch(
      new Request("https://app.test/api/v2/auth/complete", {
        ...base,
        body: JSON.stringify({ challenge_id: row.id }),
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(forbidden.status).toBe(400);
  });

  it("A-P2-CONSUME 预认证剩余期限不足先续期，挑战仍未消费", async () => {
    nextDay();
    const email = `preauth-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const ctx = await context();
    now += (PREAUTH_MIN_TTL - OTP_TTL - 5) * SECOND;
    const { row, code } = await createChallenge(email, ctx.context);
    const response = await verify(email, code, ctx.value, "preauth-renew");
    expect(response.status).toBe(409);
    expect(
      (await query<Challenge>("SELECT * FROM auth_challenges WHERE id = ?", row.id))[0].consumed_at,
    ).toBeNull();
    const renewed = response.headers.get("set-cookie")?.match(/__Host-preauth=([^;]+)/)?.[1];
    expect(renewed).toBeDefined();
    expect((await verify(email, code, renewed as string, "preauth-renew")).status).toBe(200);
  });

  it("A-P2-CONSUME 发送载荷清除后重发仍从挑战列取原地址；列缺失则失败关闭", async () => {
    nextDay();
    const email = `Resend-${crypto.randomUUID().slice(0, 8)}@x.test`;
    const ctx = await context();
    const { row } = await createChallenge(email, ctx.context);
    await run(
      "UPDATE mail_outbox SET payload_ciphertext = NULL, status = 'accepted' WHERE payload_ref = ?",
      row.id,
    );
    now += (OTP_COOLDOWN + 1) * SECOND;
    const requestFor = (address: string) => request(ctx.value, "resend-op", address);
    const resent = await runResendOtp(
      { db: env.DB, keys: await testKeyring, now: clock },
      {
        request: requestFor(email.toLowerCase()),
        email: email.toLowerCase(),
        idempotencyKey: "resend-once",
      },
    );
    expect(resent.status).toBe(202);
    const latest = (
      await query<{ id: string; payload_ciphertext: ArrayBuffer | Uint8Array }>(
        "SELECT id, payload_ciphertext FROM mail_outbox WHERE payload_ref = ? AND payload_ciphertext IS NOT NULL",
        row.id,
      )
    )[0];
    const payload = await decryptOtpPayload(
      (await testKeyring).fieldEncryption(),
      latest.id,
      new Uint8Array(latest.payload_ciphertext),
    );
    expect(payload.address).toBe(email);

    await run("UPDATE auth_challenges SET delivery_address_ciphertext = NULL WHERE id = ?", row.id);
    now += (OTP_COOLDOWN + 1) * SECOND;
    await expect(
      runResendOtp(
        { db: env.DB, keys: await testKeyring, now: clock },
        { request: requestFor(email), email, idempotencyKey: "resend-twice" },
      ),
    ).rejects.toThrow();
  });
});
