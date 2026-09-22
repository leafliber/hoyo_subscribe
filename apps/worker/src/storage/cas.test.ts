// A-P1-CAS · 条件提交（CAS）原语与并发测试（任务卡 P1-05）。
// 验收定义（docs/ACCEPTANCE.md）：
//   1) CAS 零行后续写入不生效（含★回归对：先证明朴素 batch 确实会漏，再证明原语拦住）；
//   2) 数据库报错与条件未命中分别有用例、行为不同（reject 回滚 vs 正常返回 condition_missed）；
//   3) batch 部分成功不得留下半成品状态（报错后守卫更新一并回滚）。
// 并发用例（§8.1 末段场景）：注册预占、挑战消费、会话激活、配置 CAS 用真并发（Promise.all）；
// Feed 换 token、退订、名额释放同样落在同一条件提交边界内。
// 测试在真实 workerd + miniflare D1 上执行（@cloudflare/vitest-pool-workers），与部署引擎一致；
// 本地与生产 D1 的行为差异以 P0-01 证据（d1-conditional-tx-20260921T165034Z.json）为准。

import { env } from "cloudflare:test";
import {
  ACCOUNT_MAX_STORED,
  OTP_TTL,
  SESSION_ABSOLUTE_TTL,
  SESSION_ACTIVE_MAX,
  SESSION_PENDING_TTL,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { releaseAdmissionSlot, reserveAdmissionSlot } from "./admission";
import { type ConditionalCommitOutcome, conditionalCommit } from "./cas";
import { splitSqlStatements } from "./split-sql";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}

const migrationFiles = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

// 合成基准时刻与时间常数（纯合成数据，无真实邮箱/主机/密钥）。
const T0 = 1_800_000_000_000;
const SECOND = 1_000;

// —— 迁移重放（与 A-P1-DB 的 schema.test 同一纪律：空库顺序重放，本文件自足）——

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

async function insertUser(
  id: string,
  opts?: { authEpoch?: number; emailKey?: string },
): Promise<void> {
  await run(
    'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, auth_epoch, recovery_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)',
    id,
    orderSeq++,
    "active",
    opts?.emailKey ?? `ek_${id}`,
    `eb_${id}`,
    new Uint8Array([1, 2, 3, 4]),
    opts?.authEpoch ?? 0,
    T0,
    T0,
  );
}

async function insertSubscription(userId: string, revision: number): Promise<void> {
  await run(
    "INSERT INTO user_subscriptions (user_id, state, schema_version, revision, scope_json, calendar_json, notifications_json, created_at, updated_at) VALUES (?, 'initialized', 3, ?, ?, ?, ?, ?, ?)",
    userId,
    revision,
    JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
    JSON.stringify({ event_types: ["livestream"], node_types: ["start"], alarms_enabled: true }),
    JSON.stringify({ rule_ids: [], new_event: false, important_change: true }),
    T0,
    T0,
  );
}

async function insertChallenge(
  id: string,
  userId: string,
  opts?: { deadline?: number },
): Promise<void> {
  await run(
    "INSERT INTO auth_challenges (id, purpose, email_key, address_version, preauth_id, idempotency_key, mac, generation, attempts, deadline, created_at, updated_at) VALUES (?, 'login', ?, 1, ?, NULL, ?, 0, 0, ?, ?, ?)",
    id,
    `ek_${userId}`,
    `pa_${id}`,
    `mac_${id}`,
    opts?.deadline ?? T0 + OTP_TTL * SECOND,
    T0,
    T0,
  );
}

interface SessionFixture {
  id: string;
  userId: string;
  state: "pending" | "active";
  authEpoch?: number;
}

async function insertSession(fixture: SessionFixture): Promise<void> {
  const absolute = T0 + SESSION_ABSOLUTE_TTL * SECOND;
  const expires =
    fixture.state === "pending" ? T0 + SESSION_PENDING_TTL * SECOND : absolute - 600 * SECOND;
  await run(
    "INSERT INTO sessions (id, user_id, token_hash, state, label, platform_hint, issued_at, absolute_expires_at, expires_at, renewed_at, auth_epoch, recovery_epoch, activated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    fixture.id,
    fixture.userId,
    `th_${fixture.id}`,
    fixture.state,
    `synthetic ${fixture.id}`,
    T0,
    absolute,
    expires,
    T0,
    fixture.authEpoch ?? 0,
    fixture.state === "active" ? T0 : null,
    T0,
    T0,
  );
}

