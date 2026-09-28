// A-P2-RECOVERY · P2-05 离线恢复码：真实 D1、外壳权限、回执与 beforeCommit 真并发。
// 全部身份、Cookie 与码均为本测试随机合成；不使用真实邮箱或外部通道。
import { env } from "cloudflare:test";
import {
  AUTH_COMPLETION_TTL,
  GLOBAL_MUTATIONS_DAY,
  MAIL_AUTH_DAY,
  mutationCounterKeys,
  PREAUTH_MARGIN,
  RECOVERY_ATTEMPTS_DAY,
  RECOVERY_ATTEMPTS_HOUR,
  SECRET_BITS,
  SESSION_IDLE_TTL,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createApiShell,
  jsonResponse,
  mintCsrfToken,
} from "../../shell";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { fakeExecutionContext, randomBytes, testKeyring } from "../../shell/test-support";
import { fromBase64Url } from "../../storage/crypto/bytes";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { runCompleteAuth } from "../consume/complete";
import { hashSessionToken, makePendingSession } from "../consume/session";
import { mintPreauthCookieValue } from "../preauth/cookie";
import { sessionAuthenticator } from "../sessions/authenticator";
import { makeSessionRoutes } from "../sessions/routes";
import { runRecoveryAction, verifyRecoveryCredential } from "./action";
import { currentRecoveryCodeSaved, hashRecoverySecret } from "./credential";
import { chargeRecoveryId, InMemoryRecoverySourceGate, type RecoverySourceGate } from "./rate";
import { makeRecoveryRoutes } from "./routes";

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
const SITE = "https://app.test";
let now = utcDayPeriod(1_900_000_000_000).startMs + SECOND;
let userOrder = 0;
const clock = () => now;
const openGate: RecoverySourceGate = { charge: async () => true };

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .all<T>()
    ).results ?? []
  );
}
async function run(sql: string, ...params: unknown[]): Promise<void> {
  await env.DB.prepare(sql)
    .bind(...params)
    .run();
}
async function resetDatabase(): Promise<void> {
  const objects = await query<{ type: string; name: string }>(
    "SELECT type,name FROM sqlite_master WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'",
  );
  for (const item of objects)
    await env.DB.exec(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}";`);
  for (let round = 0; round < 20; round++) {
    const tables = await query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'",
    );
    if (!tables.length) break;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        /* FK next pass */
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

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,
    email_version,auth_epoch,recovery_epoch,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,0,0,?,?)`,
    id,
    ++userOrder,
    "active",
    `synthetic:${id}`,
    crypto.randomUUID(),
    new Uint8Array([1]),
    now,
    now,
  );
  return id;
}
async function seedCode(
  userId: string,
  consumedAt: number | null = null,
): Promise<{ id: string; secret: string }> {
  const id = crypto.randomUUID();
  const secret = generateSecretToken().base64url;
  await run(
    `INSERT INTO recovery_credentials
    (id,user_id,secret_hash,generation,consumed_at,saved_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?,?)`,
    id,
    userId,
    await hashRecoverySecret(secret),
    consumedAt,
    now,
    now,
    now,
  );
  return { id, secret };
}
async function seedSession(
  userId: string,
  limited = false,
): Promise<{ id: string; token: string; hash: string }> {
  const made = await makePendingSession(now);
  const user = (
    await query<{ auth_epoch: number; recovery_epoch: number }>(
      "SELECT auth_epoch,recovery_epoch FROM users WHERE id = ?",
      userId,
    )
  )[0];
  if (!user) throw new Error("missing user");
  await run(
    `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,
    absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,recovery_code_required,
    activated_at,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?)`,
    made.id,
    userId,
    made.tokenHash,
    made.label,
    made.platformHint,
    now,
    made.absoluteExpiresAt,
    Math.min(now + SESSION_IDLE_TTL * SECOND, made.absoluteExpiresAt),
    now,
    user.auth_epoch,
    user.recovery_epoch,
    limited ? 1 : 0,
    now,
    now,
    now,
  );
  return { id: made.id, token: made.cookieValue, hash: made.tokenHash };
}

async function preauth(): Promise<{ cookie: string; csrf: string; id: string; expiresAt: number }> {
  const minted = await mintPreauthCookieValue((await testKeyring).preauthCookie(), now);
  const csrf = await mintCsrfToken(
    (await testKeyring).csrf(),
    minted.context.preauthId,
    randomBytes(SECRET_BITS / 8),
  );
  return {
    cookie: minted.value,
    csrf,
    id: minted.context.preauthId,
    expiresAt: minted.context.expiresAt,
  };
}
function actionRequest(
  auth: { cookie: string; csrf: string },
  action: string,
  id: string,
  secret?: string,
  operationKey = crypto.randomUUID(),
  source = "192.0.2.123",
): Request {
  return new Request(`${SITE}/api/v2/auth/recovery`, {
    method: "POST",
    headers: {
      origin: SITE,
      "content-type": "application/json",
      "idempotency-key": operationKey,
      cookie: `__Host-preauth=${auth.cookie}; ${CSRF_COOKIE_NAME}=${auth.csrf}`,
      [CSRF_HEADER_NAME]: auth.csrf,
      "cf-connecting-ip": source,
    },
    body: JSON.stringify({ action, recovery_id: id, ...(secret === undefined ? {} : { secret }) }),
  });
}
function shell(sourceGate: RecoverySourceGate = openGate, beforeCommit?: () => Promise<void>) {
  return createApiShell({
    authenticator: sessionAuthenticator(env.DB, clock),
    csrfKey: async () => (await testKeyring).csrf(),
    routes: [
      ...makeSessionRoutes(() => testKeyring, clock),
      ...makeRecoveryRoutes({ keys: () => testKeyring, sourceGate, now: clock, beforeCommit }),
      {
        method: "GET",
        pattern: "/api/v2/me/recovery-probe",
        domain: "user",
        write: false,
        handler: async () => jsonResponse({ readable: true }),
      },
      {
        method: "POST",
        pattern: "/api/v2/me/recovery-probe",
        domain: "user",
        write: true,
        bodySchema: { fields: {} },
        csrfBinding: async ({ auth }) =>
          auth.kind === "session" && auth.domain === "user" ? auth.sessionTokenHash : "",
        handler: async () => jsonResponse({ writable: true }),
      },
    ],
  });
}
async function fetchAction(request: Request, api = shell()): Promise<Response> {
  return api.fetch(request, env as Env, fakeExecutionContext);
}
async function sessionRequest(
  path: string,
  token: string,
  method = "GET",
  body: object = {},
  api = shell(),
): Promise<Response> {
  const headers = new Headers({ cookie: `${USER_SESSION_COOKIE_NAME}=${token}` });
  if (method !== "GET") {
    const csrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      await hashSessionToken(token),
      randomBytes(SECRET_BITS / 8),
    );
    headers.set("cookie", `${USER_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`);
    headers.set(CSRF_HEADER_NAME, csrf);
    headers.set("origin", SITE);
    headers.set("content-type", "application/json");
  }
  return api.fetch(
    new Request(`${SITE}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }),
    env as Env,
    fakeExecutionContext,
  );
}
async function userEpoch(userId: string): Promise<{ auth_epoch: number; recovery_epoch: number }> {
  const row = (
    await query<{ auth_epoch: number; recovery_epoch: number }>(
      "SELECT auth_epoch,recovery_epoch FROM users WHERE id = ?",
      userId,
    )
  )[0];
  if (!row) throw new Error("missing user");
  return row;
}
function cookieValue(response: Response, name: string): string {
  const line = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!line) throw new Error(`missing ${name} cookie`);
  return line.slice(name.length + 1).split(";")[0] ?? "";
}

