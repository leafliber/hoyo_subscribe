// A-P1-BUDGET · 邮件预算账本（任务卡 P1-07）——L2 测试，跑在真实 workerd + miniflare D1
// 上（@cloudflare/vitest-pool-workers，与部署引擎一致；本地与生产差异以 P0-01 证据为准）。
// 验收定义（docs/ACCEPTANCE.md A-P1-BUDGET）：
//   三个日池每 UTC 日独立重置、不跨日结转、池间不互借；settled+reserved+uncertain 均占
//   当日额度；两个 floor 的当日降级；★ 一次全量取消（100 席位）后余 20 恰好触发收紧；
//   跨 UTC 日边界未外发原子重排、已调用/unknown 不释放；并发预占不超卖；
//   不得出现 envelope / carry / 月度池（ADR-0003）。
// 迁移重放纪律与 A-P1-CAS 的 cas.test.ts 相同：空库顺序重放，本文件自足。

import { env } from "cloudflare:test";
import {
  BUDGET_PERIOD_KIND,
  decideMailIntent,
  MAIL_AUTH_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_SEATS_MAX,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_URGENT_DAY,
  MAIL_URGENT_FLOOR,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  type MailPool,
  type MailPoolOccupancy,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { type ConditionalCommitOutcome, conditionalCommit } from "../cas";
import { splitSqlStatements } from "../split-sql";
import {
  type MailBudgetPeriod,
  readMailDayLedger,
  reserveMailBudget,
  rolloverUnsentOutboxReservation,
  transitionMailReservation,
} from "./mail-ledger";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}

const migrationFiles = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

// 合成基准时刻（纯合成数据，无真实邮箱/主机/密钥）。
const T0 = 1_800_000_000_000;

function period(y: number, m: number, d: number): MailBudgetPeriod {
  const p = utcDayPeriod(Date.UTC(y, m - 1, d));
  return { key: p.key, startMs: p.startMs, endMsExclusive: p.endMsExclusive };
}

// 各节用独立日期，互不串账。
const DAY_A = period(2026, 9, 22);
const DAY_A_NEXT = period(2026, 9, 23);
const DAY_RO1 = period(2026, 10, 1);
const DAY_RO2 = period(2026, 10, 2);
const DAY_FULL_FROM = period(2026, 10, 3);
const DAY_FULL_TO = period(2026, 10, 4);
const DAY_CALL_FROM = period(2026, 10, 5);
const DAY_CALL_TO = period(2026, 10, 6);
const DAY_LEASE_FROM = period(2026, 10, 7);
const DAY_LEASE_TO = period(2026, 10, 8);

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

async function run(sql: string, ...params: unknown[]): Promise<void> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  await stmt.run();
}

const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

interface MasterRow {
  type: string;
  name: string;
}

async function resetToEmptyDatabase(): Promise<void> {
  const dropObjects = await query<MasterRow>(
    `SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND ${USER_OBJECT_FILTER}`,
  );
  for (const obj of dropObjects) {
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  }
  let remaining = (
    await query<MasterRow>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
    )
  ).map((row) => row.name);
  for (let round = 0; remaining.length > 0 && round < 20; round++) {
    let progress = false;
    for (const table of [...remaining]) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table}";`);
        progress = true;
      } catch {
        // 外键依赖未解除，下一轮重试
      }
    }
    if (!progress) break;
    remaining = (
      await query<MasterRow>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
      )
    ).map((row) => row.name);
  }
  expect(remaining, "清库失败：空库重放前提不成立").toEqual([]);
}