async function insertEmailChannel(userId: string, revision: number): Promise<void> {
  await run(
    "INSERT INTO email_channels (user_id, enabled, routine_enabled, consent_version, address_version, channel_revision, created_at, updated_at) VALUES (?, 1, 1, 1, 1, ?, ?, ?)",
    userId,
    revision,
    T0,
    T0,
  );
}

async function insertFeed(userId: string): Promise<void> {
  await run(
    "INSERT INTO calendar_feeds (user_id, namespace, state, token_hash, token_ciphertext, token_generation, view_revision, changed_at, created_at, updated_at) VALUES (?, ?, 'enabled', ?, ?, 3, 5, ?, ?, ?)",
    userId,
    `ns-synthetic-${userId}`,
    `fth_${userId}`,
    new Uint8Array([9, 8, 7, 6]),
    T0,
    T0,
    T0,
  );
}

async function countRows(table: string, where: string, ...params: unknown[]): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    ...params,
  );
  return rows[0]?.n ?? -1;
}

async function scalar<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, ...params);
  return rows[0] ?? null;
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

// —— ★ 回归对：失败模式必须存在，且被原语消灭 ——

describe("A-P1-CAS ★ 回归对（任务卡关键约束：batch 的 SQL 失败回滚 ≠ CAS 零行自动失败）", () => {
  it("A-P1-CAS ★a 朴素实现：CAS 零行时同批 INSERT 照样落库（失败模式在真实 D1 上存在）", async () => {
    const userId = "u_star_a";
    await insertUser(userId);
    await insertSubscription(userId, 6);

    // 朴素写法：CAS（expected revision = 5，实际已是 6）与审计 INSERT 放进同一个 batch。
    // P0-01 E2 已实测此形态会漏；这里在业务表上复现，作为 ★b 有效性的存在性证明。
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE user_subscriptions SET revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
      ).bind(T0, userId, 5),
      env.DB.prepare(
        "INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, reason, created_at, expires_at) VALUES (?, 'system', 'synthetic', 'naive-cas-leak', 'user_subscription', ?, 'synthetic', ?, ?)",
      ).bind("al_star_a", userId, T0, T0 + 1),
    ]);

    expect(results[0]?.meta?.changes, "CAS 未命中：零行、无报错").toBe(0);
    expect(results[1]?.meta?.changes, "同批 INSERT 照常生效——这就是要消灭的失败模式").toBe(1);
    const leaked = await countRows("audit_log", "id = ?", "al_star_a");
    expect(leaked, "朴素 batch 在 CAS 零行时留下了依赖写入").toBe(1);
    const revision = await scalar<{ revision: number }>(
      "SELECT revision FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    expect(revision?.revision).toBe(6);
  });

  it("A-P1-CAS ★b 原语：同一场景条件未命中，依赖写入不生效", async () => {
    const userId = "u_star_b";
    await insertUser(userId);
    await insertSubscription(userId, 6);

    const outcome = await conditionalCommit(env.DB, {
      guard: {
        sql: "UPDATE user_subscriptions SET revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
        params: [T0, userId, 5],
      },
      effects: [
        {
          kind: "insert",
          table: "audit_log",
          columns: [
            "id",
            "actor_type",
            "actor_id",
            "action",
            "target_type",
            "target_id",
            "reason",
            "created_at",
            "expires_at",
          ],
          rows: [
            [
              "al_star_b",
              "system",
              "synthetic",
              "cas-blocked",
              "user_subscription",
              userId,
              "synthetic",
              T0,
              T0 + 1,
            ],
          ],
        },
      ],
    });

    expect(outcome).toEqual({ outcome: "condition_missed" });
    expect(await countRows("audit_log", "id = ?", "al_star_b")).toBe(0);
    const revision = await scalar<{ revision: number }>(
      "SELECT revision FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    expect(revision?.revision).toBe(6);
  });
});

