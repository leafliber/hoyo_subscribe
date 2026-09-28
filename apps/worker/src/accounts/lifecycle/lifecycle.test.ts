// A-P2-ACCOUNT：真实 D1 校验最近证明、换邮箱事务、轮换两步确认、终止与分页释放。
// 邮箱与秘密全部是测试随机样本；不调用真实发信服务。
import { env } from "cloudflare:test";
import {
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  RECENT_AUTH_TTL,
  SECRET_BITS,
  SESSION_IDLE_TTL,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { asEnvelopeBytes, decryptOtpPayload } from "../../auth/challenges/payload";
import { startRecentOtp, verifyRecentOtp } from "../../auth/challenges/recent-auth";
import { makePendingSession } from "../../auth/consume/session";
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
      routes: makeLifecycleRoutes({ keys: async () => keys, now: () => now }),
    });
    const cookie = `${USER_SESSION_COOKIE_NAME}=${fixture.token}`;
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
    expect(JSON.stringify(summary)).not.toContain(fixture.email);
    expect(JSON.stringify(summary)).toContain("recent_auth_required");
    const exported = await exportPreferences(env.DB, fixture.userId);
    const text = JSON.stringify(exported);
    for (const sensitive of [
      fixture.email,
      fixture.recoverySecret,
      fixture.recoveryId,
      fixture.session.sessionTokenHash,
    ])
      expect(text).not.toContain(sensitive);
  });
});