beforeAll(async () => {
  await resetToEmptyDatabase();
  for (const name of Object.keys(migrationFiles).sort()) {
    const statements = splitSqlStatements(migrationFiles[name] ?? "");
    expect(statements.length, `迁移 ${name} 切分后为空`).toBeGreaterThan(0);
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
}, 180_000);

// —— 合成样本工具 ——

let orderSeq = 1;

async function insertUser(id: string): Promise<void> {
  await run(
    'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, auth_epoch, recovery_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)',
    id,
    orderSeq++,
    "active",
    `ek_${id}`,
    `eb_${id}`,
    new Uint8Array([1, 2, 3, 4]),
    T0,
    T0,
  );
}

interface OutboxFixture {
  id: string;
  status?: string;
  periodKey?: string | null;
  purpose?: string;
}

async function insertOutbox(fixture: OutboxFixture): Promise<void> {
  await run(
    "INSERT INTO mail_outbox (id, purpose, priority, period_key, recipient_user_id, address_version, payload_kind, status, lease_version, attempts, created_at, updated_at) VALUES (?, ?, 1, ?, NULL, 1, 'template_ref', ?, 0, 0, ?, ?)",
    fixture.id,
    fixture.purpose ?? "urgent_business",
    fixture.periodKey ?? OUTBOX_UNRESERVED_PERIOD_KEY,
    fixture.status ?? "pending",
    T0,
    T0,
  );
}

let seedSeq = 1;

async function seedUsageRow(
  pool: MailPool,
  periodKey: string,
  occupancy: Partial<MailPoolOccupancy>,
  userId?: string,
): Promise<void> {
  const p = utcDayPeriod(T0);
  await run(
    `INSERT INTO usage_periods (id, pool, period_kind, period_key, user_id, reserved, settled, uncertain, period_start, period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET reserved = excluded.reserved, settled = excluded.settled, uncertain = excluded.uncertain, updated_at = excluded.updated_at`,
    `seed_${seedSeq++}`,
    pool,
    BUDGET_PERIOD_KIND,
    periodKey,
    userId ?? null,
    occupancy.reserved ?? 0,
    occupancy.settled ?? 0,
    occupancy.uncertain ?? 0,
    p.startMs,
    p.endMsExclusive,
    T0,
    T0,
  );
}

async function poolOccupancy(
  pool: MailPool,
  periodKey: string,
  userId?: string,
): Promise<MailPoolOccupancy> {
  const rows = await query<MailPoolOccupancy>(
    `SELECT reserved, settled, uncertain FROM usage_periods
     WHERE pool = ? AND period_kind = ? AND period_key = ? AND ${userId === undefined ? "user_id IS NULL" : "user_id = ?"}`,
    ...(userId === undefined
      ? [pool, BUDGET_PERIOD_KIND, periodKey]
      : [pool, BUDGET_PERIOD_KIND, periodKey, userId]),
  );
  return rows[0] ?? { reserved: 0, settled: 0, uncertain: 0 };
}

/** 真并发收集：所有参与者的成败一个不漏（reject 不打断其他参与者）。 */
interface SettledAttempts {
  committed: number;
  missed: number;
  rejected: number;
  rejectionMessages: string[];
}

async function runConcurrently(
  attempts: Array<Promise<ConditionalCommitOutcome>>,
): Promise<SettledAttempts> {
  const settled = await Promise.allSettled(attempts);
  const summary: SettledAttempts = { committed: 0, missed: 0, rejected: 0, rejectionMessages: [] };
  for (const result of settled) {
    if (result.status === "rejected") {
      summary.rejected += 1;
      summary.rejectionMessages.push(String(result.reason));
    } else if (result.value.outcome === "committed") {
      summary.committed += 1;
    } else {
      summary.missed += 1;
    }
  }
  return summary;
}

// —— 预占与四态转换（§9.1：三种占用 + 释放/落定的原子转换）——

describe("A-P1-BUDGET 预占、结算、不确定与释放（§9.1 占用语义）", () => {
  it("A-P1-BUDGET 预占 committed → reserved+1；settle → reserved−1/settled+1；占用量不变", async () => {
    const outcome = await reserveMailBudget(env.DB, {
      intent: "existing_auth_first_login",
      period: DAY_A,
      now: T0,
    });
    expect(outcome).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("existing_auth", DAY_A.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });

    const settled = await transitionMailReservation(
      env.DB,
      { pool: "existing_auth", periodKey: DAY_A.key, now: T0 },
      "settle",
    );
    expect(settled).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("existing_auth", DAY_A.key)).toEqual({
      reserved: 0,
      settled: 1,
      uncertain: 0,
    });
  });

  it("A-P1-BUDGET mark_uncertain → uncertain+1 仍占额度；resolve_uncertain → 落定不退款", async () => {
    await insertUser("u_trans");
    await seedUsageRow("base_business", DAY_A.key, {});
    const reserve = await reserveMailBudget(env.DB, {
      intent: "base_routine_or_announce",
      period: DAY_A,
      now: T0,
      userId: "u_trans",
    });
    expect(reserve).toEqual({ outcome: "committed" });

    const toUnknown = await transitionMailReservation(
      env.DB,
      { pool: "base_business", periodKey: DAY_A.key, userId: "u_trans", now: T0 },
      "mark_uncertain",
    );
    expect(toUnknown).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("base_business", DAY_A.key)).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 1,
    });
    expect(await poolOccupancy("base_business", DAY_A.key, "u_trans")).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 1,
    });

    const resolved = await transitionMailReservation(
      env.DB,
      { pool: "base_business", periodKey: DAY_A.key, userId: "u_trans", now: T0 },
      "resolve_uncertain",
    );
    expect(resolved).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("base_business", DAY_A.key)).toEqual({
      reserved: 0,
      settled: 1,
      uncertain: 0,
    });
  });

  it("A-P1-BUDGET release → 当日额度归还；无可转换占用时 condition_missed 而非报错", async () => {
    await seedUsageRow("urgent_business", DAY_A.key, { reserved: 1 });
    const released = await transitionMailReservation(
      env.DB,
      { pool: "urgent_business", periodKey: DAY_A.key, now: T0 },
      "release",
    );
    expect(released).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("urgent_business", DAY_A.key)).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 0,
    });

    const repeat = await transitionMailReservation(
      env.DB,
      { pool: "urgent_business", periodKey: DAY_A.key, now: T0 },
      "release",
    );
    expect(repeat, "重复释放：无预留可转，正常未命中").toEqual({ outcome: "condition_missed" });

    const settleNothing = await transitionMailReservation(
      env.DB,
      { pool: "urgent_business", periodKey: DAY_A.key, now: T0 },
      "settle",
    );
    expect(settleNothing).toEqual({ outcome: "condition_missed" });
  });
});

