// F2-04 返工获准跨卡：补账号摘要 user_id 与偏好导出不含该标识的断言。
// A-P2-ACCOUNT：真实 D1 校验最近证明、换邮箱事务、轮换两步确认、终止与分页释放。
// 邮箱与秘密全部是测试随机样本；不调用真实发信服务。
import { env } from "cloudflare:test";
import {
  ACCOUNT_ACTIONS,
  type AccountAction,
  type AccountSummary,
  AccountSummarySchema,
  AUTH_CHALLENGES_PER_EMAIL,
  deriveAccountActions,
  EMAIL_AUTH_INTENTS_DAY,
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  OTP_ATTEMPTS,
  OTP_COOLDOWN,
  OTP_TTL,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  RECENT_AUTH_ACTIONS,
  RECENT_AUTH_TTL,
  type RecentAuthAction,
  type RecentAuthRole,
  SECRET_BITS,
  SESSION_IDLE_TTL,
  SUBSCRIPTION_SCHEMA_VERSION,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { asEnvelopeBytes, decryptOtpPayload } from "../../auth/challenges/payload";
import { startRecentOtp, verifyRecentOtp } from "../../auth/challenges/recent-auth";
import { makePendingSession } from "../../auth/consume/session";
import type { ApproximateRateGate } from "../../auth/preauth/rate-gate";
import type { TurnstileVerifier } from "../../auth/preauth/turnstile";
import { proveWithRecoveryCode } from "../../auth/recent-auth/proof";
import { targetForAction } from "../../auth/recent-auth/target";
import { hashRecoverySecret } from "../../auth/recovery/credential";
import { sessionAuthenticator } from "../../auth/sessions/authenticator";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { fakeExecutionContext, randomBytes, testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { computeEmailKey } from "../../storage/crypto/mac";
import { splitSqlStatements } from "../../storage/split-sql";
import { makeSubscriptionRoutes } from "../subscription/routes";
import { cleanupDeletedAccountPage } from "./cleanup";
import { makeLifecycleRoutes } from "./routes";
import {
  changeEmail,
  confirmRecoveryRotation,
  markAccountDeleting,
  startRecoveryRotation,
} from "./service";
import { exportPreferences, readAccountSummary } from "./views";

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
const SECOND = 1_000;
const now = utcDayPeriod(1_900_000_000_000).startMs + SECOND;
let sequence = 0;
const keysPromise = testKeyring;
const testRateGate: ApproximateRateGate = {
  check: () => ({ allowed: true }),
  recordIntent: () => {},
};
const testTurnstile: TurnstileVerifier = { verify: async () => "passed" };
const testAdmission = {
  rateGate: testRateGate,
  turnstile: testTurnstile,
  turnstileToken: "test-token",
};

async function resetDatabase(): Promise<void> {
  const objects =
    (
      await env.DB.prepare(`SELECT type,name FROM sqlite_master
    WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'`).all<{
        type: string;
        name: string;
      }>()
    ).results ?? [];
  for (const obj of objects)
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  for (let pass = 0; pass < 20; pass++) {
    const tables =
      (
        await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'`).all<{ name: string }>()
      ).results ?? [];
    if (tables.length === 0) break;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        /* dependency */
      }
    }
  }
}

