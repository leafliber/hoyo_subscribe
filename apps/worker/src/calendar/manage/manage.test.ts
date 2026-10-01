// 仅本地 D1，所有身份和凭证均现场生成。
import { env } from "cloudflare:test";
import {
  mutationCounterKeys,
  SECRET_BITS,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { makePendingSession } from "../../auth/consume/session";
import { mintPreauthCookieValue } from "../../auth/preauth/cookie";
import { runRecoveryAction } from "../../auth/recovery/action";
import { hashRecoverySecret } from "../../auth/recovery/credential";
import { sessionAuthenticator } from "../../auth/sessions/authenticator";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { fakeExecutionContext, randomBytes, testKeyring } from "../../shell/test-support";
import { conditionalCommit } from "../../storage/cas";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { hashFeedToken, readFeedState } from "../feed/store";
import { calendarLifecycle, pauseCalendar } from "./hooks";
import { makeCalendarRoutes } from "./routes";
import { type CalendarSession, mutateCalendar, readCalendar } from "./service";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const now = Date.parse("2026-09-30T00:00:00Z"),
  site = "https://app.test";
let order = 100000;
async function run(sql: string, ...args: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
async function row(id: string) {
  return env.DB.prepare("SELECT * FROM calendar_feeds WHERE user_id=?")
    .bind(id)
    .first<Record<string, unknown>>();
}
async function seed(initialized = true) {
  const userId = crypto.randomUUID(),
    made = await makePendingSession(now),
    secret = generateSecretToken().base64url,
    recoveryId = crypto.randomUUID();
  await run(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,auth_epoch,recovery_epoch,created_at,updated_at) VALUES (?,?,'active',?,?,X'00',1,0,0,?,?)`,
    userId,
    ++order,
    userId,
    userId,
    now,
    now,
  );
  await run(
    `INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at,activated_at) VALUES (?,?,?,'active','synthetic','unknown',?,?,?,?,0,0,?,?,?)`,
    made.id,
    userId,
    made.tokenHash,
    now,
    made.absoluteExpiresAt,
    made.expiresAt,
    now,
    now,
    now,
    now,
  );
  await run(
    `INSERT INTO recovery_credentials(id,user_id,secret_hash,generation,saved_confirmed_at,created_at,updated_at) VALUES (?,?,?,1,?,?,?)`,
    recoveryId,
    userId,
    await hashRecoverySecret(secret),
    now,
    now,
    now,
  );
  if (initialized) {
    await run(
      `INSERT INTO user_subscriptions(user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES (?,'initialized',3,1,?,?,?,?,?)`,
      userId,
      JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
      JSON.stringify({ event_types: ["livestream"], node_types: ["start"], alarms_enabled: false }),
      JSON.stringify({
        rule_ids: [],
        new_event: false,
        important_change: true,
        cancelled_or_retracted: true,
        late_discovery: true,
      }),
      now,
      now,
    );
  } else
    await run(
      "INSERT INTO user_subscriptions(user_id,state,schema_version,revision,created_at,updated_at) VALUES (?,'uninitialized',3,0,?,?)",
      userId,
      now,
      now,
    );

  return {
    userId,
    sessionId: made.id,
    sessionTokenHash: made.tokenHash,
    cookie: made.cookieValue,
    recoveryId,
    secret,
  };
}
async function view(s: CalendarSession) {
  return readCalendar(env.DB, await testKeyring, s, site, now);
}
async function mutate(
  s: CalendarSession,
  a: "enable" | "disable" | "reset",
  g: number,
  key = crypto.randomUUID(),
) {
  return mutateCalendar(env.DB, await testKeyring, s, a, g, key, now);
}
function token(url: string | null) {
  if (!url) throw new Error("missing synthetic URL");
  return (
    new URL(url).pathname
      .split("/")
      .pop()
      ?.replace(/\.ics$/, "") ?? ""
  );
}
beforeAll(async () => {
  for (const name of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[name] ?? "").map((sql) => env.DB.prepare(sql)),
    );
}, 60000);
describe("A-P3-FEEDAPI 管理接口", () => {
  it("未启用视图不创建默认配置；保存确认前不得启用", async () => {
    const s = await seed(false);
    expect(await view(s)).toMatchObject({
      address_state: "not_enabled",
      url: null,
      configuration: { state: "uninitialized", revision: 0, alarms_enabled: null },
    });
    await run("UPDATE recovery_credentials SET saved_confirmed_at=NULL WHERE user_id=?", s.userId);
    await expect(mutate(s, "enable", 0)).rejects.toMatchObject({ code: "conflict" });
    expect(await row(s.userId)).toBeNull();
  });
  it("签发 hash+认证密文，重复 enable/reset 不换第二次；保留 namespace/view_revision/成功基线", async () => {
    const s = await seed();
    await mutate(s, "enable", 0);
    const first = await view(s),
      raw = await row(s.userId);
    expect(raw?.token_hash).toBe(await hashFeedToken(token(first.url)));
    expect(
      new TextDecoder().decode(new Uint8Array(raw?.token_ciphertext as ArrayBuffer)),
    ).not.toContain(token(first.url));
    expect((await view(s)).url).toBe(first.url);
    expect(await mutate(s, "enable", 1)).toMatchObject({ changed: false });
    await run(
      "UPDATE calendar_feeds SET view_revision=7,last_served_at=?,last_served_node_count=10,last_served_natural_exit_at=? WHERE user_id=?",
      now,
      now + 86400000,
      s.userId,
    );
    const key = crypto.randomUUID();
    await mutate(s, "reset", 1, key);
    const reset = await view(s);
    await mutate(s, "reset", 1, key);
    expect((await view(s)).url).toBe(reset.url);
    expect(reset.url === first.url).toBe(false);
    expect(await row(s.userId)).toMatchObject({
      namespace: raw?.namespace,
      view_revision: 7,
      last_served_node_count: 10,
      last_served_at: now,
      last_served_natural_exit_at: now + 86400000,
      token_generation: 2,
    });
    expect(
      await readFeedState(env.DB, (await hashFeedToken(token(first.url))) ?? "", now),
    ).toBeNull();
    await mutate(s, "disable", 2);
    await mutate(s, "disable", 3);
    expect(await view(s)).toMatchObject({
      address_state: "disabled",
      url: null,
      token_generation: 3,
    });
    await mutate(s, "enable", 3);
    expect((await view(s)).url === reset.url).toBe(false);
    await expect(mutate(s, "reset", 1, key)).rejects.toMatchObject({ code: "conflict" });
  });
  it("真实并发相同操作只签发一次、不同重置争用只成功一次", async () => {
    const s = await seed(),
      key = crypto.randomUUID();
    await Promise.all([mutate(s, "enable", 0, key), mutate(s, "enable", 0, key)]);
    expect((await row(s.userId))?.token_generation).toBe(1);
    const results = await Promise.allSettled([mutate(s, "reset", 1), mutate(s, "reset", 1)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await row(s.userId))?.token_generation).toBe(2);
  });
  it("普通修改日额满仍可停用；事务错误回滚凭证和额度", async () => {
    const s = await seed();
    await mutate(s, "enable", 0);
    const { userKey } = mutationCounterKeys(s.userId, utcDayPeriod(now).key);
    await run("UPDATE capacity_state SET value=? WHERE key=?", USER_MUTATIONS_DAY, userKey);
    await expect(mutate(s, "reset", 1)).rejects.toMatchObject({ code: "quota_paused" });
    await mutate(s, "disable", 1);
    await run("UPDATE capacity_state SET value=0 WHERE key=?", userKey);
    await run(
      `CREATE TRIGGER synthetic_manage_failure BEFORE UPDATE OF token_generation ON calendar_feeds BEGIN SELECT RAISE(ABORT,'synthetic'); END`,
    );
    try {
      await expect(mutate(s, "enable", 2)).rejects.toThrow();
    } finally {
      await run("DROP TRIGGER synthetic_manage_failure");
    }
    expect((await row(s.userId))?.token_generation).toBe(2);
    expect(
      await env.DB.prepare("SELECT value FROM capacity_state WHERE key=?")
        .bind(userKey)
        .first("value"),
    ).toBe(0);
  });
  it.each(["emergency_stop", "recover_login"] as const)(
    "%s 真恢复入口撤销 Feed；紧急停用不消费码",
    async (action) => {
      const s = await seed();
      await mutate(s, "enable", 0);
      const url = (await view(s)).url;
      const minted = await mintPreauthCookieValue((await testKeyring).preauthCookie(), now);
      const response = await runRecoveryAction(
        {
          db: env.DB,
          keys: await testKeyring,
          sourceGate: { charge: async () => true },
          now: () => now,
          pauseHooks: [pauseCalendar],
        },
        {
          request: new Request(`${site}/api/v2/auth/recovery`, {
            method: "POST",
            headers: {
              cookie: `__Host-preauth=${minted.value}`,
              "idempotency-key": crypto.randomUUID(),
            },
          }),
          action,
          recoveryId: s.recoveryId,
          secret: s.secret,
        },
      );
      expect(response.status).toBe(200);
      expect(await readFeedState(env.DB, (await hashFeedToken(token(url))) ?? "", now)).toBeNull();
      expect((await row(s.userId))?.state).toBe("disabled");
      expect(
        await env.DB.prepare("SELECT consumed_at FROM recovery_credentials WHERE id=?")
          .bind(s.recoveryId)
          .first("consumed_at"),
      ).toBe(action === "emergency_stop" ? null : now);
    },
  );
  it("hook 收集时无 Feed，提交前首次启用仍被原子撤销；删除同理，换邮箱不撤销", async () => {
    for (const deleting of [false, true]) {
      const s = await seed();
      const effects = deleting
        ? await calendarLifecycle({ db: env.DB, userId: s.userId, now, event: "account_delete" })
        : await pauseCalendar({ db: env.DB, userId: s.userId, now });
      await mutate(s, "enable", 0);
      await conditionalCommit(env.DB, {
        guard: { sql: "UPDATE sessions SET updated_at=? WHERE id=?", params: [now, s.sessionId] },
        effects: [
          {
            kind: "update",
            table: "users",
            set: deleting
              ? { status: "deleting", auth_epoch: { sql: "auth_epoch+1" }, updated_at: now }
              : {
                  auth_epoch: { sql: "auth_epoch+1" },
                  last_recovery_stop_epoch: { sql: "auth_epoch+1" },
                  updated_at: now,
                },
            where: { sql: "id=?", params: [s.userId] },
          },
          ...effects,
        ],
      });
      expect((await row(s.userId))?.state).toBe("disabled");
    }
    const s = await seed();
    await mutate(s, "enable", 0);
    const raw = await row(s.userId);
    expect(
      await calendarLifecycle({ db: env.DB, userId: s.userId, now, event: "email_change" }),
    ).toEqual([]);
    await run("UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=?", s.userId);
    expect((await row(s.userId))?.token_hash).toBe(raw?.token_hash);
  });
  it("D3 草案输出状态与成功基线、拉取语义分开返回", async () => {
    const s = await seed();
    await mutate(s, "enable", 0);
    await run(
      "UPDATE calendar_feeds SET last_served_at=?,last_served_node_count=10,last_guard_blocked_at=?,last_output_at=?,last_output_diagnostic='shrink_guard' WHERE user_id=?",
      now,
      now + 1,
      now + 1,
      s.userId,
    );
    expect(await view(s)).toMatchObject({
      output: { state: "integrity_blocked", last_served_at: now, last_served_node_count: 10 },
      polling: { meaning: "client_requested_address" },
    });
  });
  it("真实会话与 CSRF，拒绝 pending/受限写/跨用户/额外字段，无额外 OTP", async () => {
    const s = await seed();
    const shell = createApiShell({
      authenticator: sessionAuthenticator(env.DB, () => now),
      csrfKey: async () => (await testKeyring).csrf(),
      routes: makeCalendarRoutes(
        () => testKeyring,
        () => now,
      ),
    });
    const csrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      s.sessionTokenHash,
      randomBytes(SECRET_BITS / 8),
    );
    const request = (body: unknown, origin = site, cookie = true) =>
      shell.fetch(
        new Request(`${site}/api/v2/me/calendar/enable`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
            cookie: cookie ? `__Host-session=${s.cookie}; ${CSRF_COOKIE_NAME}=${csrf}` : "",
            [CSRF_HEADER_NAME]: csrf,
          },
          body: JSON.stringify(body),
        }),
        env,
        fakeExecutionContext,
      );
    const body = { confirmed: true, expected_generation: 0 };
    expect((await request(body, "https://other.test")).status).toBe(401);
    expect((await request(body, site, false)).status).toBe(401);
    expect((await request({ ...body, user_id: "other" })).status).toBe(400);
    expect((await request({ ...body, confirmed: false })).status).toBe(400);
    await run("UPDATE sessions SET state='pending' WHERE id=?", s.sessionId);
    expect((await request(body)).status).toBe(401);
    await run(
      "UPDATE sessions SET state='active',recovery_code_required=1 WHERE id=?",
      s.sessionId,
    );
    expect((await request(body)).status).toBe(401);
    await run("UPDATE sessions SET recovery_code_required=0 WHERE id=?", s.sessionId);
    const enabled = await request(body);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).not.toHaveProperty("url");
    const read = await shell.fetch(
      new Request(`${site}/api/v2/me/calendar`, {
        headers: { cookie: `__Host-session=${s.cookie}` },
      }),
      env,
      fakeExecutionContext,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toContain("no-store");
    const other = await seed();
    expect((await view(other)).url).toBeNull();
    await expect(
      readCalendar(env.DB, await testKeyring, { ...s, userId: other.userId }, site, now),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("A-P3-FEEDAPI 凭证安全竞态", () => {
  it("原会话在组装凭证后被撤销，最终管理 CAS 不得签发或扣额度", async () => {
    const s = await seed();
    await mutate(s, "enable", 0);
    const before = await row(s.userId);
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await run("UPDATE sessions SET state='revoked' WHERE id=?", s.sessionId);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      mutateCalendar(db, await testKeyring, s, "reset", 1, crypto.randomUUID(), now),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect((await row(s.userId))?.token_hash).toBe(before?.token_hash);
  });
  it("认证密文不能跨账号搬运，恢复 epoch 变更后的旧操作不能复活旧地址", async () => {
    const a = await seed(),
      b = await seed(),
      key = crypto.randomUUID();
    await mutate(a, "enable", 0, key);
    await mutate(b, "enable", 0, key);
    const other = await row(b.userId);
    await run(
      "UPDATE calendar_feeds SET token_ciphertext=? WHERE user_id=?",
      other?.token_ciphertext,
      a.userId,
    );
    await expect(view(a)).rejects.toThrow();
    await run("UPDATE users SET recovery_epoch=1 WHERE id=?", b.userId);
    await run("UPDATE sessions SET recovery_epoch=1 WHERE id=?", b.sessionId);
    expect(await view(b)).toMatchObject({ address_state: "disabled", url: null });
    await expect(mutate(b, "enable", 0, key)).rejects.toMatchObject({ code: "conflict" });
  });
});