describe("A-P2-RECOVERY 离线恢复码", () => {
  it("紧急停用无既有会话仍成功、重复幂等、不消费码、不回私人数据且不碰灾备 epoch", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    const first = await fetchAction(actionRequest(auth, "emergency_stop", code.id, code.secret));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ stopped: true });
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 1, recovery_epoch: 0 });
    const second = await fetchAction(actionRequest(auth, "emergency_stop", code.id, code.secret));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ stopped: true });
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 1, recovery_epoch: 0 });
    expect(
      (
        await query<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recovery_credentials WHERE id = ?",
          code.id,
        )
      )[0]?.consumed_at,
    ).toBeNull();
    expect(await verifyRecoveryCredential(env.DB, code.id, code.secret)).not.toBeNull();
    const fresh = await seedSession(userId);
    expect(
      (await fetchAction(actionRequest(auth, "emergency_stop", code.id, code.secret))).status,
    ).toBe(200);
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 2, recovery_epoch: 0 });
    expect(
      (
        await sessionAuthenticator(env.DB, clock).authenticate(
          new Request(SITE, { headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${fresh.token}` } }),
          "user",
        )
      ).kind,
    ).toBe("none");
    expect(
      (await query<{ state: string }>("SELECT state FROM sessions WHERE id = ?", fresh.id))[0]
        ?.state,
    ).toBe("revoked");
    const recovered = await fetchAction(actionRequest(auth, "recover_login", code.id, code.secret));
    expect(recovered.status).toBe(200);
    expect(
      (
        await query<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recovery_credentials WHERE id = ?",
          code.id,
        )
      )[0]?.consumed_at,
    ).toBe(now);
  });

  it("紧急停用输给并发新会话时不谎报成功；重试会撤销新会话", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    let newSession: Awaited<ReturnType<typeof seedSession>> | undefined;
    await expect(
      runRecoveryAction(
        {
          db: env.DB,
          keys: await testKeyring,
          sourceGate: openGate,
          now: clock,
          beforeCommit: async () => {
            await run("UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?", userId);
            newSession = await seedSession(userId);
          },
        },
        {
          request: actionRequest(auth, "emergency_stop", code.id, code.secret),
          action: "emergency_stop",
          recoveryId: code.id,
          secret: code.secret,
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 1, recovery_epoch: 0 });
    const retried = await fetchAction(actionRequest(auth, "emergency_stop", code.id, code.secret));
    expect(retried.status).toBe(200);
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 2, recovery_epoch: 0 });
    expect(
      (await query<{ state: string }>("SELECT state FROM sessions WHERE id = ?", newSession?.id))[0]
        ?.state,
    ).toBe("revoked");
  });

  it("紧急停用不计普通修改日额，且安全暂停可在同批接入通道效果", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    const day = utcDayPeriod(now).key;
    const counterKeys = mutationCounterKeys(userId, day);
    await run(
      "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?,?,0,?)",
      counterKeys.userKey,
      USER_MUTATIONS_DAY,
      now,
    );
    await run(
      "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?,?,0,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      counterKeys.globalKey,
      GLOBAL_MUTATIONS_DAY,
      now,
    );
    const effectKey = `synthetic:pause:${userId}`;
    await run(
      "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?,0,0,?)",
      effectKey,
      now,
    );
    const hooks = [
      async () => [
        {
          kind: "update" as const,
          table: "capacity_state",
          set: { value: { sql: "value + 1" } },
          where: { sql: "key = ?", params: [effectKey] },
        },
      ],
    ];
    const result = await runRecoveryAction(
      { db: env.DB, keys: await testKeyring, sourceGate: openGate, now: clock, pauseHooks: hooks },
      {
        request: actionRequest(auth, "emergency_stop", code.id, code.secret),
        action: "emergency_stop",
        recoveryId: code.id,
        secret: code.secret,
      },
    );
    expect(result.status).toBe(200);
    expect(
      (
        await query<{ value: number }>("SELECT value FROM capacity_state WHERE key = ?", effectKey)
      )[0]?.value,
    ).toBe(1);
  });

  it("恢复登录真并发最多一次消费，原 preauth+操作键回执可补领并激活受限会话", async () => {
    const userId = await seedUser();
    const previous = await seedSession(userId);
    const code = await seedCode(userId);
    const auth = await preauth();
    const operationKey = crypto.randomUUID();
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
    const deps = {
      db: env.DB,
      keys: await testKeyring,
      sourceGate: openGate,
      now: clock,
      beforeCommit,
    };
    const request = () => actionRequest(auth, "recover_login", code.id, code.secret, operationKey);
    const attempts = await Promise.allSettled([
      runRecoveryAction(deps, {
        request: request(),
        action: "recover_login",
        recoveryId: code.id,
        secret: code.secret,
      }),
      runRecoveryAction(deps, {
        request: request(),
        action: "recover_login",
        recoveryId: code.id,
        secret: code.secret,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const loser = attempts.find((attempt) => attempt.status === "rejected");
    expect(
      loser?.status === "rejected" &&
        loser.reason instanceof ApiError &&
        loser.reason.code === "unauthorized",
    ).toBe(true);
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 1, recovery_epoch: 0 });
    expect(
      await query(
        "SELECT id FROM auth_challenges WHERE purpose = 'recovery' AND preauth_id = ?",
        auth.id,
      ),
    ).toHaveLength(1);
    const pending = await query<{
      id: string;
      recovery_code_required: number;
      state: string;
      auth_epoch: number;
    }>(
      "SELECT id,recovery_code_required,state,auth_epoch FROM sessions WHERE user_id = ? AND auth_epoch = 1",
      userId,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      recovery_code_required: 1,
      state: "pending",
      auth_epoch: 1,
    });
    expect(
      (
        await sessionAuthenticator(env.DB, clock).authenticate(
          new Request(SITE, {
            headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${previous.token}` },
          }),
          "user",
        )
      ).kind,
    ).toBe("none");
    expect(
      (await query<{ state: string }>("SELECT state FROM sessions WHERE id = ?", previous.id))[0]
        ?.state,
    ).toBe("revoked");
    const completion = await runCompleteAuth(
      { db: env.DB, keys: await testKeyring, now: clock },
      new Request(`${SITE}/api/v2/auth/complete`, {
        headers: {
          cookie: `__Host-preauth=${auth.cookie}`,
          "idempotency-key": operationKey,
        },
      }),
    );
    expect(completion.status).toBe(200);
    const recoveredToken = cookieValue(completion, USER_SESSION_COOKIE_NAME);
    expect(await hashSessionToken(recoveredToken)).toBe(
      (
        await query<{ token_hash: string }>(
          "SELECT token_hash FROM sessions WHERE id = ?",
          pending[0]?.id,
        )
      )[0]?.token_hash,
    );
    const api = shell();
    expect(
      (await sessionRequest("/api/v2/me/sessions", recoveredToken, "GET", {}, api)).status,
    ).toBe(200);
    const activated = await sessionRequest(
      "/api/v2/auth/activate",
      recoveredToken,
      "POST",
      {},
      api,
    );
    expect(activated.status).toBe(200);
    expect(
      (
        await query<{ receipt_ciphertext: ArrayBuffer | null }>(
          "SELECT receipt_ciphertext FROM auth_challenges WHERE pending_session_id = ?",
          pending[0]?.id,
        )
      )[0]?.receipt_ciphertext,
    ).toBeNull();
    expect(
      (await sessionRequest("/api/v2/me/recovery-probe", recoveredToken, "GET", {}, api)).status,
    ).toBe(200);
    const denied = await sessionRequest(
      "/api/v2/me/recovery-probe",
      recoveredToken,
      "POST",
      {},
      api,
    );
    expect(denied.status).toBe(401);
    expect((await denied.json()) as object).toMatchObject({
      error: { details: { reason: "recovery_code_unconfirmed" } },
    });
    const generated = await sessionRequest(
      "/api/v2/auth/recovery/code",
      recoveredToken,
      "POST",
      { action: "generate" },
      api,
    );
    expect(generated.status).toBe(200);
    const newCode = (await generated.json()) as { recovery_id: string; secret: string };
    expect(await currentRecoveryCodeSaved(env.DB, userId)).toBe(false);
    const confirmed = await sessionRequest(
      "/api/v2/auth/recovery/code",
      recoveredToken,
      "POST",
      { action: "confirm", recovery_id: newCode.recovery_id, secret: newCode.secret },
      api,
    );
    expect(confirmed.status).toBe(200);
    expect(await currentRecoveryCodeSaved(env.DB, userId)).toBe(true);
    expect(
      (await sessionRequest("/api/v2/me/recovery-probe", recoveredToken, "POST", {}, api)).status,
    ).toBe(200);
  });

  it("首次码仅显示一次；未确认可作废重生，确认后不能由本端点轮换", async () => {
    const userId = await seedUser();
    const session = await seedSession(userId);
    const api = shell();
    const first = await sessionRequest(
      "/api/v2/auth/recovery/code",
      session.token,
      "POST",
      { action: "generate" },
      api,
    );
    expect(first.status).toBe(200);
    const firstCode = (await first.json()) as { recovery_id: string; secret: string };
    expect((fromBase64Url(firstCode.secret)?.byteLength ?? 0) * 8).toBeGreaterThanOrEqual(
      SECRET_BITS,
    );
    const status = await sessionRequest(
      "/api/v2/auth/recovery/code",
      session.token,
      "GET",
      {},
      api,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ has_current_code: true, saved_confirmed: false });
    const second = await sessionRequest(
      "/api/v2/auth/recovery/code",
      session.token,
      "POST",
      { action: "generate" },
      api,
    );
    expect(second.status).toBe(200);
    const secondCode = (await second.json()) as { recovery_id: string; secret: string };
    expect(secondCode.recovery_id).not.toBe(firstCode.recovery_id);
    expect(secondCode.secret).not.toBe(firstCode.secret);
    expect(
      await verifyRecoveryCredential(env.DB, firstCode.recovery_id, firstCode.secret),
    ).toBeNull();
    expect(
      (
        await sessionRequest(
          "/api/v2/auth/recovery/code",
          session.token,
          "POST",
          { action: "confirm", recovery_id: secondCode.recovery_id, secret: secondCode.secret },
          api,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await sessionRequest(
          "/api/v2/auth/recovery/code",
          session.token,
          "POST",
          { action: "generate" },
          api,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await query<{ secret_hash: string }>(
          "SELECT secret_hash FROM recovery_credentials WHERE id = ?",
          secondCode.recovery_id,
        )
      )[0]?.secret_hash,
    ).toBe(await hashRecoverySecret(secondCode.secret));
  });

  it("只交 ID、错误秘密、已消费码和未知 ID 返回完全同形的 401；交替计时采样", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const consumedUser = await seedUser();
    const consumed = await seedCode(consumedUser, now);
    const auth = await preauth();
    const api = shell();
    const cases = [
      { id: code.id, secret: undefined },
      { id: code.id, secret: generateSecretToken().base64url },
      { id: consumed.id, secret: consumed.secret },
      { id: crypto.randomUUID(), secret: generateSecretToken().base64url },
    ];
    const bodies: string[] = [];
    for (const action of ["emergency_stop", "recover_login"] as const) {
      for (const input of cases) {
        const response = await fetchAction(
          actionRequest(auth, action, input.id, input.secret),
          api,
        );
        expect(response.status).toBe(401);
        bodies.push(await response.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    const samples = cases.map(() => [] as number[]);
    for (let round = 0; round < 15; round++) {
      for (let index = 0; index < cases.length; index++) {
        const input = cases[index];
        if (!input) throw new Error("missing timing case");
        const start = performance.now();
        for (let sample = 0; sample < 50; sample++) {
          await verifyRecoveryCredential(env.DB, input.id, input.secret ?? "");
        }
        samples[index]?.push(performance.now() - start);
      }
    }
    const medians = samples.map(
      (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0,
    );
    expect(Math.max(...medians) / Math.min(...medians), JSON.stringify(medians)).toBeLessThan(2.5);
  });

  it("按 recovery_id 精确小时/日双窗及来源近似双窗限速；D1 不存 IP 原文", async () => {
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++) {
      expect(await chargeRecoveryId(env.DB, id, now)).toBe(true);
    }
    expect(await chargeRecoveryId(env.DB, id, now)).toBe(false);
    const firstHour = now;
    for (let hour = 1; hour < RECOVERY_ATTEMPTS_DAY / RECOVERY_ATTEMPTS_HOUR; hour++) {
      now = firstHour + hour * 60 * 60 * SECOND;
      for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++) {
        expect(await chargeRecoveryId(env.DB, id, now)).toBe(true);
      }
    }
    now = firstHour + 3 * 60 * 60 * SECOND;
    expect(await chargeRecoveryId(env.DB, id, now)).toBe(false);
    expect(
      await chargeRecoveryId(env.DB, id, utcDayPeriod(firstHour).endMsExclusive + SECOND),
    ).toBe(true);
    const gate = new InMemoryRecoverySourceGate();
    const one = new Request(SITE, { headers: { "cf-connecting-ip": "192.0.2.44" } });
    const two = new Request(SITE, { headers: { "cf-connecting-ip": "198.51.100.33" } });
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++)
      expect(await gate.charge(one, now)).toBe(true);
    expect(await gate.charge(one, now)).toBe(false);
    expect(await gate.charge(two, now)).toBe(true);
    for (let hour = 1; hour < RECOVERY_ATTEMPTS_DAY / RECOVERY_ATTEMPTS_HOUR; hour++) {
      const later = now + hour * 60 * 60 * SECOND;
      for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++) {
        expect(await gate.charge(one, later)).toBe(true);
      }
    }
    expect(await gate.charge(one, now + 3 * 60 * 60 * SECOND)).toBe(false);
    expect(await gate.charge(one, utcDayPeriod(firstHour).endMsExclusive + SECOND)).toBe(true);
    expect(JSON.stringify(await query("SELECT * FROM recovery_attempt_windows"))).not.toContain(
      "192.0.2.44",
    );
    now = firstHour;
  });

  it("恢复端点将 recovery_id 限额耗尽折叠为统一稍后重试，来源闸门独立生效", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    const wrong = generateSecretToken().base64url;
    const api = shell();
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++) {
      expect(
        (await fetchAction(actionRequest(auth, "emergency_stop", code.id, wrong), api)).status,
      ).toBe(401);
    }
    const limited = await fetchAction(actionRequest(auth, "emergency_stop", code.id, wrong), api);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    const sourceGate = new InMemoryRecoverySourceGate();
    const sourceApi = shell(sourceGate);
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS_HOUR; attempt++) {
      expect(
        (
          await fetchAction(
            actionRequest(auth, "emergency_stop", crypto.randomUUID(), wrong),
            sourceApi,
          )
        ).status,
      ).toBe(401);
    }
    const sourceLimited = await fetchAction(
      actionRequest(auth, "emergency_stop", crypto.randomUUID(), wrong),
      sourceApi,
    );
    expect(sourceLimited.status).toBe(429);
    expect(await sourceLimited.json()).toEqual(
      await (async () => {
        const fresh = await fetchAction(actionRequest(auth, "emergency_stop", code.id, wrong), api);
        return fresh.json();
      })(),
    );
  });

  it("恢复动作要求有效 preauth 与绑定 CSRF；邮件认证日池已满仍可恢复登录", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    const day = utcDayPeriod(now);
    await run(
      `INSERT INTO usage_periods
      (id,pool,period_kind,period_key,user_id,reserved,settled,uncertain,period_start,period_end,created_at,updated_at)
      VALUES (?,'existing_auth','utc_day',?,NULL,0,?,0,?,?,?,?)`,
      crypto.randomUUID(),
      day.key,
      MAIL_AUTH_DAY,
      day.startMs,
      day.endMsExclusive,
      now,
      now,
    );
    const missingCsrf = actionRequest(auth, "recover_login", code.id, code.secret);
    missingCsrf.headers.delete(CSRF_HEADER_NAME);
    expect((await fetchAction(missingCsrf)).status).toBe(401);
    const invalidPreauth = actionRequest(auth, "recover_login", code.id, code.secret);
    const parts = auth.cookie.split(".");
    const mac = parts[3] ?? "";
    parts[3] = `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    invalidPreauth.headers.set(
      "cookie",
      `__Host-preauth=${parts.join(".")}; ${CSRF_COOKIE_NAME}=${auth.csrf}`,
    );
    expect((await fetchAction(invalidPreauth)).status).toBe(401);
    const response = await fetchAction(actionRequest(auth, "recover_login", code.id, code.secret));
    expect(response.status).toBe(200);
    expect(
      (
        await query<{ settled: number }>(
          "SELECT settled FROM usage_periods WHERE pool = 'existing_auth' AND period_key = ?",
          day.key,
        )
      )[0]?.settled,
    ).toBe(MAIL_AUTH_DAY);
    expect(await userEpoch(userId)).toEqual({ auth_epoch: 1, recovery_epoch: 0 });
  });

  it("预认证余量不足先续期，恢复码未消费；入口无需发信预算", async () => {
    const userId = await seedUser();
    const code = await seedCode(userId);
    const auth = await preauth();
    const original = now;
    now = auth.expiresAt - (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * SECOND + 1;
    const renewal = await fetchAction(actionRequest(auth, "recover_login", code.id, code.secret));
    expect(renewal.status).toBe(409);
    expect(await renewal.json()).toEqual({ completed: false, preauth_renewal_required: true });
    expect(
      (
        await query<{ consumed_at: number | null }>(
          "SELECT consumed_at FROM recovery_credentials WHERE id = ?",
          code.id,
        )
      )[0]?.consumed_at,
    ).toBeNull();
    expect(cookieValue(renewal, "__Host-preauth")).not.toBe(auth.cookie);
    now = original;
  });

  it("受限恢复会话仍可登出", async () => {
    const userId = await seedUser();
    const session = await seedSession(userId, true);
    const response = await sessionRequest("/api/v2/auth/logout", session.token, "POST");
    expect(response.status).toBe(200);
    expect(
      (await query<{ state: string }>("SELECT state FROM sessions WHERE id = ?", session.id))[0]
        ?.state,
    ).toBe("revoked");
  });
});
