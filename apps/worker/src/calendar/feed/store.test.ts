// A-P3-ICS：所有数据与令牌均现场生成，仅使用本地 D1。
import { env } from "cloudflare:test";
import { FEED_ACTIVITY_WRITE_INTERVAL, RECLAIM_TELEMETRY_STALE_HOURS } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readReclaimGate, recordActivityFailure } from "../../accounts/activity/telemetry";
import { createApiShell } from "../../shell/router";
import { fakeExecutionContext } from "../../shell/test-support";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { makeFeedHandler } from "./handler";
import { feedConfig, hashFeedToken, readFeedState, recordFeedOutput } from "./store";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const now = Date.parse("2026-09-29T00:00:00Z");
let token: string;
let hash: string;
async function run(sql: string, ...params: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...params)
    .run();
}
async function requiredState() {
  const state = await readFeedState(env.DB, hash);
  if (state === null) throw new Error("缺少合成 Feed");
  return state;
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  await run(
    `INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext,
    email_version, auth_epoch, recovery_epoch, created_at, updated_at)
    VALUES ('synthetic', 1, 'active', 'synthetic-key', 'synthetic-binding', X'00', 1, 0, 0, ?, ?)`,
    now,
    now,
  );
  await run(
    `INSERT INTO user_subscriptions (user_id, state, schema_version, revision, scope_json,
    calendar_json, notifications_json, created_at, updated_at) VALUES ('synthetic','initialized',3,1,?,?,?,?,?)`,
    JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
    JSON.stringify({
      event_types: ["limited_event"],
      node_types: ["start"],
      alarms_enabled: false,
    }),
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
  await run(
    `INSERT INTO public_snapshots (id,generation,state,built_at,published_at,created_at)
    VALUES ('synthetic-snapshot',1,'current',?,?,?)`,
    now,
    now,
    now,
  );
}, 60_000);
beforeEach(async () => {
  token = generateSecretToken().base64url;
  hash = (await hashFeedToken(token)) as string;
  await run("DELETE FROM calendar_feeds");
  await run("UPDATE users SET status = 'active', auth_epoch = 0, recovery_epoch = 0");
  await run("UPDATE user_subscriptions SET revision = 1");
  await run("UPDATE public_snapshots SET generation = 1");
  await run(
    `INSERT INTO calendar_feeds (user_id,namespace,state,token_hash,token_ciphertext,
    token_generation,view_revision,changed_at,created_at,updated_at,recovery_epoch)
    VALUES ('synthetic','public-random-namespace','enabled',?,X'00',0,0,?,?,?,0)`,
    hash,
    now,
    now,
    now,
  );
});
describe("A-P3-ICS 主状态授权与输出事实", () => {
  it("仅规范 SECRET_BITS token 可查库，拒绝补位、编码别名与超长输入", async () => {
    expect(await hashFeedToken(token)).toBe(hash);
    for (const value of [
      `${token}=`,
      token.slice(1),
      `%41${token.slice(1)}`,
      "a".repeat(10000),
      "_".repeat(token.length),
    ])
      expect(await hashFeedToken(value)).toBeNull();
  });
  it("配置从云端取得，未知 token 不匹配", async () => {
    const state = await readFeedState(env.DB, hash);
    expect(state).not.toBeNull();
    if (state === null) throw new Error("缺少合成 Feed");
    expect(feedConfig(state).notifications.rule_ids).toEqual([]);
    expect(await readFeedState(env.DB, "unknown")).toBeNull();
  });
  it.each([
    "UPDATE calendar_feeds SET state = 'disabled'",
    "UPDATE calendar_feeds SET token_hash = 'rotated', token_generation = token_generation + 1",
    "UPDATE users SET status = 'deleting'",
    "UPDATE users SET recovery_epoch = recovery_epoch + 1",
  ])("撤销与 epoch 变化立即阻止后续输出：%s", async (sql) => {
    const state = await requiredState();
    await run(sql);
    expect(await readFeedState(env.DB, hash)).toBeNull();
    expect(await recordFeedOutput(env.DB, hash, state, 1, 10, now, false)).toBe(false);
  });
  it("普通 auth_epoch 变化不撤销 Feed，也不改变 namespace 与 view_revision", async () => {
    const state = await requiredState();
    await run("UPDATE users SET auth_epoch = auth_epoch + 1");
    expect(await readFeedState(env.DB, hash)).toEqual(state);
    expect(await recordFeedOutput(env.DB, hash, state, 1, 10, now, false)).toBe(true);
  });
  it("成功和守卫拦截时间分别保存，拦截不覆盖成功基线", async () => {
    const state = await requiredState();
    expect(await recordFeedOutput(env.DB, hash, state, 1, 10, now, false)).toBe(true);
    const served = await requiredState();
    expect(await recordFeedOutput(env.DB, hash, served, 1, 0, now + 1, true)).toBe(true);
    expect(await readFeedState(env.DB, hash)).toMatchObject({
      last_served_at: now,
      last_guard_blocked_at: now + 1,
      last_served_node_count: 10,
      last_served_generation: 1,
      last_served_view_revision: 0,
    });
  });
  it("两请求真实并发只提交一个基线，旧请求不能覆盖已成功结果", async () => {
    const state = await requiredState();
    const results = await Promise.all([
      recordFeedOutput(env.DB, hash, state, 1, 10, now, false),
      recordFeedOutput(env.DB, hash, state, 1, 8, now + 1, false),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await recordFeedOutput(env.DB, hash, state, 1, 0, now + 2, false)).toBe(false);
  });
  it.each([
    "UPDATE user_subscriptions SET revision = 2",
    "UPDATE calendar_feeds SET view_revision = 1",
    "UPDATE public_snapshots SET generation = 2",
  ])("组装期间版本变化不记录成功：%s", async (sql) => {
    const state = await requiredState();
    await run(sql);
    expect(await recordFeedOutput(env.DB, hash, state, 1, 10, now, false)).toBe(false);
  });
  it("数据库异常与条件未命中分开，写错误不留下成功基线", async () => {
    const state = await requiredState();
    await run(
      `CREATE TRIGGER synthetic_feed_failure BEFORE UPDATE ON calendar_feeds BEGIN SELECT RAISE(ABORT,'synthetic'); END`,
    );
    try {
      await expect(recordFeedOutput(env.DB, hash, state, 1, 10, now, false)).rejects.toThrow();
    } finally {
      await run("DROP TRIGGER synthetic_feed_failure");
    }
    expect((await readFeedState(env.DB, hash))?.last_served_at).toBeNull();
  });
  it("只有成功最终 CAS 写自然退出上界，诊断、守卫、过时基线及数据库失败均不覆盖", async () => {
    const initial = await requiredState();
    const exit = now + 86_400_000;
    expect(await recordFeedOutput(env.DB, hash, initial, 1, 10, now, false, null, [], exit)).toBe(
      true,
    );
    for (const blocked of [true, false]) {
      const state = await requiredState();
      expect(
        await recordFeedOutput(
          env.DB,
          hash,
          state,
          1,
          0,
          now + 1,
          blocked,
          blocked ? "shrink_guard" : "source_stale",
          [],
          exit + 1,
        ),
      ).toBe(true);
      expect((await requiredState()).last_served_natural_exit_at).toBe(exit);
    }
    expect(
      await recordFeedOutput(env.DB, hash, initial, 1, 0, now + 2, false, null, [], exit + 2),
    ).toBe(false);
    const state = await requiredState();
    // 标量本身也属于 CAS 基线，不能与另一份成功输出的条数拼接。
    await run("UPDATE calendar_feeds SET last_served_natural_exit_at=?", exit + 1);
    expect(
      await recordFeedOutput(env.DB, hash, state, 1, 0, now + 2, false, null, [], exit + 2),
    ).toBe(false);
    const latest = await requiredState();
    await run(
      "CREATE TRIGGER synthetic_exit_failure BEFORE UPDATE ON calendar_feeds BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    try {
      await expect(
        recordFeedOutput(env.DB, hash, latest, 1, 0, now + 2, false, null, [], exit + 2),
      ).rejects.toThrow();
    } finally {
      await run("DROP TRIGGER synthetic_exit_failure");
    }
    expect((await requiredState()).last_served_natural_exit_at).toBe(exit + 1);
  });
});

describe("A-P3-FEEDAPI 授权活动合并与回收门", () => {
  const interval = FEED_ACTIVITY_WRITE_INTERVAL * 86400000;
  async function watermarks() {
    return env.DB.prepare(
      `SELECT f.last_feed_poll_at AS feed,u.last_feed_poll_at AS account FROM calendar_feeds f JOIN users u ON u.id=f.user_id WHERE f.user_id='synthetic'`,
    ).first();
  }
  it("真实并发每个合并间隔只写一次，同条授权 UPDATE 同步两个水位，不改配置或续期", async () => {
    await run("DELETE FROM activity_write_failures");
    await run("UPDATE users SET last_feed_poll_at=NULL");
    await run(
      "INSERT INTO capacity_state(key,value,version,updated_at) VALUES ('synthetic_poll_writes',0,0,?) ON CONFLICT(key) DO UPDATE SET value=0",
      now,
    );
    await run(
      "CREATE TRIGGER synthetic_poll_count AFTER UPDATE OF last_feed_poll_at ON calendar_feeds BEGIN UPDATE capacity_state SET value=value+1 WHERE key='synthetic_poll_writes'; END",
    );
    try {
      await Promise.all([readFeedState(env.DB, hash, now), readFeedState(env.DB, hash, now)]);
      expect(await watermarks()).toEqual({ feed: now, account: now });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_write_failures").first("n"),
      ).toBe(1);
      await readFeedState(env.DB, hash, now + interval - 1);
      expect(await watermarks()).toEqual({ feed: now, account: now });
      await readFeedState(env.DB, hash, now + interval);
      expect(await watermarks()).toEqual({ feed: now + interval, account: now + interval });
      expect(
        await env.DB.prepare("SELECT revision FROM user_subscriptions").first("revision"),
      ).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT value FROM capacity_state WHERE key='synthetic_poll_writes'",
        ).first("value"),
      ).toBe(2);
    } finally {
      await run("DROP TRIGGER synthetic_poll_count");
    }
  });
  it.each([
    "UPDATE calendar_feeds SET state='disabled'",
    "UPDATE users SET status='deleting'",
    "UPDATE users SET recovery_epoch=1",
  ])("无权请求不写活动：%s", async (sql) => {
    await run("UPDATE users SET last_feed_poll_at=NULL");
    await run(sql);
    expect(await readFeedState(env.DB, hash, now)).toBeNull();
    expect(await watermarks()).toEqual({ feed: null, account: null });
  });
  it("依赖的用户水位写入失败整条回滚，独立授权仍通过，失败计数并暂停账号与席位回收", async () => {
    await run("DELETE FROM activity_write_failures");
    await run("UPDATE users SET last_feed_poll_at=NULL");
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('reclaim_paused','false',?) ON CONFLICT(key) DO UPDATE SET value_json='false'",
      now,
    );
    await run(
      "CREATE TRIGGER synthetic_activity_failure BEFORE UPDATE OF last_feed_poll_at ON users BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    try {
      expect(await readFeedState(env.DB, hash, now)).not.toBeNull();
    } finally {
      await run("DROP TRIGGER synthetic_activity_failure");
    }
    expect(await watermarks()).toEqual({ feed: null, account: null });
    expect(
      await env.DB.prepare(
        "SELECT failures FROM activity_write_failures WHERE metric='feed_poll_merge'",
      ).first("failures"),
    ).toBe(1);
    expect(await readReclaimGate(env.DB, now)).toMatchObject({
      accounts_paused: true,
      seats_paused: true,
    });
    await readFeedState(env.DB, hash, now + 1);
    expect(await readReclaimGate(env.DB, now + 1)).toMatchObject({
      accounts_paused: true,
      seats_paused: true,
    });
    // 运维确认漏写已补齐后解锁；仅成功一次不能擅自解除持久开关。
    await run("UPDATE system_state SET value_json='false' WHERE key='reclaim_paused'");
    expect(await readReclaimGate(env.DB, now + 1)).toMatchObject({
      accounts_paused: false,
      seats_paused: false,
    });
    expect(
      await readReclaimGate(env.DB, now + RECLAIM_TELEMETRY_STALE_HOURS * 3600000 + 2),
    ).toMatchObject({ accounts_paused: true, seats_paused: true });
  });
  it("成功 GET、HEAD、304 的实际内容与 ETag 不受活动写失败影响", async () => {
    const at = Date.now();
    await run("UPDATE public_snapshots SET node_count=0");
    await run(
      `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES ('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?) ON CONFLICT(source_id) DO UPDATE SET last_success_at=excluded.last_success_at`,
      at,
      at,
      at,
    );
    const shell = createApiShell({
      authenticator: { authenticate: async () => ({ kind: "none" }) },
      feedHandler: makeFeedHandler({ now: () => at }),
    });
    const get = (method = "GET", tag?: string) =>
      shell.fetch(
        new Request(`https://app.test/feeds/u/${token}.ics`, {
          method,
          headers: tag ? { "if-none-match": tag } : {},
        }),
        env,
        fakeExecutionContext,
      );
    const first = await get();
    expect(first.status).toBe(200);
    const body = await first.text(),
      tag = first.headers.get("etag") ?? "";
    await run("UPDATE calendar_feeds SET last_feed_poll_at=NULL");
    await run(
      "CREATE TRIGGER synthetic_poll_failure BEFORE UPDATE OF last_feed_poll_at ON calendar_feeds BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    try {
      const next = await get();
      expect(next.status).toBe(200);
      expect(await next.text()).toBe(body);
      expect(next.headers.get("etag")).toBe(tag);
      expect((await get("HEAD")).status).toBe(200);
      expect((await get("GET", tag)).status).toBe(304);
    } finally {
      await run("DROP TRIGGER synthetic_poll_failure");
    }
  });
  it("遥测数据库也失效时本 isolate 闭锁；授权数据库不可用仍拒绝读取", async () => {
    const broken = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare" || key === "batch")
          return () => {
            throw new Error("synthetic database failure");
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await recordActivityFailure(broken, now);
    expect(await readReclaimGate(broken, now)).toMatchObject({
      accounts_paused: true,
      seats_paused: true,
    });
    await expect(readFeedState(broken, hash, now)).rejects.toThrow("synthetic database failure");
  });
});