// —— 条件未命中 vs 数据库报错：两种不同行为 ——

describe("A-P1-CAS 条件未命中与数据库报错分别有用例（行为不同）", () => {
  it("A-P1-CAS 条件未命中：守卫零行 → 正常返回 condition_missed，守卫与效果都不生效", async () => {
    const userId = "u_miss";
    await insertUser(userId);
    await insertSubscription(userId, 6);

    const outcome = await conditionalCommit(env.DB, {
      guard: {
        sql: "UPDATE user_subscriptions SET notifications_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
        params: [JSON.stringify({ rule_ids: [], new_event: true }), T0, userId, 5],
      },
      effects: [
        {
          kind: "insert",
          table: "subscription_interests",
          columns: [
            "id",
            "user_id",
            "game",
            "region",
            "interest_kind",
            "interest_id",
            "enabled_at",
          ],
          rows: [["si_miss_1", userId, "genshin", "CN", "change_switch", "important_change", T0]],
        },
      ],
    });

    expect(outcome, "陈旧 expected_revision 是正常控制流，不是错误").toEqual({
      outcome: "condition_missed",
    });
    expect(await countRows("subscription_interests", "user_id = ?", userId)).toBe(0);
    const revision = await scalar<{ revision: number }>(
      "SELECT revision FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    expect(revision?.revision).toBe(6);
  });

  it("A-P1-CAS 数据库报错：效果语句撞主键 → reject，且整批回滚不留半成品（守卫更新一并撤销）", async () => {
    const userId = "u_dberr";
    await insertUser(userId);
    await insertSubscription(userId, 6);
    await run(
      "INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, reason, created_at, expires_at) VALUES (?, 'system', 'synthetic', 'occupied', 'user_subscription', ?, 'synthetic', ?, ?)",
      "al_dberr_taken",
      userId,
      T0,
      T0 + 1,
    );

    await expect(
      conditionalCommit(env.DB, {
        guard: {
          sql: "UPDATE user_subscriptions SET revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
          params: [T0, userId, 6],
        },
        effects: [
          {
            kind: "insert",
            table: "audit_log",
            columns: [
              "id",
              "actor_type",
              "actor_id",
              "action",
              "target_type",
              "target_id",
              "reason",
              "created_at",
              "expires_at",
            ],
            rows: [
              [
                "al_dberr_taken",
                "system",
                "synthetic",
                "cas-db-error",
                "user_subscription",
                userId,
                "synthetic",
                T0,
                T0 + 1,
              ],
            ],
          },
        ],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const revision = await scalar<{ revision: number }>(
      "SELECT revision FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    expect(revision?.revision, "守卫命中过，但报错回滚后不得留下半成品").toBe(6);
  });
});

// —— 并发注册预占 / 名额释放（容量：禁止 COUNT → 无条件 INSERT）——

describe("A-P1-CAS 并发注册预占与名额释放（§8.1：容量判断在同一条件提交边界内）", () => {
  it("A-P1-CAS 并发注册预占：剩 1 个名额、8 个邮箱并发 → 恰好 1 成功 7 未命中，无超卖", async () => {
    // 测试间共享同一 D1：每个用例用自己的容量计数键，互不串账。
    await run(
      "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, ?, 0, ?)",
      "accounts_total_distinct",
      ACCOUNT_MAX_STORED - 1,
      T0,
    );

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) =>
        reserveAdmissionSlot(env.DB, {
          reservationId: `ar_conc_${i}`,
          emailKey: `ek_conc_${i}`,
          kind: "registration",
          now: T0,
          expiresAt: T0 + OTP_TTL * SECOND,
          capacityKey: "accounts_total_distinct",
          capacityCap: ACCOUNT_MAX_STORED,
        }),
      ),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    expect(await countRows("admission_reservations", "state = 'reserved'")).toBe(1);
    const value = await scalar<{ value: number }>(
      "SELECT value FROM capacity_state WHERE key = 'accounts_total_distinct'",
    );
    expect(value?.value, "计数恰好停在容量上限").toBe(ACCOUNT_MAX_STORED);
  });

  it("A-P1-CAS 并发注册预占：名额充足、同一邮箱 8 并发 → 1 成功，输家撞部分唯一索引整批回滚", async () => {
    await run(
      "INSERT INTO capacity_state (key, value, version, updated_at) VALUES ('accounts_total_same', 0, 0, ?)",
      T0,
    );

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) =>
        reserveAdmissionSlot(env.DB, {
          reservationId: `ar_same_${i}`,
          emailKey: "ek_same_email",
          kind: "registration",
          now: T0,
          expiresAt: T0 + OTP_TTL * SECOND,
          capacityKey: "accounts_total_same",
          capacityCap: ACCOUNT_MAX_STORED,
        }),
      ),
    );

    expect(summary.committed).toBe(1);
    expect(summary.rejected).toBe(7);
    expect(summary.rejectionMessages.join("\n")).toMatch(
      /UNIQUE constraint failed.*idx_admission_reservations_open|admission_reservations/,
    );
    const value = await scalar<{ value: number }>(
      "SELECT value FROM capacity_state WHERE key = 'accounts_total_same'",
    );
    expect(value?.value, "输家的计数递增必须随整批回滚（count 只被赢家吃掉一格）").toBe(1);
    expect(
      await countRows(
        "admission_reservations",
        "email_key = ? AND state = 'reserved'",
        "ek_same_email",
      ),
    ).toBe(1);
  });

  it("A-P1-CAS 名额释放：CAS reserved→released 才递减计数并落审计；并发释放只成功一次，释放后名额可再用", async () => {
    await run(
      "INSERT INTO capacity_state (key, value, version, updated_at) VALUES ('accounts_total_release', 11, 0, ?)",
      T0,
    );
    await run(
      "INSERT INTO admission_reservations (id, kind, email_key, state, reserved_at, expires_at, created_at, updated_at) VALUES ('ar_rel_1', 'registration', 'ek_rel', 'reserved', ?, ?, ?, ?)",
      T0,
      T0 + OTP_TTL * SECOND,
      T0,
      T0,
    );

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) =>
        releaseAdmissionSlot(env.DB, {
          reservationId: "ar_rel_1",
          now: T0,
          capacityKey: "accounts_total_release",
          audit: {
            auditId: `al_rel_${i}`,
            actorId: "cleanup-synthetic",
            action: "release-synthetic",
            reason: "synthetic concurrency",
            expiresAt: T0 + 1,
          },
        }),
      ),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    expect(await countRows("audit_log", "action = 'release-synthetic'")).toBe(1);
    const state = await scalar<{ state: string }>(
      "SELECT state FROM admission_reservations WHERE id = 'ar_rel_1'",
    );
    expect(state?.state).toBe("released");
    const value = await scalar<{ value: number }>(
      "SELECT value FROM capacity_state WHERE key = 'accounts_total_release'",
    );
    expect(value?.value, "释放恰好递减一次").toBe(10);

    const reuse = await reserveAdmissionSlot(env.DB, {
      reservationId: "ar_rel_reuse",
      emailKey: "ek_rel_reuse",
      kind: "registration",
      now: T0,
      expiresAt: T0 + OTP_TTL * SECOND,
      capacityKey: "accounts_total_release",
      capacityCap: 11,
    });
    expect(reuse, "释放后的名额回到可用池").toEqual({ outcome: "committed" });
  });
});

