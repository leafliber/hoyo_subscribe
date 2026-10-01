// 仅 admin 测试使用：本地 D1 与合成秘密，不连接外部环境。
import { env } from "cloudflare:test";
import { beforeAll, expect } from "vitest";
import { splitSqlStatements } from "../storage/split-sql";

const migrations = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
async function query<T>(sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results;
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
