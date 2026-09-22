// A-P1-BUDGET · 操作额度与终止路径（任务卡 P1-07）——L2 测试，真实 workerd + miniflare D1。
// 验收定义（docs/ACCEPTANCE.md + 主方案 §9.5）：
//   USER_MUTATIONS_DAY / GLOBAL_MUTATIONS_DAY 精确计数；**终止路径不被阻断**
//   （退订、Feed 停用、会话撤销、紧急停用、删除）——恢复入口不依赖任何预算（§9.2）。
// 迁移重放纪律与 cas.test.ts 相同：空库顺序重放，本文件自足。

import { env } from "cloudflare:test";
import {
  GLOBAL_MUTATIONS_DAY,
  MAIL_USER_BASE_DAY,
  TERMINATION_MUTATION_ACTIONS,
  USER_MUTATIONS_DAY,
} from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { splitSqlStatements } from "../split-sql";
import { consumeMutationAllowance } from "./mutations";

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

const T0 = 1_800_000_000_000;
const DAY1 = "2026-09-22";
const DAY2 = "2026-09-23";

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

async function readCounter(key: string): Promise<number> {
  const rows = await query<{ value: number }>(
    "SELECT value FROM capacity_state WHERE key = ?",
    key,
  );
  return rows[0]?.value ?? -1;
}

// —— 普通变更：两级上限的原子判定 ——

describe("A-P1-BUDGET USER_MUTATIONS_DAY / GLOBAL_MUTATIONS_DAY 计数（§9.5）", () => {
  it("A-P1-BUDGET 用户日额：第 USER_MUTATIONS_DAY 次成功、下一次拒绝并正确指明原因", async () => {
    const userId = "u_mut_user";
    await seedUserKey(userId, DAY1, USER_MUTATIONS_DAY - 1);
    await seedGlobalKey(DAY1, 0);

    const at = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(at).toEqual({ allowed: true, counted: true, terminationBypass: false });

    const over = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(over).toEqual({
      allowed: false,
      reason: "user_day_exhausted",
      counted: false,
    });
    expect(await readCounter(`mutations:user:${userId}:${DAY1}`)).toBe(USER_MUTATIONS_DAY);
  });

  it("A-P1-BUDGET 全站日额：global 顶格后普通变更拒绝（用户自己还有余量）", async () => {
    const userId = "u_mut_global";
    await seedUserKey(userId, DAY1, 0);
    await seedGlobalKey(DAY1, GLOBAL_MUTATIONS_DAY - 1);

    const at = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(at).toEqual({ allowed: true, counted: true, terminationBypass: false });

    const over = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(over).toEqual({
      allowed: false,
      reason: "global_day_exhausted",
      counted: false,
    });
    expect(await readCounter(`mutations:global:${DAY1}`)).toBe(GLOBAL_MUTATIONS_DAY);
    // 用户行停留在 1：未通过的尝试不消耗用户额度。
    expect(await readCounter(`mutations:user:${userId}:${DAY1}`)).toBe(1);
  });

  it("A-P1-BUDGET 日额按 UTC 日重置：次日同一用户满额恢复（键含日，不结转）", async () => {
    const userId = "u_mut_reset";
    await seedUserKey(userId, DAY1, USER_MUTATIONS_DAY);
    await seedGlobalKey(DAY1, GLOBAL_MUTATIONS_DAY);

    const sameDay = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(sameDay.allowed).toBe(false);

    const nextDay = await consumeMutationAllowance(env.DB, {
      action: "regular_state_change",
      userId,
      utcDayKey: DAY2,
      now: T0,
    });
    expect(nextDay).toEqual({ allowed: true, counted: true, terminationBypass: false });
  });

  it("A-P1-BUDGET 真并发：只剩 1 个用户额度、8 个并发普通变更 → 恰好 1 个成功，global 同步 +1", async () => {
    const userId = "u_mut_conc";
    await seedUserKey(userId, DAY1, USER_MUTATIONS_DAY - 1);
    await seedGlobalKey(DAY1, 0);

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        consumeMutationAllowance(env.DB, {
          action: "regular_state_change",
          userId,
          utcDayKey: DAY1,
          now: T0,
        }),
      ),
    );
    const allowed = settled.filter(
      (result) => result.status === "fulfilled" && result.value.allowed,
    ).length;
    const rejected = settled.filter((result) => result.status === "rejected").length;
    expect(allowed).toBe(1);
    expect(rejected).toBe(0);
    expect(await readCounter(`mutations:user:${userId}:${DAY1}`)).toBe(USER_MUTATIONS_DAY);
    expect(await readCounter(`mutations:global:${DAY1}`)).toBe(1);
  });
});

// —— 终止路径：不被阻断、不消耗额度（§9.5 + §9.2 恢复入口保留条款）——

describe("A-P1-BUDGET 终止路径不被阻断（§9.5：五项终止能力 + 恢复入口不依赖预算）", () => {
  it("A-P1-BUDGET 用户与全站日额全部顶格时，五项终止动作仍然全部放行且不消耗任何计数", async () => {
    const userId = "u_mut_term";
    await seedUserKey(userId, DAY1, USER_MUTATIONS_DAY);
    await seedGlobalKey(DAY1, GLOBAL_MUTATIONS_DAY);

    for (const action of TERMINATION_MUTATION_ACTIONS) {
      const decision = await consumeMutationAllowance(env.DB, {
        action,
        userId,
        utcDayKey: DAY1,
        now: T0,
      });
      expect(decision, `${action} 不得被普通修改日额阻断`).toEqual({
        allowed: true,
        counted: false,
        terminationBypass: true,
      });
    }
    // 终止零写入：两级计数原样停在顶格值。
    expect(await readCounter(`mutations:user:${userId}:${DAY1}`)).toBe(USER_MUTATIONS_DAY);
    expect(await readCounter(`mutations:global:${DAY1}`)).toBe(GLOBAL_MUTATIONS_DAY);
  });

  it("A-P1-BUDGET 邮件预算同样不拦终止/恢复：认证池与紧急池全部耗尽的快照不影响终止判定", async () => {
    // 账本两侧互不相干的机制性证明：终止判定不读 usage_periods，也不读邮件容量行。
    const userId = "u_mut_term2";
    await seedUserKey(userId, DAY1, USER_MUTATIONS_DAY);
    await seedGlobalKey(DAY1, GLOBAL_MUTATIONS_DAY);
    await run(
      "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, ?, 0, ?)",
      `ledger-probe:${DAY1}`,
      MAIL_USER_BASE_DAY,
      T0,
    );

    const decision = await consumeMutationAllowance(env.DB, {
      action: "emergency_deactivation",
      userId,
      utcDayKey: DAY1,
      now: T0,
    });
    expect(decision).toEqual({ allowed: true, counted: false, terminationBypass: true });
  });
});

// —— 夹具 ——

async function seedUserKey(userId: string, day: string, value: number): Promise<void> {
  await run(
    "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    `mutations:user:${userId}:${day}`,
    value,
    T0,
  );
}

async function seedGlobalKey(day: string, value: number): Promise<void> {
  await run(
    "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    `mutations:global:${day}`,
    value,
    T0,
  );
}