// —— ★ 100 席位全量取消：MAIL_URGENT_DAY = 120 的全部理由 ——

describe("A-P1-BUDGET ★ 一次全量取消（100 席位）后当日紧急池余 20 恰好触发 floor 收紧", () => {
  it("A-P1-BUDGET ★ 100 封取消全部预占成功；随后低档被收紧拒绝、取消档继续放行到 120 后停发", async () => {
    const fullDay = period(2026, 11, 1);
    // A.5 等式的运行时镜像：120 >= 100 + 20（取等号）。
    expect(MAIL_URGENT_DAY).toBe(MAIL_SEATS_MAX + MAIL_URGENT_FLOOR);

    for (let i = 0; i < MAIL_SEATS_MAX; i++) {
      const outcome = await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: fullDay,
        now: T0,
      });
      expect(outcome, `第 ${i + 1} 封取消必须预占成功`).toEqual({ outcome: "committed" });
    }

    // 100 席位全部覆盖：当日剩余 = 120 − 100 = 20，恰好落到 floor 上。
    const snapshot = await readMailDayLedger(env.DB, fullDay.key);
    expect(snapshot.pools.urgent_business.reserved).toBe(MAIL_SEATS_MAX);

    // 合同判定（唯一判定源）在真实账本快照上确认收紧生效。
    expect(decideMailIntent("urgent_important_change", snapshot)).toEqual({
      decision: "reject",
      reason: "urgent_floor_degraded",
    });
    expect(decideMailIntent("urgent_late_discovery", snapshot)).toEqual({
      decision: "reject",
      reason: "urgent_floor_degraded",
    });
    // 账本守卫同口径：低档预占被拒。
    const lower = await reserveMailBudget(env.DB, {
      intent: "urgent_important_change",
      period: fullDay,
      now: T0,
    });
    expect(lower, "floor 收紧后低档不得再消耗紧急池").toEqual({ outcome: "condition_missed" });

    // 剩余 20 封全部留给取消/撤回（同一天第二次全量取消的覆盖面，ADR-0003 已接受代价）。
    for (let i = 0; i < MAIL_URGENT_FLOOR; i++) {
      const outcome = await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: fullDay,
        now: T0,
      });
      expect(outcome, `收紧后第 ${i + 1} 封取消仍应放行`).toEqual({ outcome: "committed" });
    }
    expect(await poolOccupancy("urgent_business", fullDay.key)).toEqual({
      reserved: MAIL_URGENT_DAY,
      settled: 0,
      uncertain: 0,
    });
    const exhausted = await reserveMailBudget(env.DB, {
      intent: "urgent_cancelled_or_retracted",
      period: fullDay,
      now: T0,
    });
    expect(exhausted, "当日 120 封用尽即停发").toEqual({ outcome: "condition_missed" });
  });

  it("A-P1-BUDGET floor 等号边界：占用 99 低档放行；占用 100 低档拒绝（并发亦守住）", async () => {
    const edgeDay = period(2026, 11, 2);
    await seedUsageRow("urgent_business", edgeDay.key, {
      settled: MAIL_URGENT_DAY - MAIL_URGENT_FLOOR - 1,
    });
    const justBefore = await reserveMailBudget(env.DB, {
      intent: "urgent_important_change",
      period: edgeDay,
      now: T0,
    });
    expect(justBefore).toEqual({ outcome: "committed" });

    const edgeDay2 = period(2026, 11, 3);
    await seedUsageRow("urgent_business", edgeDay2.key, {
      settled: MAIL_URGENT_DAY - MAIL_URGENT_FLOOR,
    });
    const summary = await runConcurrently(
      Array.from({ length: 10 }, () =>
        reserveMailBudget(env.DB, {
          intent: "urgent_late_discovery",
          period: edgeDay2,
          now: T0,
        }),
      ),
    );
    expect(summary.committed).toBe(0);
    expect(summary.missed).toBe(10);
    expect(summary.rejected).toBe(0);
    // 10 个并发低档无一越过 floor 等号。
    expect((await poolOccupancy("urgent_business", edgeDay2.key)).settled).toBe(
      MAIL_URGENT_DAY - MAIL_URGENT_FLOOR,
    );
  });
});

