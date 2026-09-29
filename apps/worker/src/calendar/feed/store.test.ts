// A-P3-ICS：所有数据与令牌均现场生成，仅使用本地 D1。
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
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
});