// —— 并发挑战消费（一次消费；一次建 pending 会话）——

describe("A-P1-CAS 并发挑战消费（§4.4 原子消费：不出现「会话已建但挑战仍可用」）", () => {
  async function consumeAttempt(
    challengeId: string,
    userId: string,
    sessionId: string,
  ): Promise<ConditionalCommitOutcome> {
    return conditionalCommit(env.DB, {
      guard: {
        sql: "UPDATE auth_challenges SET consumed_at = ?, pending_session_id = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?",
        params: [T0, sessionId, T0, challengeId, T0],
      },
      effects: [
        {
          kind: "insert",
          table: "sessions",
          columns: [
            "id",
            "user_id",
            "token_hash",
            "state",
            "label",
            "platform_hint",
            "issued_at",
            "absolute_expires_at",
            "expires_at",
            "renewed_at",
            "auth_epoch",
            "recovery_epoch",
            "created_at",
            "updated_at",
          ],
          rows: [
            [
              sessionId,
              userId,
              `th_${sessionId}`,
              "pending",
              "synthetic login",
              "unknown",
              T0,
              T0 + SESSION_ABSOLUTE_TTL * SECOND,
              T0 + SESSION_PENDING_TTL * SECOND,
              T0,
              0,
              0,
              T0,
              T0,
            ],
          ],
        },
      ],
    });
  }

  it("A-P1-CAS 并发挑战消费：8 并发消费同一挑战 → 恰好 1 成功并建一个 pending 会话，其余未命中", async () => {
    const userId = "u_consume";
    await insertUser(userId);
    await insertChallenge("ch_consume", userId);

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) => consumeAttempt("ch_consume", userId, `s_consume_${i}`)),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    const consumed = await scalar<{
      consumed_at: number | null;
      pending_session_id: string | null;
    }>("SELECT consumed_at, pending_session_id FROM auth_challenges WHERE id = 'ch_consume'");
    expect(consumed?.consumed_at).not.toBeNull();
    expect(consumed?.pending_session_id).toMatch(/^s_consume_\d$/);
    expect(await countRows("sessions", "id LIKE 's_consume_%'"), "只建了一个 pending 会话").toBe(1);
  });

  it("A-P1-CAS 挑战过期：deadline 已过 → 条件未命中而非报错", async () => {
    const userId = "u_consume_exp";
    await insertUser(userId);
    await insertChallenge("ch_consume_exp", userId, { deadline: T0 - 1 });

    const outcome = await consumeAttempt("ch_consume_exp", userId, "s_consume_exp");

    expect(outcome).toEqual({ outcome: "condition_missed" });
    expect(await countRows("sessions", "id = 's_consume_exp'")).toBe(0);
  });
});