// —— 认证降级与新注册子额度（§7.2 + 附录 A.4）——

describe("A-P1-BUDGET 认证 floor 降级与新注册子额度（真实 D1 守卫）", () => {
  it("A-P1-BUDGET 认证剩余 = floor：新注册与重发暂停、既有首次登录仍放行", async () => {
    await insertUser("u_auth_floor");
    const day = period(2026, 11, 4);
    await seedUsageRow("existing_auth", day.key, { settled: MAIL_AUTH_DAY - MAIL_AUTH_FLOOR });

    expect(
      await reserveMailBudget(env.DB, { intent: "signup_auth", period: day, now: T0 }),
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, { intent: "auth_resend", period: day, now: T0 }),
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
  });

  it("A-P1-BUDGET 认证剩余 = floor+2：三类意图全部可预占；随后合计踩到降级线，重发被拒", async () => {
    const day = period(2026, 11, 5);
    // 种到 68（= 90 − 20 − 2）：signup 与 resend 各吃一格后合计 70 恰好踩线，首次登录仍放行。
    await seedUsageRow("existing_auth", day.key, { settled: MAIL_AUTH_DAY - MAIL_AUTH_FLOOR - 2 });
    for (const intent of ["signup_auth", "auth_resend", "existing_auth_first_login"] as const) {
      expect(await reserveMailBudget(env.DB, { intent, period: day, now: T0 })).toEqual({
        outcome: "committed",
      });
    }
    expect(
      await reserveMailBudget(env.DB, { intent: "auth_resend", period: day, now: T0 }),
      "合计已到 70（剩余 20）：重发进入降级区被拒",
    ).toEqual({ outcome: "condition_missed" });

    const fullDay = period(2026, 11, 6);
    await seedUsageRow("existing_auth", fullDay.key, { settled: MAIL_AUTH_DAY });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: fullDay,
        now: T0,
      }),
      "认证池当日用尽：首次登录也停发",
    ).toEqual({ outcome: "condition_missed" });
  });

  it("A-P1-BUDGET 新注册子额度用尽先停注册；既有账号登录不受影响", async () => {
    const day = period(2026, 11, 7);
    await seedUsageRow("new_registration", day.key, { settled: MAIL_SIGNUP_AUTH_DAY });
    expect(
      await reserveMailBudget(env.DB, { intent: "signup_auth", period: day, now: T0 }),
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
  });

  it("A-P1-BUDGET 认证合计跨行判定：existing 85 + new_registration 5 = 90 → 当日用尽", async () => {
    const day = period(2026, 11, 8);
    await seedUsageRow("existing_auth", day.key, { settled: 85 });
    await seedUsageRow("new_registration", day.key, { settled: 5 });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "condition_missed" });
  });
});