beforeAll(async () => {
  await resetDatabase();
  for (const name of Object.keys(migrations).sort()) {
    await env.DB.batch(
      splitSqlStatements(migrations[name] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  }
}, 180_000);

async function first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}

async function seed(): Promise<{
  userId: string;
  session: { userId: string; sessionId: string; sessionTokenHash: string };
  token: string;
  recoveryId: string;
  recoverySecret: string;
  email: string;
}> {
  const keys = await keysPromise;
  const userId = crypto.randomUUID();
  const email = `Case${++sequence}@example.test`;
  const emailKey = await computeEmailKey(keys.emailLookup(), email.toLowerCase());
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id: userId },
    email,
  );
  await env.DB.prepare(`INSERT INTO users
    (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,
      auth_epoch,recovery_epoch,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,0,0,?,?)`)
    .bind(userId, sequence, "active", emailKey, crypto.randomUUID(), ciphertext, now, now)
    .run();
  await env.DB.prepare(`INSERT INTO user_subscriptions
    (user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at)
    VALUES (?,'uninitialized',3,0,NULL,NULL,NULL,?,?)`)
    .bind(userId, now, now)
    .run();
  const made = await makePendingSession(now);
  await env.DB.prepare(`INSERT INTO sessions
    (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,
      expires_at,renewed_at,auth_epoch,recovery_epoch,recovery_code_required,activated_at,
      created_at,updated_at)
    VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,0,?,?,?)`)
    .bind(
      made.id,
      userId,
      made.tokenHash,
      made.label,
      made.platformHint,
      now,
      made.absoluteExpiresAt,
      Math.min(now + SESSION_IDLE_TTL * SECOND, made.absoluteExpiresAt),
      now,
      0,
      0,
      now,
      now,
      now,
    )
    .run();
  const recoveryId = crypto.randomUUID();
  const recoverySecret = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO recovery_credentials
    (id,user_id,secret_hash,generation,saved_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?)`)
    .bind(recoveryId, userId, await hashRecoverySecret(recoverySecret), now, now, now)
    .run();
  return {
    userId,
    session: { userId, sessionId: made.id, sessionTokenHash: made.tokenHash },
    token: made.cookieValue,
    recoveryId,
    recoverySecret,
    email,
  };
}

describe("A-P2-ACCOUNT", () => {
  it("真实外壳校验会话 CSRF；受限恢复会话仅可导出与最近恢复后删除", async () => {
    const fixture = await seed();
    const keys = await keysPromise;
    await env.DB.prepare("UPDATE sessions SET recovery_code_required = 1 WHERE id = ?")
      .bind(fixture.session.sessionId)
      .run();
    const emailKey = (
      await first<{ email_key: string }>("SELECT email_key FROM users WHERE id = ?", fixture.userId)
    )?.email_key;
    await env.DB.prepare(`INSERT INTO auth_challenges
      (id,purpose,email_key,address_version,preauth_id,mac,generation,attempts,deadline,
       consumed_at,pending_session_id,created_at,updated_at)
      VALUES (?,'recovery',?,1,?,'synthetic',0,0,?,?,?, ?,?)`)
      .bind(
        crypto.randomUUID(),
        emailKey,
        crypto.randomUUID(),
        now + RECENT_AUTH_TTL * SECOND,
        now,
        fixture.session.sessionId,
        now,
        now,
      )
      .run();
    const shell = createApiShell({
      authenticator: sessionAuthenticator(env.DB, () => now),
      csrfKey: () => keys.csrf(),
      routes: makeLifecycleRoutes({
        keys: async () => keys,
        rateGate: testRateGate,
        turnstile: () => testTurnstile,
        now: () => now,
      }),
    });
    const cookie = `${USER_SESSION_COOKIE_NAME}=${fixture.token}`;
    const beforeRead = await first<{ expires_at: number; renewed_at: number }>(
      "SELECT expires_at,renewed_at FROM sessions WHERE id = ?",
      fixture.session.sessionId,
    );
    const summary = await shell.fetch(
      new Request("https://app.test/api/v2/me", { headers: { cookie } }),
      env,
      fakeExecutionContext,
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toHaveProperty("user_id", fixture.userId);
    expect(
      await first(
        "SELECT expires_at,renewed_at FROM sessions WHERE id = ?",
        fixture.session.sessionId,
      ),
    ).toEqual(beforeRead);
    const exported = await shell.fetch(
      new Request("https://app.test/api/v2/me/export", { headers: { cookie } }),
      env,
      fakeExecutionContext,
    );
    expect(exported.status).toBe(200);
    expect(await exported.text()).not.toContain(fixture.email);
    const missingCsrf = await shell.fetch(
      new Request("https://app.test/api/v2/me/delete", {
        method: "POST",
        headers: { cookie, origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      env,
      fakeExecutionContext,
    );
    expect(missingCsrf.status).toBe(401);
    expect(
      (await first<{ status: string }>("SELECT status FROM users WHERE id = ?", fixture.userId))
        ?.status,
    ).toBe("active");
    const csrf = await mintCsrfToken(
      keys.csrf(),
      fixture.session.sessionTokenHash,
      randomBytes(SECRET_BITS / 8),
    );
    await expect(
      markAccountDeleting(env.DB, fixture.session, undefined, now + RECENT_AUTH_TTL * SECOND + 1),
    ).rejects.toMatchObject({ code: "unauthorized", details: { reason: "recent_auth_required" } });
    expect(
      (await first<{ status: string }>("SELECT status FROM users WHERE id = ?", fixture.userId))
        ?.status,
    ).toBe("active");
    const stopped = await shell.fetch(
      new Request("https://app.test/api/v2/me/delete", {
        method: "POST",
        headers: {
          cookie: `${cookie}; ${CSRF_COOKIE_NAME}=${csrf}`,
          origin: "https://app.test",
          "content-type": "application/json",
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify({ confirm: true }),
      }),
      env,
      fakeExecutionContext,
    );
    expect(stopped.status).toBe(200);
    const after = await shell.fetch(
      new Request("https://app.test/api/v2/me", { headers: { cookie } }),
      env,
      fakeExecutionContext,
    );
    expect(after.status).toBe(401);
  });
  it("伪造证明时已注册地址与未知地址的换绑响应同形", async () => {
    const owner = await seed();
    const occupied = await seed();
    const keys = await keysPromise;
    const csrf = await mintCsrfToken(
      keys.csrf(),
      owner.session.sessionTokenHash,
      randomBytes(SECRET_BITS / 8),
    );
    const shell = createApiShell({
      authenticator: sessionAuthenticator(env.DB, () => now),
      csrfKey: () => keys.csrf(),
      routes: makeLifecycleRoutes({
        keys: async () => keys,
        rateGate: testRateGate,
        turnstile: () => testTurnstile,
        now: () => now,
      }),
    });
    const requestFor = (targetEmail: string) =>
      new Request("https://app.test/api/v2/me/email-change", {
        method: "POST",
        headers: {
          cookie: `${USER_SESSION_COOKIE_NAME}=${owner.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
          origin: "https://app.test",
          "content-type": "application/json",
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify({
          target_email: targetEmail,
          current_proof_id: crypto.randomUUID(),
          new_proof_id: crypto.randomUUID(),
        }),
      });
    const registered = await shell.fetch(requestFor(occupied.email), env, fakeExecutionContext);
    const unknown = await shell.fetch(
      requestFor(`Unknown${sequence}@example.test`),
      env,
      fakeExecutionContext,
    );
    expect(registered.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await registered.text()).toBe(await unknown.text());

    const target = await targetForAction("email_change", occupied.email);
    const current = await proveWithRecoveryCode(
      env.DB,
      owner.session,
      "email_change",
      occupied.email,
      owner.recoveryId,
      owner.recoverySecret,
      now,
    );
    const newProof = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO recent_auth_proofs
      (id,user_id,session_id,action,role,target_digest,method,expires_at,created_at)
      VALUES (?,?,?,'email_change','new_address',?,'otp',?,?)`)
      .bind(
        newProof,
        owner.userId,
        owner.session.sessionId,
        target.digest,
        now + RECENT_AUTH_TTL * SECOND,
        now,
      )
      .run();
    await expect(
      changeEmail(env.DB, keys, owner.session, occupied.email, current, newProof, now),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recent_auth_proofs WHERE id = ?",
          current,
        )
      )?.consumed_at,
    ).toBeNull();
  });

  it("最近认证证明不能从同账号另一会话消费", async () => {
    const owner = await seed();
    const other = await seed();
    const keys = await keysPromise;
    await env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
      .bind(owner.userId, other.session.sessionId)
      .run();
    const alternate = { ...other.session, userId: owner.userId };
    const targetEmail = `Session${sequence}@example.test`;
    const target = await targetForAction("email_change", targetEmail);
    const current = await proveWithRecoveryCode(
      env.DB,
      owner.session,
      "email_change",
      targetEmail,
      owner.recoveryId,
      owner.recoverySecret,
      now,
    );
    const newProof = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO recent_auth_proofs
      (id,user_id,session_id,action,role,target_digest,method,expires_at,created_at)
      VALUES (?,?,?,'email_change','new_address',?,'otp',?,?)`)
      .bind(
        newProof,
        owner.userId,
        owner.session.sessionId,
        target.digest,
        now + RECENT_AUTH_TTL * SECOND,
        now,
      )
      .run();
    await expect(
      changeEmail(env.DB, keys, alternate, targetEmail, current, newProof, now),
    ).rejects.toMatchObject({ code: "unauthorized", details: { reason: "recent_auth_required" } });
    expect(
      (
        await first<{ email_version: number }>(
          "SELECT email_version FROM users WHERE id = ?",
          owner.userId,
        )
      )?.email_version,
    ).toBe(1);
  });

  it("当前和新地址发码都经限速门与 Turnstile；两张挑战表合计邮箱配额", async () => {
    const owner = await seed();
    const keys = await keysPromise;
    const passed: string[] = [];
    const rateGate: ApproximateRateGate = {
      check: ({ canonicalEmail }) => {
        passed.push(`gate:${canonicalEmail}`);
        return { allowed: true };
      },
      recordIntent: (email) => {
        passed.push(`record:${email}`);
      },
    };
    const turnstile: TurnstileVerifier = {
      verify: async ({ token }) => {
        passed.push(`turnstile:${token}`);
        return "passed";
      },
    };
    const admission = { rateGate, turnstile, turnstileToken: "once" };
    const target = `Role${sequence}@example.test`;
    await startRecentOtp(
      env.DB,
      keys,
      owner.session,
      "email_change",
      "current",
      target,
      crypto.randomUUID(),
      now,
      admission,
    );
    await startRecentOtp(
      env.DB,
      keys,
      owner.session,
      "email_change",
      "new_address",
      target,
      crypto.randomUUID(),
      now,
      admission,
    );
    expect(passed.filter((entry) => entry.startsWith("gate:"))).toHaveLength(2);
    expect(passed.filter((entry) => entry.startsWith("turnstile:"))).toHaveLength(2);
    const deniedGate: ApproximateRateGate = {
      check: () => ({ allowed: false, reason: "cooldown_mirror", retryAfterMs: SECOND }),
      recordIntent: () => {
        throw new Error("unexpected record");
      },
    };
    await expect(
      startRecentOtp(
        env.DB,
        keys,
        owner.session,
        "email_change",
        "new_address",
        `Blocked${sequence}@example.test`,
        crypto.randomUUID(),
        now,
        { rateGate: deniedGate, turnstile, turnstileToken: "blocked" },
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(passed).not.toContain("turnstile:blocked");

    const quotaTarget = `Quota${sequence}@example.test`;
    const quotaKey = await computeEmailKey(keys.emailLookup(), quotaTarget.toLowerCase());
    for (let index = 0; index < AUTH_CHALLENGES_PER_EMAIL; index++) {
      await env.DB.prepare(`INSERT INTO auth_challenges
        (id,purpose,email_key,address_version,preauth_id,mac,deadline,created_at,updated_at)
        VALUES (?,'login',?,1,?,'seed',?,?,?)`)
        .bind(
          crypto.randomUUID(),
          quotaKey,
          crypto.randomUUID(),
          now + OTP_TTL * SECOND,
          now - OTP_COOLDOWN * SECOND - 1,
          now - OTP_COOLDOWN * SECOND - 1,
        )
        .run();
    }
    await expect(
      startRecentOtp(
        env.DB,
        keys,
        owner.session,
        "email_change",
        "new_address",
        quotaTarget,
        crypto.randomUUID(),
        now,
        testAdmission,
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(
      (
        await first<{ c: number }>(
          "SELECT count(*) AS c FROM recent_auth_challenges WHERE email_key = ?",
          quotaKey,
        )
      )?.c,
    ).toBe(0);

    const intentsTarget = `Intents${sequence}@example.test`;
    const intentsKey = await computeEmailKey(keys.emailLookup(), intentsTarget.toLowerCase());
    for (let index = 0; index < EMAIL_AUTH_INTENTS_DAY; index++) {
      await env.DB.prepare(`INSERT INTO auth_challenges
        (id,purpose,email_key,address_version,preauth_id,mac,deadline,consumed_at,created_at,updated_at)
        VALUES (?,'login',?,1,?,'seed',?,?,?,?)`)
        .bind(
          crypto.randomUUID(),
          intentsKey,
          crypto.randomUUID(),
          now + OTP_TTL * SECOND,
          now,
          now,
          now,
        )
        .run();
    }
    await expect(
      startRecentOtp(
        env.DB,
        keys,
        owner.session,
        "email_change",
        "new_address",
        intentsTarget,
        crypto.randomUUID(),
        now + OTP_COOLDOWN * SECOND + 1,
        testAdmission,
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("邮箱维度一小时失败次数覆盖普通与最近认证挑战", async () => {
    const owner = await seed();
    const keys = await keysPromise;
    const target = `Attempts${sequence}@example.test`;
    const challenge = await startRecentOtp(
      env.DB,
      keys,
      owner.session,
      "email_change",
      "new_address",
      target,
      crypto.randomUUID(),
      now,
      testAdmission,
    );
    const row = await first<{ email_key: string; outbox_id: string }>(
      "SELECT email_key,outbox_id FROM recent_auth_challenges WHERE id = ?",
      challenge,
    );
    if (row === null) throw new Error("missing recent challenge");
    const outbox = await first<{ payload_ciphertext: ArrayBuffer | Uint8Array }>(
      "SELECT payload_ciphertext FROM mail_outbox WHERE id = ?",
      row.outbox_id,
    );
    if (outbox === null) throw new Error("missing test payload");
    const payload = await decryptOtpPayload(
      keys.fieldEncryption(),
      row.outbox_id,
      asEnvelopeBytes(outbox.payload_ciphertext),
    );
    let remaining = EMAIL_VERIFY_ATTEMPTS_HOUR;
    while (remaining > 0) {
      const attempts = Math.min(remaining, OTP_ATTEMPTS);
      await env.DB.prepare(`INSERT INTO auth_challenges
        (id,purpose,email_key,address_version,preauth_id,mac,attempts,deadline,created_at,updated_at)
        VALUES (?,'login',?,1,?,'seed',?,?,?,?)`)
        .bind(
          crypto.randomUUID(),
          row.email_key,
          crypto.randomUUID(),
          attempts,
          now + OTP_TTL * SECOND,
          now,
          now,
        )
        .run();
      remaining -= attempts;
    }
    await expect(
      verifyRecentOtp(env.DB, keys, owner.session, challenge, payload.code, now),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recent_auth_challenges WHERE id = ?",
          challenge,
        )
      )?.consumed_at,
    ).toBeNull();
  });

  it("当前恢复码证明与新地址 OTP 均绑定同一会话和目标；换绑撤销旧权限且不改订阅", async () => {
    const fixture = await seed();
    const keys = await keysPromise;
    await expect(
      changeEmail(
        env.DB,
        keys,
        fixture.session,
        fixture.email,
        crypto.randomUUID(),
        crypto.randomUUID(),
        now,
      ),
    ).rejects.toMatchObject({ code: "unauthorized", details: { reason: "recent_auth_required" } });
    const target = `Next${sequence}@example.test`;
    const current = await proveWithRecoveryCode(
      env.DB,
      fixture.session,
      "email_change",
      target,
      fixture.recoveryId,
      fixture.recoverySecret,
      now,
    );
    const requestKey = crypto.randomUUID();
    const challenge = await startRecentOtp(
      env.DB,
      keys,
      fixture.session,
      "email_change",
      "new_address",
      target,
      requestKey,
      now,
      testAdmission,
    );
    expect(
      await startRecentOtp(
        env.DB,
        keys,
        fixture.session,
        "email_change",
        "new_address",
        target,
        requestKey,
        now,
        testAdmission,
      ),
    ).toBe(challenge);
    await expect(
      startRecentOtp(
        env.DB,
        keys,
        fixture.session,
        "email_change",
        "new_address",
        target,
        crypto.randomUUID(),
        now,
        testAdmission,
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const outbox = await first<{ id: string; payload_ciphertext: ArrayBuffer | Uint8Array }>(
      "SELECT id,payload_ciphertext FROM mail_outbox WHERE payload_ref = ?",
      challenge,
    );
    expect(outbox).not.toBeNull();
    if (outbox === null) throw new Error("missing_test_outbox");
    const payload = await decryptOtpPayload(
      keys.fieldEncryption(),
      outbox.id,
      asEnvelopeBytes(outbox.payload_ciphertext),
    );
    expect(payload.address).toBe(target);
    const newProof = await verifyRecentOtp(
      env.DB,
      keys,
      fixture.session,
      challenge,
      payload.code,
      now,
    );
    await expect(
      verifyRecentOtp(env.DB, keys, fixture.session, challenge, payload.code, now),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const before = await first<{ email_binding_id: string }>(
      "SELECT email_binding_id FROM users WHERE id = ?",
      fixture.userId,
    );
    await env.DB.prepare(`INSERT INTO email_channels
      (user_id,enabled,routine_enabled,address_version,created_at,updated_at)
      VALUES (?,1,1,1,?,?)`)
      .bind(fixture.userId, now, now)
      .run();
    const oldTaskId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO mail_outbox
      (id,purpose,priority,period_key,recipient_user_id,email_binding_id,address_version,
        payload_kind,status,created_at,updated_at)
      VALUES (?,'base_business',5,?,?,?,?, 'template','pending',?,?)`)
      .bind(
        oldTaskId,
        OUTBOX_UNRESERVED_PERIOD_KEY,
        fixture.userId,
        before?.email_binding_id,
        1,
        now,
        now,
      )
      .run();
    await expect(
      changeEmail(
        env.DB,
        keys,
        fixture.session,
        `Other${sequence}@example.test`,
        current,
        newProof,
        now,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recent_auth_proofs WHERE id = ?",
          current,
        )
      )?.consumed_at,
    ).toBeNull();
    const result = await changeEmail(env.DB, keys, fixture.session, target, current, newProof, now);
    const after = await first<{
      email_key: string;
      email_version: number;
      auth_epoch: number;
      email_binding_id: string;
    }>(
      "SELECT email_key,email_version,auth_epoch,email_binding_id FROM users WHERE id = ?",
      fixture.userId,
    );
    expect(after?.email_version).toBe(2);
    expect(after?.auth_epoch).toBe(1);
    expect(after?.email_binding_id).not.toBe(before?.email_binding_id);
    expect(after?.email_key).toBe(await computeEmailKey(keys.emailLookup(), target.toLowerCase()));
    expect(
      await first<{ enabled: number; routine_enabled: number; address_version: number }>(
        "SELECT enabled,routine_enabled,address_version FROM email_channels WHERE user_id = ?",
        fixture.userId,
      ),
    ).toMatchObject({ enabled: 0, routine_enabled: 0, address_version: 2 });
    expect(
      (await first<{ status: string }>("SELECT status FROM mail_outbox WHERE id = ?", oldTaskId))
        ?.status,
    ).toBe("skipped");
    expect(
      (
        await first<{ state: string }>(
          "SELECT state FROM sessions WHERE id = ?",
          fixture.session.sessionId,
        )
      )?.state,
    ).toBe("revoked");
    expect(
      (
        await first<{ state: string; auth_epoch: number }>(
          "SELECT state,auth_epoch FROM sessions WHERE id = ?",
          result.pendingSession.id,
        )
      )?.auth_epoch,
    ).toBe(1);
    expect(
      (
        await first<{ state: string }>(
          "SELECT state FROM user_subscriptions WHERE user_id = ?",
          fixture.userId,
        )
      )?.state,
    ).toBe("uninitialized");
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recent_auth_proofs WHERE id = ?",
          current,
        )
      )?.consumed_at,
    ).toBe(now);
    await expect(
      changeEmail(
        env.DB,
        keys,
        fixture.session,
        `Other${sequence}@example.test`,
        current,
        newProof,
        now,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("轮换先交付、可同键重生；确认前旧码仍有效，确认后旧码失效", async () => {
    const fixture = await seed();
    const proof = await proveWithRecoveryCode(
      env.DB,
      fixture.session,
      "recovery_code_rotate",
      undefined,
      fixture.recoveryId,
      fixture.recoverySecret,
      now,
    );
    const firstCode = await startRecoveryRotation(env.DB, fixture.session, proof, "retry-key", now);
    const secondCode = await startRecoveryRotation(
      env.DB,
      fixture.session,
      proof,
      "retry-key",
      now,
    );
    expect(secondCode.recoveryId).toBe(firstCode.recoveryId);
    expect(secondCode.secret).not.toBe(firstCode.secret);
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recovery_credentials WHERE id = ?",
          fixture.recoveryId,
        )
      )?.consumed_at,
    ).toBeNull();
    await expect(
      confirmRecoveryRotation(
        env.DB,
        fixture.session,
        secondCode.rotationId,
        firstCode.secret,
        now,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await confirmRecoveryRotation(
      env.DB,
      fixture.session,
      secondCode.rotationId,
      secondCode.secret,
      now,
    );
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recovery_credentials WHERE id = ?",
          fixture.recoveryId,
        )
      )?.consumed_at,
    ).toBe(now);
    expect(
      (
        await first<{ saved_confirmed_at: number | null }>(
          "SELECT saved_confirmed_at FROM recovery_credentials WHERE id = ?",
          secondCode.recoveryId,
        )
      )?.saved_confirmed_at,
    ).toBe(now);
  });

  it("换邮箱日额满时不改地址、不消费证明，也不额外扣额", async () => {
    const fixture = await seed();
    const keys = await keysPromise;
    const targetEmail = `Budget${sequence}@example.test`;
    const target = await targetForAction("email_change", targetEmail);
    const current = await proveWithRecoveryCode(
      env.DB,
      fixture.session,
      "email_change",
      targetEmail,
      fixture.recoveryId,
      fixture.recoverySecret,
      now,
    );
    const newProof = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO recent_auth_proofs
      (id,user_id,session_id,action,role,target_digest,method,expires_at,created_at)
      VALUES (?,?,?,'email_change','new_address',?,'otp',?,?)`)
      .bind(
        newProof,
        fixture.userId,
        fixture.session.sessionId,
        target.digest,
        now + RECENT_AUTH_TTL * SECOND,
        now,
      )
      .run();
    const { userKey, globalKey } = mutationCounterKeys(fixture.userId, utcDayPeriod(now).key);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO capacity_state (key,value,version,updated_at)
        VALUES (?,?,0,?)`).bind(userKey, USER_MUTATIONS_DAY, now),
      env.DB.prepare(`INSERT INTO capacity_state (key,value,version,updated_at)
        VALUES (?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(
        globalKey,
        GLOBAL_MUTATIONS_DAY,
        now,
      ),
    ]);
    await expect(
      changeEmail(env.DB, keys, fixture.session, targetEmail, current, newProof, now),
    ).rejects.toMatchObject({ code: "quota_paused" });
    expect(
      (
        await first<{ email_version: number }>(
          "SELECT email_version FROM users WHERE id = ?",
          fixture.userId,
        )
      )?.email_version,
    ).toBe(1);
    expect(
      (
        await first<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recent_auth_proofs WHERE id = ?",
          current,
        )
      )?.consumed_at,
    ).toBeNull();
    expect(
      (await first<{ value: number }>("SELECT value FROM capacity_state WHERE key = ?", userKey))
        ?.value,
    ).toBe(USER_MUTATIONS_DAY);
  });

  it("删除绕过普通日额，先封权限，分页清理完成才释放账号存量", async () => {
    const fixture = await seed();
    const proof = await proveWithRecoveryCode(
      env.DB,
      fixture.session,
      "account_delete",
      undefined,
      fixture.recoveryId,
      fixture.recoverySecret,
      now,
    );
    const { userKey, globalKey } = mutationCounterKeys(fixture.userId, utcDayPeriod(now).key);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(userKey, USER_MUTATIONS_DAY, now),
      env.DB.prepare(
        "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(globalKey, GLOBAL_MUTATIONS_DAY, now),
      env.DB.prepare(
        "INSERT INTO capacity_state (key,value,version,updated_at) VALUES ('accounts_total',1,0,?) ON CONFLICT(key) DO UPDATE SET value=1",
      ).bind(now),
    ]);
    const oldKey = (
      await first<{ email_key: string }>("SELECT email_key FROM users WHERE id = ?", fixture.userId)
    )?.email_key;
    await markAccountDeleting(env.DB, fixture.session, proof, now);
    expect(
      (
        await first<{ status: string; auth_epoch: number }>(
          "SELECT status,auth_epoch FROM users WHERE id = ?",
          fixture.userId,
        )
      )?.status,
    ).toBe("deleting");
    expect(
      (
        await first<{ state: string }>(
          "SELECT state FROM sessions WHERE id = ?",
          fixture.session.sessionId,
        )
      )?.state,
    ).toBe("revoked");
    expect(
      (
        await first<{ value: number }>(
          "SELECT value FROM capacity_state WHERE key = 'accounts_total'",
        )
      )?.value,
    ).toBe(1);
    let outcome: Awaited<ReturnType<typeof cleanupDeletedAccountPage>> | undefined;
    for (let step = 0; step < 30; step++) {
      outcome = await cleanupDeletedAccountPage(env.DB, fixture.userId, 1, now);
      if (outcome.state === "complete") break;
    }
    expect(outcome?.state).toBe("complete");
    expect(
      (
        await first<{ value: number }>(
          "SELECT value FROM capacity_state WHERE key = 'accounts_total'",
        )
      )?.value,
    ).toBe(0);
    expect(
      (
        await first<{ email_key: string; deletion_completed_at: number | null }>(
          "SELECT email_key,deletion_completed_at FROM users WHERE id = ?",
          fixture.userId,
        )
      )?.email_key,
    ).not.toBe(oldKey);
    expect((await cleanupDeletedAccountPage(env.DB, fixture.userId, 1, now)).state).toBe(
      "complete",
    );
  });

  it("摘要脱敏且偏好导出不含邮箱或任何秘密", async () => {
    const fixture = await seed();
    const auth = {
      kind: "session" as const,
      domain: "user" as const,
      userId: fixture.userId,
      sessionId: fixture.session.sessionId,
      sessionTokenHash: fixture.session.sessionTokenHash,
      sessionState: "active" as const,
      recoveryCodeRequired: false,
    };
    const summary = await readAccountSummary(env.DB, await keysPromise, auth, now);
    expect(summary).toHaveProperty("user_id", fixture.userId);
    expect(JSON.stringify(summary)).not.toContain(fixture.email);
    expect(summary.recent_auth).toEqual({
      email_change: null,
      recovery_code_rotate: null,
      account_delete: null,
    });
    expect(deriveAccountActions(summary, now).account_delete).toEqual({
      allowed: false,
      reason: "recent_auth_required",
    });
    const exported = await exportPreferences(env.DB, fixture.userId);
    const text = JSON.stringify(exported);
    expect(exported).not.toHaveProperty("user_id");
    for (const sensitive of [
      fixture.userId,
      fixture.email,
      fixture.recoverySecret,
      fixture.recoveryId,
      fixture.session.sessionTokenHash,
    ])
      expect(text).not.toContain(sensitive);
  });
});

// P2-10：同一 D1 事实先经 GET 摘要推导，再由真实路由/CSRF/写入守卫验证。
type AccountFixture = Awaited<ReturnType<typeof seed>>;
async function accountClient(fixture: AccountFixture, clock: () => number = () => now) {
  const keys = await keysPromise;
  const csrf = await mintCsrfToken(
    keys.csrf(),
    fixture.session.sessionTokenHash,
    randomBytes(SECRET_BITS / 8),
  );
  const shell = createApiShell({
    authenticator: sessionAuthenticator(env.DB, clock),
    csrfKey: () => keys.csrf(),
    routes: [
      ...makeLifecycleRoutes({
        keys: async () => keys,
        rateGate: testRateGate,
        turnstile: () => testTurnstile,
        now: clock,
      }),
      ...makeSubscriptionRoutes(clock),
    ],
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    shell.fetch(
      new Request(`https://app.test/api/v2/me${path}`, {
        method,
        headers: {
          cookie: `${USER_SESSION_COOKIE_NAME}=${fixture.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
          origin: "https://app.test",
          "content-type": "application/json",
          [CSRF_HEADER_NAME]: csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      fakeExecutionContext,
    );
  return {
    request,
    summary: async () => {
      const response = await request("");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).not.toHaveProperty("actions");
      expect(body).not.toHaveProperty("session.expiry_notice");
      return AccountSummarySchema.parse(body);
    },
  };
}

async function insertProof(
  fixture: AccountFixture,
  action: RecentAuthAction,
  role: RecentAuthRole,
  digest: string,
  expiresAt = now + RECENT_AUTH_TTL * SECOND,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO recent_auth_proofs
    (id,user_id,session_id,action,role,target_digest,method,expires_at,created_at)
    VALUES (?,?,?,?,?,?,'otp',?,?)`)
    .bind(id, fixture.userId, fixture.session.sessionId, action, role, digest, expiresAt, now)
    .run();
  return id;
}

async function actionProofs(fixture: AccountFixture, action: AccountAction) {
  const targetEmail = `Matrix${++sequence}@example.test`;
  if (action === "save_subscription" || action === "export_data") {
    return { current: crypto.randomUUID(), newAddress: crypto.randomUUID(), targetEmail };
  }
  const target = await targetForAction(action, action === "email_change" ? targetEmail : undefined);
  const current = await insertProof(fixture, action, "current", target.digest);
  const newAddress =
    action === "email_change"
      ? await insertProof(fixture, action, "new_address", target.digest)
      : crypto.randomUUID();
  return { current, newAddress, targetEmail };
}

type ProofIds = Awaited<ReturnType<typeof actionProofs>>;
function executeAction(
  client: Awaited<ReturnType<typeof accountClient>>,
  action: AccountAction,
  proof: ProofIds,
) {
  switch (action) {
    case "save_subscription":
      return client.request("/subscription", "PATCH", {
        expected_revision: 0,
        config: {
          schema_version: SUBSCRIPTION_SCHEMA_VERSION,
          scope: { games: ["genshin"], regions: ["CN"] },
          calendar: { event_types: ["livestream"], node_types: ["start"], alarms_enabled: false },
          notifications: {
            rule_ids: [],
            new_event: false,
            important_change: true,
            cancelled_or_retracted: false,
            late_discovery: false,
          },
        },
      });
    case "export_data":
      return client.request("/export");
    case "email_change":
      return client.request("/email-change", "POST", {
        target_email: proof.targetEmail,
        current_proof_id: proof.current,
        new_proof_id: proof.newAddress,
      });
    case "recovery_code_rotate":
      return client.request("/recovery-code", "POST", {
        action: "start",
        proof_id: proof.current,
        operation_key: crypto.randomUUID(),
      });
    case "account_delete":
      return client.request("/delete", "POST", {
        confirm: true,
        proof_id: proof.current,
      });
  }
}

async function assertActionResult(response: Response, reason: string | null) {
  expect(response.status).toBe(reason === null ? 200 : 401);
  if (reason !== null) {
    expect(await response.json()).toMatchObject({
      error: {
        code: "unauthorized",
        details: { reason },
      },
    });
  }
}

async function recoveryLoginFact(
  fixture: AccountFixture,
  activatedAt: number,
  purpose = "recovery",
  consumedAt: number | null = now,
) {
  await env.DB.prepare("UPDATE sessions SET activated_at = ? WHERE id = ?")
    .bind(activatedAt, fixture.session.sessionId)
    .run();
  const row = await first<{ email_key: string }>(
    "SELECT email_key FROM users WHERE id = ?",
    fixture.userId,
  );
  await env.DB.prepare(`INSERT INTO auth_challenges
    (id,purpose,email_key,address_version,preauth_id,mac,generation,attempts,deadline,
      consumed_at,pending_session_id,created_at,updated_at)
    VALUES (?,?,?,1,?,'synthetic',0,0,?,?,?,?,?)`)
    .bind(
      crypto.randomUUID(),
      purpose,
      row?.email_key,
      crypto.randomUUID(),
      now + RECENT_AUTH_TTL * SECOND,
      consumedAt,
      fixture.session.sessionId,
      now,
      now,
    )
    .run();
}

describe("A-P2-ACCOUNT 动作推导与真实接口逐项对表", () => {
  for (const action of ACCOUNT_ACTIONS) {
    for (const restricted of [false, true]) {
      it.each([false, true])(
        `${action} 受限=${restricted} 可用证明=%s：放行或同原因拒绝`,
        async (hasProof) => {
          const fixture = await seed();
          // 既有配额用例留下的全站日额不能污染本组权限对表。
          const { globalKey } = mutationCounterKeys(fixture.userId, utcDayPeriod(now).key);
          await env.DB.prepare("UPDATE capacity_state SET value = 0 WHERE key = ?")
            .bind(globalKey)
            .run();
          await env.DB.prepare("UPDATE sessions SET recovery_code_required = ? WHERE id = ?")
            .bind(Number(restricted), fixture.session.sessionId)
            .run();
          const proof = hasProof
            ? await actionProofs(fixture, action)
            : {
                current: crypto.randomUUID(),
                newAddress: crypto.randomUUID(),
                targetEmail: `NoProof${++sequence}@example.test`,
              };
          const client = await accountClient(fixture);
          const facts = await client.summary();
          const reason =
            action === "export_data"
              ? null
              : restricted && action !== "account_delete"
                ? "recovery_code_unconfirmed"
                : action !== "save_subscription" && !hasProof
                  ? "recent_auth_required"
                  : null;
          expect(deriveAccountActions(facts, now)[action]).toEqual(
            reason === null ? { allowed: true } : { allowed: false, reason },
          );
          await assertActionResult(await executeAction(client, action, proof), reason);
        },
      );
    }
  }

  for (const action of RECENT_AUTH_ACTIONS) {
    it.each([
      "expired",
      "at_expiry",
      "consumed",
      "other_session",
      "other_user",
      "wrong_target",
      "wrong_role",
    ] as const)(`${action} 无效证明=%s：摘要为空且接口同原因拒绝`, async (invalid) => {
      const fixture = await seed();
      const proof = await actionProofs(fixture, action);
      const other = await seed();
      switch (invalid) {
        case "expired":
        case "at_expiry":
          await env.DB.prepare("UPDATE recent_auth_proofs SET expires_at = ? WHERE id = ?")
            .bind(now - (invalid === "expired" ? 1 : 0), proof.current)
            .run();
          break;
        case "consumed":
          await env.DB.prepare("UPDATE recent_auth_proofs SET consumed_at = ? WHERE id = ?")
            .bind(now, proof.current)
            .run();
          break;
        case "other_session":
          await env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
            .bind(fixture.userId, other.session.sessionId)
            .run();
          await env.DB.prepare("UPDATE recent_auth_proofs SET session_id = ? WHERE id = ?")
            .bind(other.session.sessionId, proof.current)
            .run();
          break;
        case "other_user":
          await env.DB.prepare("UPDATE recent_auth_proofs SET user_id = ? WHERE id = ?")
            .bind(other.userId, proof.current)
            .run();
          break;
        case "wrong_target":
          await env.DB.prepare("UPDATE recent_auth_proofs SET target_digest = ? WHERE id = ?")
            .bind("synthetic-mismatch", proof.current)
            .run();
          break;
        case "wrong_role":
          await env.DB.prepare("UPDATE recent_auth_proofs SET role = 'new_address' WHERE id = ?")
            .bind(proof.current)
            .run();
          break;
      }
      const client = await accountClient(fixture);
      const facts = await client.summary();
      expect(facts.recent_auth[action]).toBeNull();
      expect(deriveAccountActions(facts, now)[action]).toEqual({
        allowed: false,
        reason: "recent_auth_required",
      });
      await assertActionResult(await executeAction(client, action, proof), "recent_auth_required");
    });

    it(`${action} 同一份事实随时间失效，与稍后的写接口一致`, async () => {
      const fixture = await seed();
      const proof = await actionProofs(fixture, action);
      let time = now;
      const client = await accountClient(fixture, () => time);
      const facts = await client.summary();
      expect(facts.recent_auth[action]).toBe(now + RECENT_AUTH_TTL * SECOND);
      expect(deriveAccountActions(facts, time)[action]).toEqual({ allowed: true });
      time = now + RECENT_AUTH_TTL * SECOND;
      expect(deriveAccountActions(facts, time)[action]).toEqual({
        allowed: false,
        reason: "recent_auth_required",
      });
      await assertActionResult(await executeAction(client, action, proof), "recent_auth_required");
    });
  }

  it.each(["current", "new_address"] as const)(
    "换邮箱 %s 较早到期：只返回两者较早时间",
    async (role) => {
      const fixture = await seed();
      const proof = await actionProofs(fixture, "email_change");
      const earlier = now + RECENT_AUTH_TTL * SECOND - 1;
      await env.DB.prepare("UPDATE recent_auth_proofs SET expires_at = ? WHERE id = ?")
        .bind(earlier, role === "current" ? proof.current : proof.newAddress)
        .run();
      let time = now;
      const client = await accountClient(fixture, () => time);
      const facts = await client.summary();
      expect(facts.recent_auth.email_change).toBe(earlier);
      expect(deriveAccountActions(facts, time).email_change).toEqual({ allowed: true });
      time = earlier;
      expect((await client.summary()).recent_auth.email_change).toBeNull();
      expect(deriveAccountActions(facts, time).email_change).toEqual({
        allowed: false,
        reason: "recent_auth_required",
      });
      await assertActionResult(
        await executeAction(client, "email_change", proof),
        "recent_auth_required",
      );
    },
  );

  it.each([
    { label: "激活当刻", age: 0, restricted: true, allowed: true },
    { label: "TTL 边界", age: RECENT_AUTH_TTL * SECOND, restricted: true, allowed: true },
    { label: "TTL 后一毫秒", age: RECENT_AUTH_TTL * SECOND + 1, restricted: true, allowed: false },
    { label: "激活时间在未来", age: -1, restricted: true, allowed: false },
    { label: "新码已确认", age: 0, restricted: false, allowed: false },
  ])("恢复登录删除例外：$label", async ({ age, restricted, allowed }) => {
    const fixture = await seed();
    await env.DB.prepare("UPDATE sessions SET recovery_code_required = ? WHERE id = ?")
      .bind(Number(restricted), fixture.session.sessionId)
      .run();
    await recoveryLoginFact(fixture, now - age);
    const client = await accountClient(fixture);
    const facts = await client.summary();
    expect(facts.session.recovery_login_at).toBe(now - age);
    const reason = allowed ? null : "recent_auth_required";
    expect(deriveAccountActions(facts, now).account_delete).toEqual(
      allowed ? { allowed: true } : { allowed: false, reason },
    );
    await assertActionResult(await client.request("/delete", "POST", { confirm: true }), reason);
  });

  it.each(["login", "unconsumed"])("%s 挑战不算恢复登录", async (kind) => {
    const fixture = await seed();
    await env.DB.prepare("UPDATE sessions SET recovery_code_required = 1 WHERE id = ?")
      .bind(fixture.session.sessionId)
      .run();
    await recoveryLoginFact(
      fixture,
      now,
      kind === "login" ? "login" : "recovery",
      kind === "unconsumed" ? null : now,
    );
    const client = await accountClient(fixture);
    const facts = await client.summary();
    expect(facts.session.recovery_login_at).toBeNull();
    expect(deriveAccountActions(facts, now).account_delete).toEqual({
      allowed: false,
      reason: "recent_auth_required",
    });
    await assertActionResult(
      await client.request("/delete", "POST", { confirm: true }),
      "recent_auth_required",
    );
  });

  it("多组证明选择最长可用期，严格事实响应不泄密；摘要仍为八次只读查询", async () => {
    const fixture = await seed();
    const proof = await actionProofs(fixture, "email_change");
    const target = await targetForAction("email_change", proof.targetEmail);
    await insertProof(fixture, "email_change", "current", target.digest, now + 1);
    await insertProof(fixture, "email_change", "new_address", "unpaired-digest", now + 2);
    for (const action of ["account_delete", "recovery_code_rotate"] as const) {
      const digest = (await targetForAction(action)).digest;
      await insertProof(fixture, action, "current", digest, now + 1);
      await insertProof(fixture, action, "current", digest, now + RECENT_AUTH_TTL * SECOND);
    }
    const spy = vi.spyOn(env.DB, "prepare");
    let facts: AccountSummary;
    try {
      facts = await readAccountSummary(
        env.DB,
        await keysPromise,
        {
          kind: "session",
          domain: "user",
          ...fixture.session,
          sessionState: "active",
          recoveryCodeRequired: false,
        },
        now,
      );
      expect(spy).toHaveBeenCalledTimes(8);
      expect(spy.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(facts.server_time).toBe(now);
    expect(facts.user_id).toBe(fixture.userId);
    expect(facts.recent_auth).toEqual(
      Object.fromEntries(
        RECENT_AUTH_ACTIONS.map((action) => [action, now + RECENT_AUTH_TTL * SECOND]),
      ),
    );
    const text = JSON.stringify(facts);
    for (const secret of [
      proof.current,
      proof.newAddress,
      proof.targetEmail,
      target.digest,
      fixture.token,
      fixture.session.sessionTokenHash,
      fixture.recoverySecret,
      fixture.email,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