// —— 并发会话激活（pending 不自动挤占 active 名额；epoch 核对）——

describe("A-P1-CAS 并发会话激活（§4.5：名额判断在守卫谓词内，不是 COUNT→写）", () => {
  function activateAttempt(
    sessionId: string,
    userId: string,
    expectedAuthEpoch: number,
  ): Promise<ConditionalCommitOutcome> {
    return conditionalCommit(env.DB, {
      guard: {
        // active 名额是守卫谓词的一部分：计数在原子条件更新内判定，
        // 满额时守卫零行——与「COUNT 后无条件 INSERT」相反（§8.1 末段）。
        // SESSION_ACTIVE_MAX 来自参数注册表（AGENTS.md 硬规则 2）。
        sql: `UPDATE sessions SET state = 'active', activated_at = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND state = 'pending'
                AND (SELECT count(*) FROM sessions WHERE user_id = ? AND state = 'active') < ?
                AND (SELECT auth_epoch FROM users WHERE id = ?) = ?`,
        params: [T0, T0, sessionId, userId, userId, SESSION_ACTIVE_MAX, userId, expectedAuthEpoch],
      },
      effects: [
        {
          kind: "update",
          table: "users",
          set: { last_interactive_at: T0, updated_at: T0 },
          where: { sql: "id = ?", params: [userId] },
        },
      ],
    });
  }

  it("A-P1-CAS 并发会话激活：同一 pending 会话 8 并发 → 恰好 1 成功，users 活动水位只写一次", async () => {
    const userId = "u_act";
    await insertUser(userId);
    await insertSession({ id: "s_act", userId, state: "pending" });

    const summary = await runConcurrently(
      Array.from({ length: 8 }, () => activateAttempt("s_act", userId, 0)),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    const session = await scalar<{ state: string; activated_at: number | null }>(
      "SELECT state, activated_at FROM sessions WHERE id = 's_act'",
    );
    expect(session?.state).toBe("active");
    expect(session?.activated_at).toBe(T0);
    const user = await scalar<{ last_interactive_at: number | null }>(
      "SELECT last_interactive_at FROM users WHERE id = ?",
      userId,
    );
    expect(user?.last_interactive_at).toBe(T0);
  });

  it("A-P1-CAS active 名额边界：已有 SESSION_ACTIVE_MAX-1 个 active、2 个 pending 并发激活 → 只放行 1 个", async () => {
    const userId = "u_act_cap";
    await insertUser(userId);
    for (let i = 0; i < SESSION_ACTIVE_MAX - 1; i++) {
      await insertSession({ id: `s_act_cap_a${i}`, userId, state: "active" });
    }
    await insertSession({ id: "s_act_cap_p1", userId, state: "pending" });
    await insertSession({ id: "s_act_cap_p2", userId, state: "pending" });

    const summary = await runConcurrently([
      activateAttempt("s_act_cap_p1", userId, 0),
      activateAttempt("s_act_cap_p2", userId, 0),
      activateAttempt("s_act_cap_p1", userId, 0),
      activateAttempt("s_act_cap_p2", userId, 0),
    ]);

    expect(summary.committed, "第 5 个名额只放行一个参与者").toBe(1);
    expect(summary.missed + summary.rejected).toBe(3);
    expect(
      await countRows("sessions", "user_id = ? AND state = 'active'", userId),
      `active 总数恰好到 SESSION_ACTIVE_MAX（${SESSION_ACTIVE_MAX}）`,
    ).toBe(SESSION_ACTIVE_MAX);
    const pending = await scalar<{ state: string }>(
      "SELECT state FROM sessions WHERE id IN ('s_act_cap_p1','s_act_cap_p2') AND state = 'pending'",
    );
    expect(pending?.state, "输掉的 pending 保持 pending，不被挤掉也不被误激活").toBe("pending");
  });

  it("A-P1-CAS auth_epoch 已推进：会话与用户代次不匹配 → 激活条件未命中", async () => {
    const userId = "u_act_epoch";
    await insertUser(userId, { authEpoch: 1 });
    await insertSession({ id: "s_act_epoch", userId, state: "pending", authEpoch: 0 });

    const outcome = await activateAttempt("s_act_epoch", userId, 0);

    expect(outcome).toEqual({ outcome: "condition_missed" });
    const session = await scalar<{ state: string }>(
      "SELECT state FROM sessions WHERE id = 's_act_epoch'",
    );
    expect(session?.state).toBe("pending");
  });
});

// —— 并发配置 CAS（expected_revision）——

describe("A-P1-CAS 并发配置 CAS（§5.4：两设备 409 不静默覆盖）", () => {
  it("A-P1-CAS 并发配置 CAS：8 个并发保存同 expected_revision → 恰好 1 成功，revision 只 +1，兴趣行只落一条", async () => {
    const userId = "u_sub";
    await insertUser(userId);
    await insertSubscription(userId, 7);

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) =>
        conditionalCommit(env.DB, {
          guard: {
            sql: "UPDATE user_subscriptions SET scope_json = ?, calendar_json = ?, notifications_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
            params: [
              JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
              JSON.stringify({
                event_types: ["livestream"],
                node_types: ["start"],
                alarms_enabled: true,
              }),
              JSON.stringify({ rule_ids: [], new_event: false, important_change: true }),
              T0,
              userId,
              7,
            ],
          },
          effects: [
            {
              kind: "insert",
              table: "subscription_interests",
              columns: [
                "id",
                "user_id",
                "game",
                "region",
                "interest_kind",
                "interest_id",
                "enabled_at",
              ],
              rows: [
                [`si_sub_${i}`, userId, "genshin", "CN", "change_switch", "important_change", T0],
              ],
            },
          ],
        }),
      ),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    const revision = await scalar<{ revision: number }>(
      "SELECT revision FROM user_subscriptions WHERE user_id = ?",
      userId,
    );
    expect(revision?.revision, "8 个并发保存只推进一个版本").toBe(8);
    expect(await countRows("subscription_interests", "user_id = ?", userId)).toBe(1);
  });
});