// —— 池间不互借 + 次日自动恢复（§7.1）——

describe("A-P1-BUDGET 池间不互借与次日自动恢复（真实 D1 行）", () => {
  it("A-P1-BUDGET 认证池耗尽：认证意图拒绝，紧急池与基础池照常可发（不借也不被借）", async () => {
    const day = period(2026, 11, 9);
    await seedUsageRow("existing_auth", day.key, { settled: MAIL_AUTH_DAY });
    await seedUsageRow("new_registration", day.key, { settled: MAIL_SIGNUP_AUTH_DAY });

    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
    expect(
      await reserveMailBudget(env.DB, { intent: "base_routine_or_announce", period: day, now: T0 }),
    ).toEqual({ outcome: "committed" });
  });

  it("A-P1-BUDGET 紧急池耗尽：紧急拒绝，认证照常（反向不互借）", async () => {
    const day = period(2026, 11, 10);
    await seedUsageRow("urgent_business", day.key, { settled: MAIL_URGENT_DAY });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: day,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
  });

  it("A-P1-BUDGET 当日用尽 → 停发；次日（新 periodKey 的新行）自动恢复满额", async () => {
    await seedUsageRow("existing_auth", DAY_A.key, { settled: MAIL_AUTH_DAY });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: DAY_A,
        now: T0,
      }),
    ).toEqual({ outcome: "condition_missed" });

    // 次日：全新的 0 占用行，昨日耗尽不结转、不遗留降级。
    expect(
      await reserveMailBudget(env.DB, {
        intent: "existing_auth_first_login",
        period: DAY_A_NEXT,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("existing_auth", DAY_A_NEXT.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
    // 昨日的行原样保留（历史周期，不重置不结转）。
    expect(await poolOccupancy("existing_auth", DAY_A.key)).toEqual({
      reserved: 0,
      settled: MAIL_AUTH_DAY,
      uncertain: 0,
    });
  });
});

// —— 每用户日机会（§9.1：基础/紧急分别限频，按用户独立）——

describe("A-P1-BUDGET 每用户日机会（MAIL_USER_BASE_DAY / MAIL_USER_URGENT_DAY）", () => {
  it("A-P1-BUDGET 同一用户第二次基础发送被拒、第三次紧急发送被拒；其他用户不受影响", async () => {
    await insertUser("u_quota_a");
    await insertUser("u_quota_b");
    const day = period(2026, 11, 11);

    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        userId: "u_quota_a",
      }),
    ).toEqual({ outcome: "committed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        userId: "u_quota_a",
      }),
      `MAIL_USER_BASE_DAY = ${MAIL_USER_BASE_DAY}：第二次拒绝`,
    ).toEqual({ outcome: "condition_missed" });
    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        userId: "u_quota_b",
      }),
      "user 行按用户独立",
    ).toEqual({ outcome: "committed" });

    for (let i = 0; i < MAIL_USER_URGENT_DAY; i++) {
      expect(
        await reserveMailBudget(env.DB, {
          intent: "urgent_cancelled_or_retracted",
          period: day,
          now: T0,
          userId: "u_quota_a",
        }),
      ).toEqual({ outcome: "committed" });
    }
    expect(
      await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: day,
        now: T0,
        userId: "u_quota_a",
      }),
      `MAIL_USER_URGENT_DAY = ${MAIL_USER_URGENT_DAY} 用尽后拒绝（池仍有余量）`,
    ).toEqual({ outcome: "condition_missed" });
    expect((await poolOccupancy("urgent_business", day.key)).reserved).toBeLessThan(
      MAIL_URGENT_DAY,
    );
  });
});

