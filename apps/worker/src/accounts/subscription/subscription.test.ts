// A-P2-SUB：真实 Miniflare D1 + 外壳路由，含两设备同时保存、日额原子性与 Feed 版本。
// 所有账号、会话散列和时间均为合成样本。
import { env } from "cloudflare:test";
import {
  API_BODY_MAX_BYTES,
  CONFIG_MAX_BYTES,
  changeNotificationScope,
  effectiveCalendarNodes,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  SECRET_BITS,
  type SubscriptionConfig,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import type { ShellAuth } from "../../shell/domains";
import { fakeExecutionContext, randomBytes, testKeyring } from "../../shell/test-support";
import { splitSqlStatements } from "../../storage/split-sql";
import { makeSubscriptionRoutes } from "./routes";
import { readSubscription, saveSubscription } from "./service";

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
const T0 = utcDayPeriod(1_900_000_000_000).startMs + 1_000;
const SITE = "https://app.test";
let order = 0;

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
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,
      email_version,auth_epoch,recovery_epoch,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,0,0,?,?)`,
    id,
    ++order,
    "active",
    `synthetic:${id}`,
    crypto.randomUUID(),
    new Uint8Array([1]),
    T0,
    T0,
  );
  await run(
    "INSERT INTO user_subscriptions (user_id,state,schema_version,revision,created_at,updated_at) VALUES (?,'uninitialized',3,0,?,?)",
    id,
    T0,
    T0,
  );
  return id;
}

type Draft = Omit<SubscriptionConfig, "revision">;
const base: Draft = {
  schema_version: 3,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["livestream"], node_types: ["start"], alarms_enabled: false },
  notifications: {
    rule_ids: [],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: false,
    late_discovery: false,
  },
};

function draft(change: (config: Draft) => void = () => {}): Draft {
  const value = structuredClone(base);
  change(value);
  return value;
}

function shell(userId: string) {
  return createApiShell({
    authenticator: {
      async authenticate(request): Promise<ShellAuth> {
        const device = request.headers.get("x-test-device") ?? "a";
        return {
          kind: "session",
          domain: "user",
          userId,
          sessionId: `synthetic:${device}`,
          sessionState: request.headers.get("x-test-pending") === "1" ? "pending" : "active",
          sessionTokenHash: `synthetic-hash:${device}`,
        };
      },
    },
    csrfKey: async () => (await testKeyring).csrf(),
    routes: makeSubscriptionRoutes(() => T0),
  });
}

async function request(
  userId: string,
  method: "GET" | "PATCH",
  config?: Draft,
  expectedRevision = 0,
  device = "a",
  pending = false,
): Promise<Response> {
  const headers = new Headers({ "x-test-device": device });
  if (pending) headers.set("x-test-pending", "1");
  if (method === "PATCH") {
    const token = await mintCsrfToken(
      (await testKeyring).csrf(),
      `synthetic-hash:${device}`,
      randomBytes(SECRET_BITS / 8),
    );
    headers.set("content-type", "application/json");
    headers.set("origin", SITE);
    headers.set("cookie", `${CSRF_COOKIE_NAME}=${token}`);
    headers.set(CSRF_HEADER_NAME, token);
  }
  return shell(userId).fetch(
    new Request(`${SITE}/api/v2/me/subscription`, {
      method,
      headers,
      body:
        method === "PATCH"
          ? JSON.stringify({ expected_revision: expectedRevision, config })
          : undefined,
    }),
    env,
    fakeExecutionContext,
  );
}

async function counter(userId: string): Promise<{ user: number; global: number }> {
  const keys = mutationCounterKeys(userId, utcDayPeriod(T0).key);
  const rows = await query<{ key: string; value: number }>(
    "SELECT key,value FROM capacity_state WHERE key IN (?,?)",
    keys.userKey,
    keys.globalKey,
  );
  return {
    user: rows.find((r) => r.key === keys.userKey)?.value ?? 0,
    global: rows.find((r) => r.key === keys.globalKey)?.value ?? 0,
  };
}

async function feedRevision(userId: string): Promise<number> {
  const rows = await query<{ view_revision: number }>(
    "SELECT view_revision FROM calendar_feeds WHERE user_id = ?",
    userId,
  );
  return rows[0]?.view_revision ?? -1;
}

async function seedFeed(userId: string): Promise<void> {
  await run(
    `INSERT INTO calendar_feeds (user_id,namespace,state,token_hash,token_ciphertext,token_generation,
      view_revision,changed_at,created_at,updated_at) VALUES (?,?,'enabled',?,?,0,0,?,?,?)`,
    userId,
    crypto.randomUUID(),
    `synthetic:${userId}`,
    new Uint8Array([1]),
    T0,
    T0,
    T0,
  );
}

describe("A-P2-SUB 云端订阅读写", () => {
  it("未初始化 GET 不造默认配置；首次保存规则为空而变更开关开启，兴趣可匹配且无 Feed 行也成功", async () => {
    const userId = await seedUser();
    const initial = await request(userId, "GET");
    expect(await initial.json()).toEqual({ state: "uninitialized", revision: 0, config: null });
    expect(
      (await query("SELECT * FROM subscription_interests WHERE user_id = ?", userId)).length,
    ).toBe(0);
    expect((await request(userId, "PATCH", base)).status).toBe(200);
    const saved = await readSubscription(env.DB, userId);
    expect(saved.state).toBe("initialized");
    expect(saved.revision).toBe(1);
    expect(saved.config?.notifications.rule_ids).toEqual([]);
    expect(saved.config?.notifications.important_change).toBe(true);
    if (saved.config === null) throw new Error("saved config missing");
    expect(changeNotificationScope(saved.config).event_types.has("livestream")).toBe(true);
    await expect(
      run("UPDATE user_subscriptions SET state = 'uninitialized' WHERE user_id = ?", userId),
    ).rejects.toThrow();
    expect((await readSubscription(env.DB, userId)).state).toBe("initialized");
    const interests = await query<{ interest_kind: string; interest_id: string }>(
      "SELECT interest_kind,interest_id FROM subscription_interests WHERE user_id = ?",
      userId,
    );
    expect(interests).toEqual([
      { interest_kind: "change_switch", interest_id: "important_change" },
    ]);
    expect(await counter(userId)).toEqual({ user: 1, global: 1 });
  });

  it("变更范围取日历与规则事件类型并集；提醒关联节点不与 node_types 隐式相交", () => {
    const config: SubscriptionConfig = {
      ...base,
      revision: 1,
      calendar: { event_types: ["maintenance"], node_types: ["end"], alarms_enabled: true },
      notifications: { ...base.notifications, rule_ids: ["livestream_start_1h"] },
    };
    const scope = changeNotificationScope(config);
    expect(scope.event_types.has("maintenance")).toBe(true);
    expect(scope.event_types.has("livestream")).toBe(true);
    const nodes = effectiveCalendarNodes(config, [
      { game: "genshin", region: "CN", event_type: "livestream", node_type: "start" },
    ]);
    expect(nodes[0]?.reason).toEqual({
      kind: "reminder_associated",
      rule_ids: ["livestream_start_1h"],
    });
  });

  it("同配置保存零写入零扣额；pending 无法 GET/PATCH", async () => {
    const userId = await seedUser();
    await request(userId, "PATCH", base);
    const countsBefore = await counter(userId);
    const before = await query<{ updated_at: number }>(
      "SELECT updated_at FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    const response = await request(userId, "PATCH", base, 1);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { saved: boolean }).saved).toBe(false);
    expect(
      await query("SELECT updated_at FROM user_subscriptions WHERE user_id = ?", userId),
    ).toEqual(before);
    expect(await counter(userId)).toEqual(countsBefore);
    expect((await saveSubscription(env.DB, userId, 1, base, T0 + 100)).kind).toBe("unchanged");
    expect(
      await query("SELECT updated_at FROM user_subscriptions WHERE user_id = ?", userId),
    ).toEqual(before);
    expect((await request(userId, "GET", undefined, 0, "a", true)).status).toBe(401);
    expect((await request(userId, "PATCH", base, 1, "a", true)).status).toBe(401);
  });

  it("请求体不得指定其他所有者；规范化后相同的数组保存仍幂等", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const attack = { expected_revision: 0, config: { ...base, user_id: otherUserId } };
    const csrf = await mintCsrfToken(
      (await testKeyring).csrf(),
      "synthetic-hash:a",
      randomBytes(SECRET_BITS / 8),
    );
    const response = await shell(userId).fetch(
      new Request(`${SITE}/api/v2/me/subscription`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: SITE,
          cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify(attack),
      }),
      env,
      fakeExecutionContext,
    );
    expect(response.status).toBe(400);
    expect((await readSubscription(env.DB, otherUserId)).state).toBe("uninitialized");
    await request(userId, "PATCH", base);
    const before = await counter(userId);
    const repeated = draft((v) => {
      v.scope.games = ["genshin", "genshin"];
    });
    expect((await saveSubscription(env.DB, userId, 1, repeated, T0 + 100)).kind).toBe("unchanged");
    expect(await counter(userId)).toEqual(before);
  });

  it("两设备真实并发同 expected_revision：一个成功、一个 409 携云端配置；冲突不扣额", async () => {
    const userId = await seedUser();
    await request(userId, "PATCH", base);
    const countsBefore = await counter(userId);
    const left = draft((v) => {
      v.calendar.alarms_enabled = true;
    });
    const right = draft((v) => {
      v.notifications.new_event = true;
    });
    const responses = await Promise.all([
      request(userId, "PATCH", left, 1, "a"),
      request(userId, "PATCH", right, 1, "b"),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await readSubscription(env.DB, userId);
    const conflict = responses.find((r) => r.status === 409);
    if (conflict === undefined) throw new Error("conflict response missing");
    expect(await conflict.json()).toMatchObject({
      error: { code: "conflict" },
      current,
    });
    expect(current.revision).toBe(2);
    expect(await counter(userId)).toEqual({ user: 2, global: countsBefore.global + 1 });
  });

  it("日额与订阅同成同败：账号/全站满额拒绝，配置与版本不动", async () => {
    const userId = await seedUser();
    await request(userId, "PATCH", base);
    const changed = draft((v) => {
      v.notifications.new_event = true;
    });
    const keys = mutationCounterKeys(userId, utcDayPeriod(T0).key);
    const countsBefore = await counter(userId);
    await run(
      "UPDATE capacity_state SET value = ? WHERE key = ?",
      USER_MUTATIONS_DAY,
      keys.userKey,
    );
    const before = await readSubscription(env.DB, userId);
    expect((await request(userId, "PATCH", changed, 1)).status).toBe(429);
    expect((await request(userId, "PATCH", base, 1)).status).toBe(200);
    expect((await request(userId, "PATCH", changed, 0)).status).toBe(409);
    expect(await readSubscription(env.DB, userId)).toEqual(before);
    expect(await counter(userId)).toEqual({
      user: USER_MUTATIONS_DAY,
      global: countsBefore.global,
    });
    await run("UPDATE capacity_state SET value = 1 WHERE key = ?", keys.userKey);
    await run(
      "UPDATE capacity_state SET value = ? WHERE key = ?",
      GLOBAL_MUTATIONS_DAY,
      keys.globalKey,
    );
    expect((await request(userId, "PATCH", changed, 1)).status).toBe(429);
    expect(await readSubscription(env.DB, userId)).toEqual(before);
    expect(await counter(userId)).toEqual({ user: 1, global: GLOBAL_MUTATIONS_DAY });
    await run(
      "UPDATE capacity_state SET value = ? WHERE key = ?",
      countsBefore.global,
      keys.globalKey,
    );
  });

  it("兴趣效果遇到 SQL 错误，订阅版本与两级计数一同回滚", async () => {
    const userId = await seedUser();
    const before = await counter(userId);
    await env.DB.prepare(`CREATE TRIGGER p206_reject_interest BEFORE INSERT ON subscription_interests
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`).run();
    try {
      await expect(saveSubscription(env.DB, userId, 0, base, T0)).rejects.toThrow();
      expect((await readSubscription(env.DB, userId)).state).toBe("uninitialized");
      expect(await counter(userId)).toEqual(before);
    } finally {
      await env.DB.exec("DROP TRIGGER p206_reject_interest;");
    }
  });

  it("Feed 只随 ICS 语义变化取号：变更开关、关闭提醒下的规则不取号；四类 ICS 字段取号", async () => {
    const userId = await seedUser();
    await request(userId, "PATCH", base);
    await seedFeed(userId);
    let revision = 1;
    let current = draft();
    const changes: Array<{ next: Draft; expectedFeed: number }> = [
      {
        next: draft((v) => {
          v.notifications.new_event = true;
        }),
        expectedFeed: 0,
      },
      {
        next: draft((v) => {
          v.notifications.new_event = true;
          v.notifications.rule_ids = ["livestream_start_1h"];
        }),
        expectedFeed: 0,
      },
      {
        next: draft((v) => {
          v.notifications.new_event = true;
          v.notifications.rule_ids = ["livestream_start_1h"];
          v.scope.games = ["hsr"];
        }),
        expectedFeed: 1,
      },
      {
        next: draft((v) => {
          v.notifications.new_event = true;
          v.notifications.rule_ids = ["livestream_start_1h"];
          v.scope.games = ["hsr"];
          v.calendar.event_types = ["maintenance"];
        }),
        expectedFeed: 2,
      },
      {
        next: draft((v) => {
          v.notifications.new_event = true;
          v.notifications.rule_ids = ["livestream_start_1h"];
          v.scope.games = ["hsr"];
          v.calendar.event_types = ["maintenance"];
          v.calendar.node_types = ["end"];
        }),
        expectedFeed: 3,
      },
      {
        next: draft((v) => {
          v.notifications.new_event = true;
          v.notifications.rule_ids = ["livestream_start_1h"];
          v.scope.games = ["hsr"];
          v.calendar.event_types = ["maintenance"];
          v.calendar.node_types = ["end"];
          v.calendar.alarms_enabled = true;
        }),
        expectedFeed: 4,
      },
    ];
    for (const step of changes) {
      expect(JSON.stringify(step.next)).not.toBe(JSON.stringify(current));
      const outcome = await saveSubscription(env.DB, userId, revision, step.next, T0 + revision);
      expect(outcome.kind).toBe("saved");
      revision++;
      current = step.next;
      expect(await feedRevision(userId)).toBe(step.expectedFeed);
    }
  });

  it("兴趣 enabled_at 只对新增与重新启用重计时，未变化兴趣保留原时刻", async () => {
    const userId = await seedUser();
    const first = draft((v) => {
      v.notifications.rule_ids = ["livestream_start_1h"];
    });
    await saveSubscription(env.DB, userId, 0, first, T0);
    const readTimes = async () =>
      await query<{ interest_id: string; enabled_at: number }>(
        "SELECT interest_id,enabled_at FROM subscription_interests WHERE user_id = ? ORDER BY interest_id",
        userId,
      );
    const old = await readTimes();
    expect(old).toHaveLength(2);
    const second = draft((v) => {
      v.notifications.rule_ids = ["livestream_start_1h", "limited_end_1d"];
    });
    await saveSubscription(env.DB, userId, 1, second, T0 + 100);
    const added = await readTimes();
    expect(added.find((r) => r.interest_id === "livestream_start_1h")?.enabled_at).toBe(T0);
    expect(added.find((r) => r.interest_id === "important_change")?.enabled_at).toBe(T0);
    expect(added.find((r) => r.interest_id === "limited_end_1d")?.enabled_at).toBe(T0 + 100);
    await saveSubscription(env.DB, userId, 2, first, T0 + 200);
    await saveSubscription(env.DB, userId, 3, second, T0 + 300);
    const reenabled = await readTimes();
    expect(reenabled.find((r) => r.interest_id === "limited_end_1d")?.enabled_at).toBe(T0 + 300);
    expect(reenabled.find((r) => r.interest_id === "livestream_start_1h")?.enabled_at).toBe(T0);
  });

  it("未知键、额外层级、超 CONFIG_MAX_BYTES、无效空 scope 一律 validation", async () => {
    const userId = await seedUser();
    const invalid: unknown[] = [
      { ...base, rogue: true },
      { ...base, scope: { ...base.scope, rogue: true } },
      { ...base, notifications: { ...base.notifications, rogue: true } },
      draft((v) => {
        v.scope.games = [];
      }),
      draft((v) => {
        v.scope.regions = [];
      }),
      draft((v) => {
        v.calendar.event_types = [];
      }),
      {
        ...base,
        notifications: { ...base.notifications, rule_ids: Array(250).fill("livestream_start_1h") },
      },
    ];
    expect(new TextEncoder().encode(JSON.stringify(invalid.at(-1))).byteLength).toBeGreaterThan(
      CONFIG_MAX_BYTES,
    );
    expect(
      new TextEncoder().encode(JSON.stringify({ expected_revision: 0, config: invalid.at(-1) }))
        .byteLength,
    ).toBeLessThan(API_BODY_MAX_BYTES);
    for (const [index, value] of invalid.entries()) {
      const response = await request(userId, "PATCH", value as Draft);
      expect(response.status).toBe(400);
      if (index === invalid.length - 1) {
        expect(await response.json()).toMatchObject({
          error: { details: { fields: [{ path: "config", reason: "config_too_large" }] } },
        });
      }
    }
    expect((await readSubscription(env.DB, userId)).state).toBe("uninitialized");
  });
});
