// A-P2-SESSION · P2-04 会话生命周期：真实 Miniflare D1、外壳权限与真实并发 CAS。
// 返工契约测试使用 P2-03 的真实 pending 产物与完成回执，避免两侧散列漂移。
// 合成身份和 token 只在本文件内生成；没有真实邮箱、Cookie 或恢复码样本。

import { env } from "cloudflare:test";
import {
  mutationCounterKeys,
  SESSION_ABSOLUTE_JITTER,
  SESSION_ABSOLUTE_TTL,
  SESSION_ACTIVE_MAX,
  SESSION_EXPIRY_NOTICE,
  SESSION_IDLE_TTL,
  SESSION_PENDING_TTL,
  SESSION_RENEW_INTERVAL,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, jsonResponse } from "../../shell";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { fakeExecutionContext, testKeyring } from "../../shell/test-support";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { runCompleteAuth } from "../consume/complete";
import { encryptCompletionReceipt } from "../consume/receipt";
import { hashSessionToken, makePendingSession } from "../consume/session";
import { mintPreauthCookieValue } from "../preauth/cookie";
import { sessionAuthenticator } from "./authenticator";
import {
  activateSession,
  cleanupExpiredPendingSessions,
  coarsePlatform,
  parseSelectedSessionIds,
  renewSession,
} from "./lifecycle";
import { makeSessionRoutes } from "./routes";

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
const T0 = utcDayPeriod(1_900_000_000_000).startMs + SECOND;
let now = T0;
let userOrder = 0;
const site = "https://app.test";

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
    "SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'",
  );
  for (const item of objects)
    await env.DB.exec(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}";`);
  for (let round = 0; round < 20; round++) {
    const tables = await query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'",
    );
    if (tables.length === 0) break;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        /* FK 下一轮 */
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

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  userOrder += 1;
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,
      email_version,auth_epoch,recovery_epoch,created_at,updated_at)
     VALUES (?,?,?,?,?,?,1,0,0,?,?)`,
    id,
    userOrder,
    "active",
    `synthetic:${id}`,
    crypto.randomUUID(),
    new Uint8Array([1]),
    now,
    now,
  );
  return id;
}

interface SeededSession {
  id: string;
  token: string;
  tokenHash: string;
  challengeId?: string;
  preauthCookie?: string;
  operationKey?: string;
}

async function seedSession(
  userId: string,
  state: "pending" | "active",
  options: {
    createdAt?: number;
    absoluteExpiresAt?: number;
    expiresAt?: number;
    renewedAt?: number;
    realReceipt?: boolean;
  } = {},
): Promise<SeededSession> {
  const id = crypto.randomUUID();
  const token = generateSecretToken().base64url;
  const tokenHash = await hashSessionToken(token);
  const createdAt = options.createdAt ?? now;
  const absoluteExpiresAt = options.absoluteExpiresAt ?? createdAt + SESSION_ABSOLUTE_TTL * SECOND;
  const expiresAt =
    options.expiresAt ??
    Math.min(
      now + (state === "pending" ? SESSION_PENDING_TTL : SESSION_IDLE_TTL) * SECOND,
      absoluteExpiresAt,
    );
  await run(
    `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,
      absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,activated_at,
      created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    id,
    userId,
    tokenHash,
    state,
    `${new Date(createdAt).toISOString()} · 未知`,
    "unknown",
    createdAt,
    absoluteExpiresAt,
    expiresAt,
    options.renewedAt ?? createdAt,
    state === "active" ? createdAt : null,
    createdAt,
    createdAt,
  );
  if (state === "active") return { id, token, tokenHash };
  const challengeId = crypto.randomUUID();
  const operationKey = `synthetic-${crypto.randomUUID()}`;
  const preauth = await mintPreauthCookieValue((await testKeyring).preauthCookie(), now);
  const ciphertext = options.realReceipt
    ? await encryptCompletionReceipt((await testKeyring).fieldEncryption(), challengeId, {
        preauthId: preauth.context.preauthId,
        operationKey,
        pendingSessionId: id,
        cookieValue: token,
      })
    : new Uint8Array([1]);
  await run(
    `INSERT INTO auth_challenges (id,purpose,email_key,address_version,preauth_id,
      idempotency_key,mac,generation,attempts,deadline,consumed_at,receipt_ciphertext,
      receipt_expires_at,pending_session_id,created_at,updated_at)
      VALUES (?,'login',?,1,?,?,?,0,0,?,?,?,?,?,?,?)`,
    challengeId,
    `synthetic:${userId}`,
    preauth.context.preauthId,
    operationKey,
    `synthetic:${challengeId}`,
    now + SESSION_PENDING_TTL * SECOND,
    now,
    ciphertext,
    now + SESSION_PENDING_TTL * SECOND,
    id,
    now,
    now,
  );
  return { id, token, tokenHash, challengeId, preauthCookie: preauth.value, operationKey };
}