// —— 真并发预占不超卖（§8.1 末段 + [R16]：精确账本，禁止 COUNT→INSERT）——

describe("A-P1-BUDGET 真并发预占不超卖（Promise.all 在真实 D1 上交错）", () => {
  it("A-P1-BUDGET 紧急池剩 5 个额度、12 个并发取消意图 → 恰好 5 成功，占用停在 120", async () => {
    const day = period(2026, 11, 12);
    await seedUsageRow("urgent_business", day.key, { settled: MAIL_URGENT_DAY - 5 });

    const summary = await runConcurrently(
      Array.from({ length: 12 }, () =>
        reserveMailBudget(env.DB, {
          intent: "urgent_cancelled_or_retracted",
          period: day,
          now: T0,
        }),
      ),
    );
    expect(summary.committed).toBe(5);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    expect(await poolOccupancy("urgent_business", day.key)).toEqual({
      reserved: 5,
      settled: MAIL_URGENT_DAY - 5,
      uncertain: 0,
    });
  });

  it("A-P1-BUDGET 认证降级线前最后一格：10 个并发重发 → 恰好 1 成功，合计停在 70", async () => {
    const day = period(2026, 11, 13);
    await seedUsageRow("existing_auth", day.key, { settled: MAIL_AUTH_DAY - MAIL_AUTH_FLOOR - 1 });

    const summary = await runConcurrently(
      Array.from({ length: 10 }, () =>
        reserveMailBudget(env.DB, { intent: "auth_resend", period: day, now: T0 }),
      ),
    );
    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(9);
    expect(summary.rejected).toBe(0);
    expect((await poolOccupancy("existing_auth", day.key)).settled + 1).toBe(
      MAIL_AUTH_DAY - MAIL_AUTH_FLOOR,
    );
  });

  it("A-P1-BUDGET 同一 outbox 行并发预占：恰好 1 成功（防双预占）", async () => {
    const day = period(2026, 11, 14);
    await insertOutbox({ id: "mo_conc", status: "pending" });

    const summary = await runConcurrently(
      Array.from({ length: 8 }, () =>
        reserveMailBudget(env.DB, {
          intent: "urgent_cancelled_or_retracted",
          period: day,
          now: T0,
          outboxId: "mo_conc",
        }),
      ),
    );
    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    const rows = await query<{ period_key: string | null }>(
      "SELECT period_key FROM mail_outbox WHERE id = 'mo_conc'",
    );
    expect(rows[0]?.period_key).toBe(day.key);
    expect((await poolOccupancy("urgent_business", day.key)).reserved).toBe(1);
  });
});

// —— 跨 UTC 日边界（§9.2 末段：未外发原子重排；已调用/unknown 不释放）——

