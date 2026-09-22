// A-P2-PREAUTH · 注册准入：全局开关、/status 公布与路由清单（任务卡 P2-01 交付物三）。
//
// 覆盖：
// - /status 公布全局 registration_open（读侧失败关闭：行缺失/损坏一律 false）；
// - ★ 不提供任何按邮箱查询是否注册的接口（对真实挂载清单的探测断言）；
// - 挂载在真实 Worker 入口上验证（index.ts 挂载点）。
// 迁移重放纪律与 A-P1-CAS 相同：空库顺序重放，本文件自足。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../index";
import { splitSqlStatements } from "../../storage/split-sql";
import {
  REGISTRATION_OPEN_STATE_KEY,
  readRegistrationOpen,
  registrationsDayKey,
  writeRegistrationOpen,
} from "./registration";

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
// glob 深度防呆：路径写错时集合为空、重放静默跳过（曾因此误判「表不存在」）。
expect(Object.keys(migrationFiles).length).toBeGreaterThan(0);

const T0 = 1_800_000_000_000;
const SECOND = 1_000;

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return (await stmt.all<T>()).results ?? [];
}

const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

async function resetToEmptyDatabase(): Promise<void> {
  const objects = await query<{ type: string; name: string }>(
    `SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND ${USER_OBJECT_FILTER}`,
  );
  for (const obj of objects) {
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  }
  let remaining = (
    await query<{ name: string }>(
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
      await query<{ name: string }>(
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
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
}, 180_000);

describe("A-P2-PREAUTH 全局注册开关（§4.2 /status 公布 registration_open）", () => {
  it("行缺失时失败关闭：读侧与 /status 都公布 false", async () => {
    expect(await readRegistrationOpen(env.DB)).toBe(false);
    const res = await worker.fetch(new Request("https://app.test/api/v2/status"), env, {
      waitUntil() {},
    } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registration_open: false });
  });

  it("写入 true 后读侧与 /status 公布 true；写回 false 再关闭", async () => {
    await writeRegistrationOpen(env.DB, true, T0);
    expect(await readRegistrationOpen(env.DB)).toBe(true);
    const res = await worker.fetch(new Request("https://app.test/api/v2/status"), env, {
      waitUntil() {},
    } as unknown as ExecutionContext);
    expect(await res.json()).toEqual({ registration_open: true });
    await writeRegistrationOpen(env.DB, false, T0);
    expect(await readRegistrationOpen(env.DB)).toBe(false);
  });

  it("值语义损坏（非布尔 JSON）失败关闭为 false，不抛错", async () => {
    // 非法 JSON 被 system_state 的 json_valid CHECK 在数据库层拒绝（schema 已挡）；
    // 这里测的是「合法 JSON 但不是布尔 true」时的读侧失败关闭。
    await env.DB.prepare(
      "INSERT OR REPLACE INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)",
    )
      .bind(REGISTRATION_OPEN_STATE_KEY, JSON.stringify("maybe"), T0)
      .run();
    expect(await readRegistrationOpen(env.DB)).toBe(false);
  });

  it("每日完成注册计数的容量行键含 UTC 日（新的一天即新键，日重置天然成立）", () => {
    const a = registrationsDayKey(T0);
    const b = registrationsDayKey(T0 + 24 * 60 * 60 * SECOND);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^registrations:\d{4}-\d{2}-\d{2}$/);
  });
});

describe("A-P2-PREAUTH 路由清单（★ 不提供按邮箱查询是否注册的接口）", () => {
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;

  it("常见「按邮箱探测」形状的路径全部 404：不存在任何邮箱存在性端点", async () => {
    const probePaths = [
      "/api/v2/auth/email-status",
      "/api/v2/auth/lookup",
      "/api/v2/auth/exists",
      "/api/v2/auth/preauth/check",
      "/api/v2/users/lookup",
      "/api/v2/me/exists",
    ];
    for (const path of probePaths) {
      for (const method of ["GET", "POST"] as const) {
        const res = await worker.fetch(
          new Request(`https://app.test${path}`, {
            method,
            headers: { "content-type": "application/json", origin: "https://app.test" },
            body: method === "POST" ? JSON.stringify({ email: "probe@synthetic.test" }) : undefined,
          }),
          env,
          ctx,
        );
        expect(res.status, `${method} ${path} 不得存在`).toBe(404);
      }
    }
  });

  it("真实挂载面：/api/v2/auth/preauth 存在（秘密未注入时失败关闭为 503，而非 404）", async () => {
    const res = await worker.fetch(
      new Request("https://app.test/api/v2/auth/preauth", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.test" },
        body: "{}",
      }),
      env,
      ctx,
    );
    // 路由存在但 CRYPTO_* 未注入（测试环境无秘密）→ 失败关闭，不误报 404。
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
