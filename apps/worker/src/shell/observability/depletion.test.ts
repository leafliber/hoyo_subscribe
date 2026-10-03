import "../../admin/test-support";
import { env } from "cloudflare:test";
import {
  BUDGET_PERIOD_KIND,
  MAIL_AUTH_DAY,
  MAIL_BASE_DAY,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_URGENT_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeEach, expect, it } from "vitest";
import { buildDepletionMigration } from "./depletion-sql";
import { readObservability } from "./views";

const sql = Object.values(
  import.meta.glob("../../../../../migrations/*_observability_depletion.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];
const T = Date.parse("2026-10-02T12:00:00Z");
async function seed(pool: string, n: number, now = T) {
  const day = utcDayPeriod(now);
  await env.DB.prepare(
    "INSERT INTO usage_periods(id,pool,period_kind,period_key,reserved,settled,uncertain,period_start,period_end,created_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?,?,?)",
  )
    .bind(
      pool + day.key,
      pool,
      BUDGET_PERIOD_KIND,
      day.key,
      n,
      day.startMs,
      day.endMsExclusive,
      now,
      now,
    )
    .run();
}
async function bump(pool: string, now: number, amount = 1) {
  return env.DB.prepare(
    "UPDATE usage_periods SET reserved=reserved+?,updated_at=? WHERE pool=? AND period_key=?",
  )
    .bind(amount, now, pool, utcDayPeriod(now).key)
    .run();
}
const times = async (now = T) => (await readObservability(env.DB, now)).pool_depleted_at;
beforeEach(async () => {
  await env.DB.exec("DELETE FROM usage_periods; DELETE FROM system_state;");
});
it("0025 阈值与 contracts 生成源逐字一致", () => expect(sql).toBe(buildDepletionMigration()));
it.each([
  ["base_business", "base", MAIL_BASE_DAY],
  ["urgent_business", "urgent", MAIL_URGENT_DAY],
  ["new_registration", "signup", MAIL_SIGNUP_AUTH_DAY],
] as const)("%s 首次耗尽同事务记录，释放重耗尽不覆盖", async (pool, key, limit) => {
  await seed(pool, limit - 1);
  expect((await times())[key]).toBeNull();
  await bump(pool, T + 1);
  expect((await times())[key]).toBe(T + 1);
  await bump(pool, T + 2, -1);
  await bump(pool, T + 3);
  expect((await times())[key]).toBe(T + 1);
});
it("认证总池含注册子池；认证耗尽也使注册无余额", async () => {
  await seed("new_registration", 1);
  await seed("existing_auth", MAIL_AUTH_DAY - 2);
  await bump("existing_auth", T + 1);
  expect(await times()).toMatchObject({ auth: T + 1, signup: T + 1 });
});
it("批次失败回滚观测；并发首次耗尽与日界隔离", async () => {
  await seed("base_business", MAIL_BASE_DAY - 1);
  await expect(
    env.DB.batch([
      env.DB.prepare(
        "UPDATE usage_periods SET reserved=reserved+1,updated_at=? WHERE pool='base_business'",
      ).bind(T + 1),
      env.DB.prepare(
        "INSERT INTO system_state(key,value_json,updated_at) VALUES ('synthetic-failure','false',NULL)",
      ),
    ]),
  ).rejects.toThrow();
  expect((await times()).base).toBeNull();
  await Promise.all([bump("base_business", T + 2), bump("base_business", T + 3)]);
  expect([T + 2, T + 3]).toContain((await times()).base);
  const tomorrow = utcDayPeriod(T).endMsExclusive;
  expect((await times(tomorrow)).base).toBeNull();
  await seed("base_business", MAIL_BASE_DAY, tomorrow);
  expect((await times(tomorrow)).base).toBe(tomorrow);
  await bump("base_business", T + 4);
  expect((await times(tomorrow)).base).toBe(tomorrow);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM system_state WHERE key LIKE 'obs:depleted:%'",
    ).first("n"),
  ).toBe(1);
});