function shell(beforeActivationCommit?: () => Promise<void>) {
  return createApiShell({
    authenticator: sessionAuthenticator(env.DB, () => now),
    csrfKey: async () => (await testKeyring).csrf(),
    routes: [
      ...makeSessionRoutes(
        () => testKeyring,
        () => now,
        beforeActivationCommit,
      ),
      {
        method: "GET",
        pattern: "/api/v2/me/probe",
        domain: "user",
        write: false,
        handler: async () => jsonResponse({ ok: true }),
      } as const,
    ],
    feedHandler: async () => new Response("synthetic feed"),
  });
}

async function fetchRoute(
  path: string,
  token: string,
  method = "GET",
  body?: object,
  csrf?: string,
  userAgent?: string,
  api: ReturnType<typeof shell> = shell(),
): Promise<Response> {
  const headers = new Headers({ cookie: `${USER_SESSION_COOKIE_NAME}=${token}` });
  if (userAgent !== undefined) headers.set("user-agent", userAgent);
  if (method !== "GET") {
    headers.set("content-type", "application/json");
    headers.set("origin", site);
    if (csrf !== undefined) {
      headers.set("cookie", `${USER_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`);
      headers.set(CSRF_HEADER_NAME, csrf);
    }
  }
  return api.fetch(
    new Request(`${site}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }),
    env as Env,
    fakeExecutionContext,
  );
}

async function csrfFor(token: string): Promise<string> {
  const response = await fetchRoute("/api/v2/me/sessions", token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

async function sessionRow(id: string): Promise<Record<string, unknown>> {
  const row = (await query<Record<string, unknown>>("SELECT * FROM sessions WHERE id = ?", id))[0];
  expect(row).toBeDefined();
  return row;
}

describe("A-P2-SESSION 会话生命周期", () => {
  it("A-P2-SESSION 同时创建的 pending 绝对期限分布在抖动范围内，不集中于同一时刻", async () => {
    const sessions = await Promise.all(Array.from({ length: 64 }, () => makePendingSession(T0)));
    const deadlines = sessions.map((session) => session.absoluteExpiresAt);
    for (const deadline of deadlines) {
      expect(deadline).toBeGreaterThanOrEqual(
        T0 + (SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER) * SECOND,
      );
      expect(deadline).toBeLessThanOrEqual(
        T0 + (SESSION_ABSOLUTE_TTL + SESSION_ABSOLUTE_JITTER) * SECOND,
      );
    }
    expect(Math.max(...deadlines) - Math.min(...deadlines)).toBeGreaterThan(
      SESSION_ABSOLUTE_JITTER * SECOND,
    );
  });

  it("A-P2-SESSION P2-03 pending 行与完成回执签发的 Cookie 可由 P2-04 鉴权", async () => {
    now = T0;
    const userId = await seedUser();
    const pending = await makePendingSession(now);
    const challengeId = crypto.randomUUID();
    const operationKey = `synthetic-${crypto.randomUUID()}`;
    const preauth = await mintPreauthCookieValue((await testKeyring).preauthCookie(), now);
    await run(
      `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,
        absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,activated_at,
        created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
      pending.id,
      userId,
      pending.tokenHash,
      "pending",
      pending.label,
      pending.platformHint,
      pending.issuedAt,
      pending.absoluteExpiresAt,
      pending.expiresAt,
      pending.issuedAt,
      null,
      pending.issuedAt,
      pending.issuedAt,
    );
    const ciphertext = await encryptCompletionReceipt(
      (await testKeyring).fieldEncryption(),
      challengeId,
      {
        preauthId: preauth.context.preauthId,
        operationKey,
        pendingSessionId: pending.id,
        cookieValue: pending.cookieValue,
      },
    );
    await run(
      `INSERT INTO auth_challenges (id,purpose,email_key,address_version,preauth_id,
        idempotency_key,mac,generation,attempts,deadline,consumed_at,receipt_ciphertext,
        receipt_expires_at,pending_session_id,created_at,updated_at)
        VALUES (?,'login',?,1,?,?,?,0,0,?,?,?,?,?,?,?)`,
      challengeId,
      `synthetic:${userId}`,
      preauth.context.preauthId,
      operationKey,
      `synthetic:${challengeId}`,
      now + SESSION_PENDING_TTL * SECOND,
      now,
      ciphertext,
      now + SESSION_PENDING_TTL * SECOND,
      pending.id,
      now,
      now,
    );
    const complete = await runCompleteAuth(
      { db: env.DB, keys: await testKeyring, now: () => now },
      new Request(`${site}/api/v2/auth/complete`, {
        headers: {
          cookie: `__Host-preauth=${preauth.value}`,
          "idempotency-key": operationKey,
        },
      }),
    );
    const sessionCookie = complete.headers.get("set-cookie")?.split(";")[0];
    expect(sessionCookie).toMatch(/^__Host-session=/);
    const list = await shell().fetch(
      new Request(`${site}/api/v2/me/sessions`, {
        headers: { cookie: sessionCookie ?? "" },
      }),
      env as Env,
      fakeExecutionContext,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toContainEqual(
      expect.objectContaining({ id: pending.id, is_current: true, state: "pending" }),
    );
  });

  it("A-P2-SESSION pending 只访问脱敏设备列表与激活；激活请求需要会话绑定 CSRF，完成回执立即清除", async () => {
    now = T0;
    const userId = await seedUser();
    const pending = await seedSession(userId, "pending", { realReceipt: true });
    expect(USER_SESSION_COOKIE_NAME).toBe("__Host-session");
    expect((await fetchRoute("/api/v2/me/probe", pending.token)).status).toBe(401);
    for (const path of ["/api/v2/auth/renew", "/api/v2/auth/logout"]) {
      expect((await fetchRoute(path, pending.token, "POST", {})).status).toBe(401);
    }
    expect(
      (await fetchRoute(`/api/v2/me/sessions/${pending.id}`, pending.token, "DELETE", {})).status,
    ).toBe(401);
    const list = await fetchRoute("/api/v2/me/sessions", pending.token);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      sessions: Array<Record<string, unknown>>;
      csrf_token: string;
    };
    expect(body.sessions[0]).toMatchObject({ id: pending.id, state: "pending", is_current: true });
    expect(JSON.stringify(body)).not.toContain(pending.tokenHash);
    expect(JSON.stringify(body)).not.toContain(pending.token);
    const noCsrf = await fetchRoute("/api/v2/auth/activate", pending.token, "POST", {});
    expect(noCsrf.status).toBe(401);
    const otherPending = await seedSession(userId, "pending");
    const wrongBinding = await fetchRoute(
      "/api/v2/auth/activate",
      otherPending.token,
      "POST",
      {},
      body.csrf_token,
    );
    expect(wrongBinding.status).toBe(401);
    expect((await sessionRow(otherPending.id)).state).toBe("pending");
    expect((await sessionRow(pending.id)).state).toBe("pending");
    const before = await runCompleteAuth(
      { db: env.DB, keys: await testKeyring, now: () => now },
      new Request(`${site}/api/v2/auth/complete`, {
        headers: {
          cookie: `__Host-preauth=${pending.preauthCookie}`,
          "idempotency-key": pending.operationKey ?? "",
        },
      }),
    );
    expect(before.headers.get("set-cookie")).toContain("__Host-session=");
    const activated = await fetchRoute(
      "/api/v2/auth/activate",
      pending.token,
      "POST",
      {},
      body.csrf_token,
    );
    expect(activated.status).toBe(200);
    expect((await sessionRow(pending.id)).state).toBe("active");
    expect(
      (
        await query<{ receipt_ciphertext: ArrayBuffer | null }>(
          "SELECT receipt_ciphertext FROM auth_challenges WHERE id = ?",
          pending.challengeId,
        )
      )[0].receipt_ciphertext,
    ).toBeNull();
    await expect(
      runCompleteAuth(
        { db: env.DB, keys: await testKeyring, now: () => now },
        new Request(`${site}/api/v2/auth/complete`, {
          headers: {
            cookie: `__Host-preauth=${pending.preauthCookie}`,
            "idempotency-key": pending.operationKey ?? "",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect((await fetchRoute("/api/v2/me/probe", pending.token)).status).toBe(200);
  });

  it("A-P2-SESSION 满额不自动淘汰；Cookie 未交付的 pending 孤儿不占名额，用户选择后原子激活", async () => {
    now = T0;
    const userId = await seedUser();
    const active = await Promise.all(
      Array.from({ length: SESSION_ACTIVE_MAX }, () => seedSession(userId, "active")),
    );
    const orphan = await seedSession(userId, "pending");
    const current = await seedSession(userId, "pending");
    const csrf = await csrfFor(current.token);
    const full = await fetchRoute("/api/v2/auth/activate", current.token, "POST", {}, csrf);
    expect(full.status).toBe(409);
    const fullBody = (await full.json()) as {
      sessions: Array<Record<string, unknown>>;
      selection_required: boolean;
    };
    expect(fullBody.selection_required).toBe(true);
    expect(fullBody.sessions).toHaveLength(SESSION_ACTIVE_MAX + 2);
    expect(JSON.stringify(fullBody)).not.toContain(active[0].tokenHash);
    expect((await sessionRow(active[0].id)).state).toBe("active");
    expect((await sessionRow(orphan.id)).state).toBe("pending");
    expect((await sessionRow(current.id)).state).toBe("pending");
    const selected = await fetchRoute(
      "/api/v2/auth/activate",
      current.token,
      "POST",
      {
        revoke_session_ids: active[1].id,
        label: "我的电脑",
      },
      csrf,
    );
    expect(selected.status).toBe(200);
    expect((await sessionRow(active[1].id)).state).toBe("revoked");
    expect((await sessionRow(active[0].id)).state).toBe("active");
    expect((await sessionRow(current.id)).state).toBe("active");
    expect((await sessionRow(current.id)).label).toBe("我的电脑");
    expect((await sessionRow(orphan.id)).state).toBe("pending");
  });

  it("A-P2-SESSION 未满额时同一 pending 并发激活均返回 200，active 只增加一次", async () => {
    now = T0;
    const userId = await seedUser();
    const other = await seedSession(userId, "active");
    const pending = await seedSession(userId, "pending");
    const csrf = await csrfFor(pending.token);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = shell(async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    });
    const responses = await Promise.all([
      fetchRoute("/api/v2/auth/activate", pending.token, "POST", {}, csrf, undefined, api),
      fetchRoute("/api/v2/auth/activate", pending.token, "POST", {}, csrf, undefined, api),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    for (const response of responses) {
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ activated: true, csrf_token: expect.any(String) });
      expect(body).not.toHaveProperty("selection_required");
      expect(response.headers.get("set-cookie")).toContain(`${USER_SESSION_COOKIE_NAME}=`);
    }
    expect((await sessionRow(other.id)).state).toBe("active");
    expect((await sessionRow(pending.id)).state).toBe("active");
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*) AS n FROM sessions WHERE user_id = ? AND state = 'active'",
          userId,
        )
      )[0].n,
    ).toBe(2);
  });

  it("A-P2-SESSION 已激活会话重试忽略标签与撤销选择，且不写 D1", async () => {
    now = T0;
    const userId = await seedUser();
    const sibling = await seedSession(userId, "active");
    const pending = await seedSession(userId, "pending");
    const csrf = await csrfFor(pending.token);
    expect(
      (await fetchRoute("/api/v2/auth/activate", pending.token, "POST", {}, csrf)).status,
    ).toBe(200);
    const before = await sessionRow(pending.id);
    const retry = await fetchRoute(
      "/api/v2/auth/activate",
      pending.token,
      "POST",
      { label: " ", revoke_session_ids: sibling.id },
      csrf,
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ activated: true, csrf_token: expect.any(String) });
    expect(retry.headers.get("set-cookie")).toContain(`${USER_SESSION_COOKIE_NAME}=`);
    expect(await sessionRow(pending.id)).toEqual(before);
    expect((await sessionRow(sibling.id)).state).toBe("active");
  });

  it("A-P2-SESSION 激活过程中当前会话失效只返回 401", async () => {
    now = T0;
    for (const invalidate of ["expired", "revoked", "epoch", "receipt"] as const) {
      const userId = await seedUser();
      const pending = await seedSession(userId, "pending");
      const csrf = await csrfFor(pending.token);
      const api = shell(async () => {
        switch (invalidate) {
          case "expired":
            await run("UPDATE sessions SET expires_at = ? WHERE id = ?", now, pending.id);
            break;
          case "revoked":
            await run(
              "UPDATE sessions SET state = 'revoked', revoked_at = ?, revoke_reason = 'user_revoke' WHERE id = ?",
              now,
              pending.id,
            );
            break;
          case "epoch":
            await run("UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?", userId);
            break;
          case "receipt":
            await run(
              "UPDATE auth_challenges SET receipt_ciphertext = NULL, receipt_expires_at = NULL WHERE id = ?",
              pending.challengeId,
            );
            break;
        }
      });
      const response = await fetchRoute(
        "/api/v2/auth/activate",
        pending.token,
        "POST",
        {},
        csrf,
        undefined,
        api,
      );
      expect(response.status, invalidate).toBe(401);
      expect(await response.json()).not.toHaveProperty("selection_required");
    }
  });

  it("A-P2-SESSION 两个 pending 真并发争最后 active 名额，至多一个提交", async () => {
    now = T0;
    const userId = await seedUser();
    await Promise.all(
      Array.from({ length: SESSION_ACTIVE_MAX - 1 }, () => seedSession(userId, "active")),
    );
    const contenders = await Promise.all([
      seedSession(userId, "pending"),
      seedSession(userId, "pending"),
    ]);
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
    const results = await Promise.all(
      contenders.map((pending) =>
        activateSession({
          db: env.DB,
          userId,
          sessionId: pending.id,
          selectedIds: [],
          platform: "unknown",
          now,
          beforeCommit,
        }),
      ),
    );
    expect(results.sort()).toEqual(["activated", "conflict"]);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*) AS n FROM sessions WHERE user_id = ? AND state = 'active'",
          userId,
        )
      )[0].n,
    ).toBe(SESSION_ACTIVE_MAX);
  });

  it("A-P2-SESSION 鉴权零写入：页面加载、被动 GET、设备列表与 Feed 拉取均不改变期限", async () => {
    now = T0;
    const userId = await seedUser();
    const active = await seedSession(userId, "active");
    const before = await sessionRow(active.id);
    expect((await fetchRoute("/api/v2/me/probe", active.token)).status).toBe(200);
    expect((await fetchRoute("/api/v2/me/sessions", active.token)).status).toBe(200);
    expect((await fetchRoute("/feeds/u/synthetic.ics", active.token)).status).toBe(200);
    const worker = await import("../../index");
    expect(
      (
        await worker.default.fetch(
          new Request(`${site}/`, {
            headers: {
              cookie: `${USER_SESSION_COOKIE_NAME}=${active.token}`,
            },
          }),
          env as Env,
          fakeExecutionContext,
        )
      ).status,
    ).toBe(200);
    const after = await sessionRow(active.id);
    expect(after).toEqual(before);
  });

  it("A-P2-SESSION users 的 auth_epoch / recovery_epoch 或状态改变，下一个请求即失效", async () => {
    now = T0;
    for (const field of ["auth_epoch", "recovery_epoch", "status"] as const) {
      const userId = await seedUser();
      const active = await seedSession(userId, "active");
      expect((await fetchRoute("/api/v2/me/probe", active.token)).status).toBe(200);
      await run(
        `UPDATE users SET ${field} = ? WHERE id = ?`,
        field === "status" ? "deleting" : 1,
        userId,
      );
      expect((await fetchRoute("/api/v2/me/probe", active.token)).status).toBe(401);
      expect(await renewSession(env.DB, userId, active.id, now)).toBeNull();
    }
  });

  it("A-P2-SESSION 状态、空闲期限与绝对期限逐项检查，过期会话下一请求即拒绝", async () => {
    now = T0;
    const userId = await seedUser();
    const idleExpired = await seedSession(userId, "active", { expiresAt: now + 1 });
    const absoluteExpired = await seedSession(userId, "active", {
      absoluteExpiresAt: now + 1,
      expiresAt: now + 1,
    });
    const pendingExpired = await seedSession(userId, "pending", { expiresAt: now + 1 });
    const revoked = await seedSession(userId, "active");
    await run(
      "UPDATE sessions SET state = 'revoked', revoked_at = ? WHERE id = ?",
      now,
      revoked.id,
    );
    now += 2;
    for (const session of [idleExpired, absoluteExpired, pendingExpired, revoked]) {
      expect((await fetchRoute("/api/v2/me/sessions", session.token)).status).toBe(401);
    }
  });

  it("A-P2-SESSION 续期间隔内不更新，超过间隔才续期且不突破创建时绝对期限", async () => {
    now = T0;
    const userId = await seedUser();
    const absolute = now + SESSION_RENEW_INTERVAL * SECOND * 2;
    const active = await seedSession(userId, "active", {
      createdAt: now - (SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER) * SECOND,
      absoluteExpiresAt: absolute,
      expiresAt: absolute,
      renewedAt: now - SESSION_RENEW_INTERVAL * SECOND + 1,
    });
    const original = await sessionRow(active.id);
    const csrf = await csrfFor(active.token);
    const early = await fetchRoute("/api/v2/auth/renew", active.token, "POST", {}, csrf);
    expect(early.status).toBe(200);
    expect(((await early.json()) as { renewed: boolean }).renewed).toBe(false);
    expect(await sessionRow(active.id)).toEqual(original);
    now += 1;
    const renewed = await fetchRoute("/api/v2/auth/renew", active.token, "POST", {}, csrf);
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { renewed: boolean }).renewed).toBe(true);
    expect((await sessionRow(active.id)).expires_at).toBe(absolute);
    expect((await sessionRow(active.id)).absolute_expires_at).toBe(absolute);
    expect((await sessionRow(active.id)).renewed_at).toBe(now);
    const repeated = await fetchRoute("/api/v2/auth/renew", active.token, "POST", {}, csrf);
    expect(((await repeated.json()) as { renewed: boolean }).renewed).toBe(false);
    expect((await sessionRow(active.id)).renewed_at).toBe(now);
  });

  it("A-P2-SESSION 设备标签仅显示；列表含续期精度与临期提示，绝对期限创建时抖动范围固定", async () => {
    now = T0;
    const userId = await seedUser();
    const pending = await seedSession(userId, "pending", {
      absoluteExpiresAt: now + (SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER) * SECOND,
    });
    expect(coarsePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("desktop");
    expect(coarsePlatform("Mozilla/5.0 (iPhone; Mobile)")).toBe("mobile");
    expect(coarsePlatform(null)).toBe("unknown");
    const csrf = await csrfFor(pending.token);
    const response = await fetchRoute(
      "/api/v2/auth/activate",
      pending.token,
      "POST",
      {},
      csrf,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
    );
    expect(response.status).toBe(200);
    const row = await sessionRow(pending.id);
    expect(row.label).toBe(`${new Date(now).toISOString()} · 桌面`);
    expect(row.platform_hint).toBe("desktop");
    expect(row.absolute_expires_at).toBe(
      now + (SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER) * SECOND,
    );
    await run(
      "UPDATE sessions SET expires_at = ? WHERE id = ?",
      now + SESSION_EXPIRY_NOTICE * SECOND - 1,
      pending.id,
    );
    const list = await fetchRoute("/api/v2/me/sessions", pending.token);
    const body = (await list.json()) as {
      current_needs_reverification: boolean;
      renewed_at_max_lag_ms: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.current_needs_reverification).toBe(true);
    expect(body.renewed_at_max_lag_ms).toBe(SESSION_RENEW_INTERVAL * SECOND);
    expect(body.sessions[0]).toMatchObject({
      id: pending.id,
      created_at: now,
      renewed_at: now,
      state: "active",
    });
    expect(JSON.stringify(body)).not.toMatch(/token_hash|user_agent|ip_address/);
    expect(
      (
        await fetchRoute(
          "/api/v2/me/probe",
          pending.token,
          "GET",
          undefined,
          undefined,
          "Mozilla/5.0 (iPhone; Mobile)",
        )
      ).status,
    ).toBe(200);
    expect((await sessionRow(pending.id)).platform_hint).toBe("desktop");
  });

  it("A-P2-SESSION DELETE 只能撤销本人；logout 只撤销当前且不受 USER_MUTATIONS_DAY 阻断", async () => {
    now = T0;
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const current = await seedSession(userId, "active");
    const sibling = await seedSession(userId, "active");
    const foreign = await seedSession(otherUserId, "active");
    const dayKey = utcDayPeriod(now).key;
    const keys = mutationCounterKeys(userId, dayKey);
    await run(
      "INSERT INTO capacity_state (key,value,version,updated_at) VALUES (?,?,0,?)",
      keys.userKey,
      USER_MUTATIONS_DAY,
      now,
    );
    const csrf = await csrfFor(current.token);
    const denied = await fetchRoute(
      `/api/v2/me/sessions/${foreign.id}`,
      current.token,
      "DELETE",
      {},
      csrf,
    );
    expect(denied.status).toBe(400);
    expect((await sessionRow(foreign.id)).state).toBe("active");
    const revoked = await fetchRoute(
      `/api/v2/me/sessions/${sibling.id}`,
      current.token,
      "DELETE",
      {},
      csrf,
    );
    expect(revoked.status).toBe(200);
    expect((await sessionRow(sibling.id)).state).toBe("revoked");
    const repeat = await fetchRoute(
      `/api/v2/me/sessions/${sibling.id}`,
      current.token,
      "DELETE",
      {},
      csrf,
    );
    expect(repeat.status).toBe(200);
    const logout = await fetchRoute("/api/v2/auth/logout", current.token, "POST", {}, csrf);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await sessionRow(current.id)).state).toBe("revoked");
    expect((await sessionRow(foreign.id)).state).toBe("active");
    expect(
      (
        await query<{ value: number }>(
          "SELECT value FROM capacity_state WHERE key = ?",
          keys.userKey,
        )
      )[0].value,
    ).toBe(USER_MUTATIONS_DAY);
    expect((await fetchRoute("/api/v2/me/probe", current.token)).status).toBe(401);
  });

  it("A-P2-SESSION pending 超时清理只撤销到期孤儿，清除回执，active 不受影响", async () => {
    now = T0;
    const userId = await seedUser();
    const active = await seedSession(userId, "active");
    const pending = await seedSession(userId, "pending");
    now += SESSION_PENDING_TTL * SECOND + 1;
    const expiredBefore = (
      await query<{ n: number }>(
        "SELECT count(*) AS n FROM sessions WHERE state = 'pending' AND expires_at <= ?",
        now,
      )
    )[0].n;
    expect(expiredBefore).toBeGreaterThanOrEqual(1);
    expect(await cleanupExpiredPendingSessions(env.DB, now)).toBe(expiredBefore);
    expect((await sessionRow(pending.id)).state).toBe("revoked");
    expect((await sessionRow(active.id)).state).toBe("active");
    expect(
      (
        await query<{ receipt_ciphertext: ArrayBuffer | null }>(
          "SELECT receipt_ciphertext FROM auth_challenges WHERE id = ?",
          pending.challengeId,
        )
      )[0].receipt_ciphertext,
    ).toBeNull();
    expect(await cleanupExpiredPendingSessions(env.DB, now)).toBe(0);
  });

  it("A-P2-SESSION 所选撤销会话 ID 必须去重且来自本人；不能靠路径或请求体指定 user_id", async () => {
    expect(() => parseSelectedSessionIds("bad-id")).toThrow();
    const id = crypto.randomUUID();
    expect(() => parseSelectedSessionIds(`${id},${id}`)).toThrow();
    now = T0;
    const owner = await seedUser();
    const foreignOwner = await seedUser();
    const pending = await seedSession(owner, "pending");
    const foreign = await seedSession(foreignOwner, "active");
    const csrf = await csrfFor(pending.token);
    const conflict = await fetchRoute(
      "/api/v2/auth/activate",
      pending.token,
      "POST",
      {
        revoke_session_ids: foreign.id,
      },
      csrf,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toHaveProperty("selection_required", true);
    expect((await sessionRow(pending.id)).state).toBe("pending");
    expect((await sessionRow(foreign.id)).state).toBe("active");
  });
});