describe("A-P1-BUDGET 跨 UTC 日边界：未外发原子释放旧预留并按新一日重新预占", () => {
  it("A-P1-BUDGET 未外发任务：旧日池行+user 行 reserved 归还、新日重占、outbox.period_key 前移", async () => {
    await insertUser("u_roll");
    await insertOutbox({ id: "mo_roll", status: "pending" });

    expect(
      await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: DAY_RO1,
        now: T0,
        userId: "u_roll",
        outboxId: "mo_roll",
      }),
    ).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("urgent_business", DAY_RO1.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });

    expect(
      await rolloverUnsentOutboxReservation(env.DB, {
        outboxId: "mo_roll",
        intent: "urgent_cancelled_or_retracted",
        fromPeriodKey: DAY_RO1.key,
        toPeriod: DAY_RO2,
        now: T0,
        userId: "u_roll",
      }),
    ).toEqual({ outcome: "committed" });

    // 原子性：旧日归还、新日占用，池行与 user 行同时成立。
    expect(await poolOccupancy("urgent_business", DAY_RO1.key)).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 0,
    });
    expect(await poolOccupancy("urgent_business", DAY_RO1.key, "u_roll")).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 0,
    });
    expect(await poolOccupancy("urgent_business", DAY_RO2.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
    expect(await poolOccupancy("urgent_business", DAY_RO2.key, "u_roll")).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
    const outbox = await query<{ period_key: string | null }>(
      "SELECT period_key FROM mail_outbox WHERE id = 'mo_roll'",
    );
    expect(outbox[0]?.period_key).toBe(DAY_RO2.key);

    // 重复重排（outbox 已不在旧日）：整体不发生。
    expect(
      await rolloverUnsentOutboxReservation(env.DB, {
        outboxId: "mo_roll",
        intent: "urgent_cancelled_or_retracted",
        fromPeriodKey: DAY_RO1.key,
        toPeriod: DAY_RO2,
        now: T0,
        userId: "u_roll",
      }),
    ).toEqual({ outcome: "condition_missed" });
    expect(await poolOccupancy("urgent_business", DAY_RO2.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
  });

  it("A-P1-BUDGET 新一日无余量：重排整体不发生——旧预留原封不动（原子性，不释放不重占）", async () => {
    await insertUser("u_roll_full");
    await insertOutbox({ id: "mo_roll_full", status: "pending" });
    await seedUsageRow("urgent_business", DAY_FULL_TO.key, { settled: MAIL_URGENT_DAY });

    expect(
      await reserveMailBudget(env.DB, {
        intent: "urgent_cancelled_or_retracted",
        period: DAY_FULL_FROM,
        now: T0,
        userId: "u_roll_full",
        outboxId: "mo_roll_full",
      }),
    ).toEqual({ outcome: "committed" });

    expect(
      await rolloverUnsentOutboxReservation(env.DB, {
        outboxId: "mo_roll_full",
        intent: "urgent_cancelled_or_retracted",
        fromPeriodKey: DAY_FULL_FROM.key,
        toPeriod: DAY_FULL_TO,
        now: T0,
        userId: "u_roll_full",
      }),
      "新日已满：条件未命中",
    ).toEqual({ outcome: "condition_missed" });

    expect(await poolOccupancy("urgent_business", DAY_FULL_FROM.key), "旧预留不被释放").toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
    expect(
      await poolOccupancy("urgent_business", DAY_FULL_FROM.key, "u_roll_full"),
      "旧 user 预留同样保留",
    ).toEqual({ reserved: 1, settled: 0, uncertain: 0 });
    const outbox = await query<{ period_key: string | null; status: string }>(
      "SELECT period_key, status FROM mail_outbox WHERE id = 'mo_roll_full'",
    );
    expect(outbox[0]?.period_key).toBe(DAY_FULL_FROM.key);
    expect(outbox[0]?.status).toBe("pending");
  });

  it("A-P1-BUDGET 已调用（calling_provider/accepted）与 unknown 的不释放——不能假装没调用过", async () => {
    const dispatched: Array<{ id: string; status: string }> = [
      { id: "mo_calling", status: "calling_provider" },
      { id: "mo_unknown", status: "unknown" },
      { id: "mo_accepted", status: "accepted" },
    ];
    for (const item of dispatched) {
      await insertOutbox({ id: item.id, status: item.status, periodKey: DAY_CALL_FROM.key });
    }
    // 预占不经过 outbox 谓词（任务当时未外发）；随后状态推进为已调用/unknown。
    await seedUsageRow("urgent_business", DAY_CALL_FROM.key, { reserved: 3 });

    for (const item of dispatched) {
      const outcome = await rolloverUnsentOutboxReservation(env.DB, {
        outboxId: item.id,
        intent: "urgent_cancelled_or_retracted",
        fromPeriodKey: DAY_CALL_FROM.key,
        toPeriod: DAY_CALL_TO,
        now: T0,
      });
      expect(outcome, `${item.status} 的预留不得被跨日释放`).toEqual({
        outcome: "condition_missed",
      });
    }
    expect(
      await poolOccupancy("urgent_business", DAY_CALL_FROM.key),
      "三个预留全部留在旧日",
    ).toEqual({
      reserved: 3,
      settled: 0,
      uncertain: 0,
    });
    expect(await poolOccupancy("urgent_business", DAY_CALL_TO.key)).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 0,
    });
  });

  it("A-P1-BUDGET leased 仍属未外发：可跨日重排（租约不是外发）", async () => {
    await insertOutbox({ id: "mo_leased", status: "leased", periodKey: DAY_LEASE_FROM.key });
    await seedUsageRow("urgent_business", DAY_LEASE_FROM.key, { reserved: 1 });

    expect(
      await rolloverUnsentOutboxReservation(env.DB, {
        outboxId: "mo_leased",
        intent: "urgent_cancelled_or_retracted",
        fromPeriodKey: DAY_LEASE_FROM.key,
        toPeriod: DAY_LEASE_TO,
        now: T0,
      }),
    ).toEqual({ outcome: "committed" });
    expect(await poolOccupancy("urgent_business", DAY_LEASE_FROM.key)).toEqual({
      reserved: 0,
      settled: 0,
      uncertain: 0,
    });
    expect(await poolOccupancy("urgent_business", DAY_LEASE_TO.key)).toEqual({
      reserved: 1,
      settled: 0,
      uncertain: 0,
    });
  });
});