// —— Feed 换 token 与退订（同一条件提交边界）——

describe("A-P1-CAS Feed 换 token 与退订（§8.1 末段场景的同一条件边界）", () => {
  it("A-P1-CAS Feed 换 token：8 并发换发同 token_generation → 恰好 1 成功，generation 只 +1，namespace 不变", async () => {
    const userId = "u_feed";
    await insertUser(userId);
    await insertFeed(userId);

    // 换 token 的相关写入只有 feed 行本身：条件边界退化为单条守卫语句，
    // 仍经统一原语（outcome 语义、changes 判定）而非裸 UPDATE。
    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) =>
        conditionalCommit(env.DB, {
          guard: {
            sql: "UPDATE calendar_feeds SET token_hash = ?, token_ciphertext = ?, token_generation = token_generation + 1, token_rotated_at = ?, updated_at = ? WHERE user_id = ? AND token_generation = ? AND state = 'enabled'",
            params: [`fth_new_${i}`, new Uint8Array([i, 2, 3, 4]), T0, T0, userId, 3],
          },
        }),
      ),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    const feed = await scalar<{
      token_generation: number;
      namespace: string;
      state: string;
      token_hash: string;
    }>(
      "SELECT token_generation, namespace, state, token_hash FROM calendar_feeds WHERE user_id = ?",
      userId,
    );
    expect(feed?.token_generation, "并发换发只前进一代").toBe(4);
    expect(feed?.namespace, "namespace 不随换 token 改变（§6.1/§6.4）").toBe(
      `ns-synthetic-${userId}`,
    );
    expect(feed?.state).toBe("enabled");
    expect(feed?.token_hash).toMatch(/^fth_new_\d$/);
  });

  it("A-P1-CAS 退订：CAS 关闭席位与同批落同意事件一起成立；并发退订只成功一次，陈旧 channel_revision 未命中", async () => {
    const userId = "u_unsub";
    await insertUser(userId);
    await insertEmailChannel(userId, 2);

    function unsubscribeAttempt(
      expectedRevision: number,
      eventId: string,
    ): Promise<ConditionalCommitOutcome> {
      return conditionalCommit(env.DB, {
        guard: {
          sql: "UPDATE email_channels SET enabled = 0, routine_enabled = 0, channel_revision = channel_revision + 1, updated_at = ? WHERE user_id = ? AND channel_revision = ? AND (enabled = 1 OR routine_enabled = 1)",
          params: [T0, userId, expectedRevision],
        },
        effects: [
          {
            kind: "insert",
            table: "consent_events",
            columns: [
              "id",
              "user_id",
              "email_binding_id",
              "layer",
              "action",
              "consent_version",
              "created_at",
            ],
            rows: [[eventId, userId, `eb_${userId}`, "seat", "unsubscribe-synthetic", 2, T0]],
          },
        ],
      });
    }

    const summary = await runConcurrently(
      Array.from({ length: 8 }, (_, i) => unsubscribeAttempt(2, `ce_unsub_${i}`)),
    );

    expect(summary.committed).toBe(1);
    expect(summary.missed).toBe(7);
    expect(summary.rejected).toBe(0);
    expect(
      await countRows("consent_events", "user_id = ? AND action = 'unsubscribe-synthetic'", userId),
      "关闭席位与同意事件同批成立，且只成立一次",
    ).toBe(1);
    const channel = await scalar<{
      enabled: number;
      routine_enabled: number;
      channel_revision: number;
    }>(
      "SELECT enabled, routine_enabled, channel_revision FROM email_channels WHERE user_id = ?",
      userId,
    );
    expect(channel?.enabled).toBe(0);
    expect(channel?.routine_enabled, "第二层随席位一起关闭（§7.5 子集约束）").toBe(0);
    expect(channel?.channel_revision).toBe(3);

    const stale = await unsubscribeAttempt(2, "ce_unsub_stale");
    expect(stale, "陈旧 channel_revision：条件未命中，不再新增同意事件").toEqual({
      outcome: "condition_missed",
    });
    expect(
      await countRows("consent_events", "user_id = ? AND action = 'unsubscribe-synthetic'", userId),
    ).toBe(1);
  });
});
