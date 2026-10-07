// ADR-0030 · 迁移 0030 在有已发布数据的库上重建 events：行、版本号与外键引用原样保留。
// 生产用 `wrangler d1 migrations apply` 一个文件一个事务地执行；这里同样按文件以 batch 执行（单文件原子），
// 先放 0001–0029、写入一组带子表引用的已发布事件，再执行 0030。全部为合成数据。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { splitSqlStatements } from "./split-sql";

const migrationFiles = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T0 = 1_800_000_000_000;
const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

async function resetToEmptyDatabase(): Promise<void> {
  const objects = (
    await env.DB.prepare(
      `SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND ${USER_OBJECT_FILTER}`,
    ).all<{ type: string; name: string }>()
  ).results;
  for (const object of objects)
    await env.DB.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}";`);
  for (let round = 0; round < 20; round++) {
    const tables = (
      await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
      ).all<{ name: string }>()
    ).results;
    if (tables.length === 0) return;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        // 外键依赖未解除，下一轮再删
      }
    }
  }
  throw new Error("清库失败");
}

function migrationsUpTo(last: number): string[] {
  return Object.keys(migrationFiles)
    .sort()
    .filter((name) => Number.parseInt(name.split("/").pop()?.slice(0, 4) ?? "", 10) <= last);
}