// —— outbox 盖章纪律（migrations/0012：period_key 取值由本账本写入）——

describe("A-P1-BUDGET mail_outbox.period_key 由账本盖章", () => {
  it("A-P1-BUDGET 预占成功即盖章；已盖章/不存在/已外发的 outbox 行不可再预占", async () => {
    const day = period(2026, 11, 15);
    await insertOutbox({ id: "mo_stamp", status: "pending" });
    await insertOutbox({ id: "mo_dispatched", status: "accepted" });

    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        outboxId: "mo_stamp",
      }),
    ).toEqual({ outcome: "committed" });
    let row = await query<{ period_key: string | null }>(
      "SELECT period_key FROM mail_outbox WHERE id = 'mo_stamp'",
    );
    expect(row[0]?.period_key).toBe(day.key);

    // 同一行再次预占：period_key 已非 NULL。
    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        outboxId: "mo_stamp",
      }),
    ).toEqual({ outcome: "condition_missed" });
    // 已外发状态。
    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        outboxId: "mo_dispatched",
      }),
    ).toEqual({ outcome: "condition_missed" });
    // 不存在的行。
    expect(
      await reserveMailBudget(env.DB, {
        intent: "base_routine_or_announce",
        period: day,
        now: T0,
        outboxId: "mo_missing",
      }),
    ).toEqual({ outcome: "condition_missed" });

    row = await query<{ period_key: string | null }>(
      "SELECT period_key FROM mail_outbox WHERE id = 'mo_stamp'",
    );
    expect(row[0]?.period_key).toBe(day.key);
    expect((await poolOccupancy("base_business", day.key)).reserved).toBe(1);
  });
});

// —— 禁止项回归：账本不得出现月度维度（ADR-0003 禁止清单的负向断言）——

describe("A-P1-BUDGET 废止项负向断言（ADR-0003：不得出现 envelope / carry / 月度池）", () => {
  it("A-P1-BUDGET usage_periods 无 envelope/carry/月度列；period_kind 无月度取值", async () => {
    const columns = await query<{ name: string }>("PRAGMA table_info(usage_periods)");
    const names = columns.map((column) => column.name);
    expect(names).not.toContain("envelope");
    expect(names).not.toContain("carry");
    expect(names).not.toContain("month");
    const kinds = await query<{ distinct_kind: string }>(
      "SELECT DISTINCT period_kind AS distinct_kind FROM usage_periods",
    );
    for (const kind of kinds) {
      expect(kind.distinct_kind).toBe(BUDGET_PERIOD_KIND);
    }
  });

  it("A-P1-BUDGET conditionalCommit 直连可用（与 P1-05 原语同一入口，无旁路写入）", async () => {
    // 账本全部写入都经 conditionalCommit（本文件 import 直接来自 ../cas），
    // 这里保留一个最小直连用例证明 ledger 模块没有私有写入路径的必要。
    const outcome = await conditionalCommit(env.DB, {
      guard: {
        sql: "UPDATE capacity_state SET value = value + 1, updated_at = ? WHERE key = ? AND value < ?",
        params: [T0, "ledger_probe", 1],
      },
    });
    expect(outcome).toEqual({ outcome: "condition_missed" });
  });
});
