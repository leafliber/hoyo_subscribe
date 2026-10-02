import "../../admin/test-support";
import { env } from "cloudflare:test";
import {
  BUDGET_PERIOD_KIND,
  FEEDBACK_BATCH,
  FEEDBACK_MAINTENANCE_ROUNDS,
  MAIL_FEEDBACK_TTL,
  PUBLIC_SNAPSHOT_WRITE_PROFILE,
  utcDayPeriod,
} from "@hoyo/contracts";
import { expect, it } from "vitest";
import { maintainFeedback } from "../../scheduled/feedback";
import { testKeyring } from "../test-support";

const T = Date.parse("2026-10-02T12:00:00Z");
it("P5 满4轮真实清理与unknown硬退信再关联，不超过D1平台查询数且保留下一页", async () => {
  for (const table of [
    "mail_feedback",
    "suppressions",
    "deliveries",
    "mail_outbox",
    "jobs",
    "usage_periods",
    "system_state",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
  const pageBudget = FEEDBACK_BATCH * FEEDBACK_MAINTENANCE_ROUNDS;
  const period = utcDayPeriod(T);
  await env.DB.prepare(
    "INSERT INTO usage_periods(id,pool,period_kind,period_key,uncertain,period_start,period_end,created_at,updated_at) VALUES ('synthetic-maintenance','existing_auth',?,?,?,?,?,?,?)",
  )
    .bind(
      BUDGET_PERIOD_KIND,
      period.key,
      pageBudget + 1,
      period.startMs,
      period.endMsExclusive,
      T,
      T,
    )
    .run();
  for (let i = 0; i <= pageBudget; i++) {
    const id = `synthetic-maintenance-${i}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at) VALUES (?,?,?,'delivered',?,'{}',?)",
      ).bind(`${id}-expired`, `${id}-expired`, `${id}-expired`, T, T - MAIL_FEEDBACK_TTL * 1000),
      env.DB.prepare(
        "INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,status,message_id,created_at,updated_at) VALUES (?,'existing_auth',0,?,1,'synthetic','unknown',?,?,?)",
      ).bind(id, period.key, id, T, T),
      env.DB.prepare(
        "INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at) VALUES (?,?,?,'bounced',?,?,?)",
      ).bind(
        id,
        id,
        id,
        T,
        JSON.stringify({
          addressKey: id,
          suppression: "hard_bounce",
          stage: "pending",
          leaseUntil: 0,
          token: null,
        }),
        T,
      ),
    ]);
  }
  let queries = 0,
    rowsRead = 0,
    rowsWritten = 0;
  const observe = (result: D1Result) => {
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
    return result;
  };
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          queries += statements.length;
          return (await target.batch(statements)).map(observe);
        };
      if (key === "prepare")
        return (sql: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, k) {
                if (k === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (k === "first")
                  return async (column?: string) => {
                    queries++;
                    const result = observe(await s.all());
                    const row = result.results[0] as Record<string, unknown> | undefined;
                    return column === undefined ? (row ?? null) : (row?.[column] ?? null);
                  };
                if (k === "run" || k === "all")
                  return async () => {
                    queries++;
                    return observe(await s[k]());
                  };
                const v = Reflect.get(s, k);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          return wrap(target.prepare(sql));
        };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const ring = await testKeyring;
  await maintainFeedback(
    db,
    async () => ({ lookup: ring.emailLookup(), field: ring.fieldEncryption() }),
    () => T,
  );
  expect(queries).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit); // 同一 D1 平台 query-limit 事实；不是复用快照批量/业务阈值。
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_feedback WHERE created_at<?")
      .bind(T)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mail_feedback WHERE json_extract(raw_ref,'$.stage')='done'",
    ).first("n"),
  ).toBe(pageBudget);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE status='unknown'").first("n"),
  ).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first("n")).toBe(
    pageBudget,
  );
  console.log(
    JSON.stringify({
      metric: "P5_feedback_maintenance_local",
      queries,
      rowsRead,
      rowsWritten,
      rowsPerPhase: pageBudget,
    }),
  );
}, 120_000);