async function applyFile(name: string): Promise<void> {
  const statements = splitSqlStatements(migrationFiles[name] ?? "");
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

const EVENT_COLUMNS = [
  "id",
  "game",
  "region",
  "event_type",
  "status",
  "title",
  "summary",
  "official_url",
  "detail_path",
  "event_revision",
  "schedule_revision",
  "human_locked",
  "first_published_at",
  "created_at",
  "updated_at",
] as const;

async function seedPublishedFacts(): Promise<void> {
  const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
  await env.DB.batch([
    run(
      `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json, verified_publishers_json,
         cursor_json, poll_policy_json, verification_state, last_success_at, created_at, updated_at)
       VALUES ('src_a', 'genshin', 'cn', 'synthetic', '[]', '[]', '{}', '{}', 'verified-working', ?, ?, ?)`,
      T0,
      T0,
      T0,
    ),
    run(
      `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at, last_checked_at, created_at, updated_at)
       VALUES ('art_a', 'src_a', 'ext_a', 'https://example.invalid/a', ?, ?, ?, ?)`,
      T0,
      T0,
      T0,
      T0,
    ),
    run(
      `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json, media_refs_json,
         completeness, official_published_at, fetched_at, created_at)
       VALUES ('ver_a', 'art_a', 1, 'hash_a', '[]', '[]', 'complete', NULL, ?, ?)`,
      T0,
      T0,
    ),
    run(
      `INSERT INTO events (${EVENT_COLUMNS.join(", ")}) VALUES
         ('evt_a', 'genshin', 'CN', 'gacha', 'scheduled', '合成卡池', NULL, 'https://example.invalid/a', NULL, 3, 2, 1, ?, ?, ?),
         ('evt_b', 'genshin', 'CN', 'limited_event', 'cancelled', '合成活动', '合成说明', NULL, NULL, 5, 4, 0, ?, ?, ?)`,
      T0 - 2,
      T0 - 3,
      T0 - 1,
      T0 - 5,
      T0 - 6,
      T0 - 4,
    ),
    run(
      `INSERT INTO milestones (id, event_id, milestone_key, node_type, title, time_exact_ms, time_date,
         source_timezone, raw_expression, time_basis, time_precision, public_ical_revision, human_locked,
         created_at, updated_at)
       VALUES ('ms_a1', 'evt_a', 'start', 'start', '合成卡池', ?, NULL, 'UTC+08:00', '2027/01/15 10:00', 'official_explicit', 'datetime', 2, 1, ?, ?),
              ('ms_a2', 'evt_a', 'end', 'end', '合成卡池', NULL, '2027-02-01', 'UTC+08:00', '2月1日', 'deterministic_derived', 'date', 1, 0, ?, ?),
              ('ms_b1', 'evt_b', 'end', 'end', '合成活动', NULL, NULL, 'UTC+08:00', '版本结束', 'unresolved', 'unknown', 4, 0, ?, ?)`,
      T0,
      T0,
      T0,
      T0,
      T0,
      T0,
      T0,
    ),
    run(
      `INSERT INTO candidates (id, run_id, event_id, proposal_json, review_status, reviewer, decided_at,
         decision_reason, created_at, updated_at)
       VALUES ('cand_a', NULL, 'evt_a', '{}', 'approved', NULL, NULL, NULL, ?, ?)`,
      T0,
      T0,
    ),
    run(
      `INSERT INTO evidence (id, candidate_id, event_id, milestone_id, article_version_id, block_ref, created_at)
       VALUES ('evi_a', 'cand_a', 'evt_a', 'ms_a1', 'ver_a', 'blocks/1', ?)`,
      T0,
    ),
    run(
      `INSERT INTO event_revisions (id, event_id, revision_no, change_kind, actor_path, reason, diff_json, created_at)
       VALUES ('rev_a', 'evt_a', 1, 'created', 'manual', NULL, NULL, ?),
              ('rev_b', 'evt_b', 1, 'created', 'rule', NULL, NULL, ?)`,
      T0,
      T0,
    ),
    run(
      `INSERT INTO calendar_projections (milestone_id, event_id, public_ical_revision, projection_json, updated_at)
       VALUES ('ms_a1', 'evt_a', 2, '{}', ?)`,
      T0,
    ),
  ]);
}

describe("A-P1-DB ADR-0030 迁移 0030 在有数据的库上重建 events", () => {
  beforeEach(async () => {
    await resetToEmptyDatabase();
    for (const name of migrationsUpTo(29)) await applyFile(name);
    await seedPublishedFacts();
  }, 180_000);

  it("整份迁移一个事务成功：行、版本号、人工锁、时间戳原样保留，外键检查为空", async () => {
    const before = (
      await env.DB.prepare(`SELECT ${EVENT_COLUMNS.join(", ")} FROM events ORDER BY id`).all()
    ).results;
    const [name] = migrationsUpTo(30).slice(-1);
    expect(name).toMatch(/0030_redeem_codes\.sql$/);
    await applyFile(name);

    const after = (
      await env.DB.prepare(`SELECT ${EVENT_COLUMNS.join(", ")} FROM events ORDER BY id`).all()
    ).results;
    expect(after).toEqual(before);
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
      "子表引用全部仍指向存在的事件",
    ).toEqual([]);
    for (const [table, count] of [
      ["milestones", 3],
      ["candidates", 1],
      ["evidence", 1],
      ["event_revisions", 2],
      ["calendar_projections", 1],
    ] as const) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row?.n, table).toBe(count);
    }
    // 暂存表已删除；索引按原名重建。
    const objects = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name IN ('events', 'events_rebuild_0030') ORDER BY name",
      ).all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(objects).toEqual([
      "events",
      "idx_events_catalog",
      "idx_events_updated",
      "sqlite_autoindex_events_1",
    ]);
  });

  it("新 CHECK 接受兑换码事件、仍拒绝未知类型；子表照常引用新表", async () => {
    await applyFile(migrationsUpTo(30).slice(-1)[0]);
    const insert = (id: string, type: string) =>
      env.DB.prepare(
        `INSERT INTO events (id, game, region, event_type, status, title, created_at, updated_at)
         VALUES (?, 'zzz', 'CN', ?, 'scheduled', '合成兑换码', ?, ?)`,
      )
        .bind(id, type, T0, T0)
        .run();
    await insert("evt_code", "redeem_code");
    await expect(insert("evt_bad", "giveaway")).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        `INSERT INTO milestones (id, event_id, milestone_key, node_type, title, time_exact_ms, time_date,
           source_timezone, raw_expression, time_basis, time_precision, public_ical_revision, human_locked, created_at, updated_at)
         VALUES ('ms_orphan', 'evt_missing', 'start', 'start', 'x', NULL, NULL, 'UTC+08:00', 'x', 'unresolved', 'unknown', 0, 0, ?, ?)`,
      )
        .bind(T0, T0)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("对照：先建新表复制、再删旧表改名的顺序在有子表引用时提交失败（所以 0030 要以原表名插回）", async () => {
    const naive = [
      "PRAGMA defer_foreign_keys = true",
      "CREATE TABLE events_naive AS SELECT * FROM events",
      "DROP TABLE events",
      "ALTER TABLE events_naive RENAME TO events",
    ];
    await expect(env.DB.batch(naive.map((statement) => env.DB.prepare(statement)))).rejects.toThrow(
      /FOREIGN KEY/,
    );
    // 整批回滚：旧表与数据都还在。
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});
