// A-P1-DB · D1 schema、索引与迁移框架（任务卡 P1-04）。
// 验收定义（docs/ACCEPTANCE.md）：空库重放全部迁移得到预期 schema 与索引；
// 索引覆盖 §8.1 列出的全部访问路径；测量真实 rows_read。
// 测试在真实 workerd + miniflare D1 上执行（@cloudflare/vitest-pool-workers），
// 与部署引擎一致；本地 D1 与生产 D1 的差异以 P0-01 证据（d1-conditional-tx）为准。
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPECTED_DDL_INVARIANTS,
  EXPECTED_ENUM_CHECKS,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  EXPECTED_TRIGGERS,
  EXPECTED_UNIQUE_CONSTRAINTS,
  FORBIDDEN_NAME_FRAGMENTS,
  MANDATORY_COLUMNS,
  SEPARATE_VERSION_COLUMNS,
} from "./expected-schema";
import { splitSqlStatements } from "./split-sql";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}

// 迁移以 ?raw 原文导入，按文件名排序即编号顺序；后续任务卡新增迁移自动纳入重放。
const migrationFiles = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

// 合成基准时刻（2027-01-15 前后，纯合成数据，无真实邮箱/主机/密钥）。
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface IndexInfoRow {
  seqno: number;
  name: string | null;
}

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

async function run(sql: string, ...params: unknown[]): Promise<void> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  await stmt.run();
}

// 业务对象边界：排除 sqlite_* 内部对象与 D1 自维护的 _cf* 内部表（如 _cf_METADATA，不可删）。
const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

/** 依赖容忍的清库：多轮尝试 DROP，直到清空；保证"空库顺序重放"不受历史残留影响。 */
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
  expect(remaining, "清库失败：以下表无法删除，空库重放前提不成立").toEqual([]);
}

/** 顺序重放全部迁移，并校验编号从 1 起连续（只进不退的机器检查）。
 * 每个文件经注释感知切分后以 batch 执行：单文件原子，SQL 错误整体回滚（P0-01 实测）。 */
async function replayAllMigrations(): Promise<string[]> {
  const names = Object.keys(migrationFiles).sort();
  const numbers = names.map((name) =>
    Number.parseInt(name.split("/").pop()?.split("_")[0] ?? "NaN", 10),
  );
  expect(numbers.every(Number.isFinite), "存在不符合 NNNN_ 命名的迁移").toBe(true);
  expect(numbers, "迁移编号必须从 1 起连续").toEqual(numbers.map((_, i) => i + 1));
  for (const name of names) {
    const statements = splitSqlStatements(migrationFiles[name] ?? "");
    expect(statements.length, `迁移 ${name} 切分后为空`).toBeGreaterThan(0);
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
  return names;
}

/** 批量插入（分块提交），rows 为参数数组。 */
async function insertRows(
  table: string,
  columns: readonly string[],
  rows: unknown[][],
): Promise<void> {
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40).map((params) => env.DB.prepare(sql).bind(...params));
    await env.DB.batch(chunk);
  }
}

/** 执行查询并返回 D1 报告的真实 rows_read（缺失即失败，不允许用假值通过）。 */
async function measure(sql: string, ...params: unknown[]): Promise<number> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const result = await stmt.all();
  const rowsRead = result.meta?.rows_read;
  expect(
    typeof rowsRead === "number",
    `D1 未报告 rows_read（SQL: ${sql}）；真实 rows_read 是 A-P1-DB 的验收要求，不允许缺失`,
  ).toBe(true);
  return rowsRead as number;
}

let migrationNames: string[] = [];

beforeAll(async () => {
  await resetToEmptyDatabase();
  migrationNames = await replayAllMigrations();
  await seedFixtures();
}, 180_000);

/** 合成样本数据：量级以"缺索引即读全表"可分辨为准，全部为 synthetic。 */
async function seedFixtures(): Promise<void> {
  // 数据组 1：来源与正文
  await insertRows(
    "sources",
    [
      "source_id",
      "game",
      "region",
      "adapter",
      "approved_hosts_json",
      "verified_publishers_json",
      "cursor_json",
      "poll_policy_json",
      "verification_state",
      "last_success_at",
      "created_at",
      "updated_at",
    ],
    [1, 2, 3].map((i) => [
      `src_${i}`,
      ["genshin", "hsr", "zzz"][i - 1],
      "CN",
      "ann-api",
      JSON.stringify([`host-${i}.example.invalid`]),
      JSON.stringify([`publisher-${i}`]),
      JSON.stringify({ cursor: 0 }),
      JSON.stringify({ interval: 300 }),
      "verified-working",
      T0 - i * 60_000,
      T0 - 30 * DAY,
      T0 - i * 60_000,
    ]),
  );
  await insertRows(
    "articles",
    [
      "id",
      "source_id",
      "external_id",
      "official_url",
      "first_seen_at",
      "last_checked_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 60 }, (_, i) => [
      `a_${String(i + 1).padStart(3, "0")}`,
      `src_${(i % 3) + 1}`,
      `ext_${i + 1}`,
      `https://example.invalid/ann/${i + 1}`,
      T0 - 20 * DAY + i * 60_000,
      T0 - i * 3_600_000,
      T0 - 20 * DAY + i * 60_000,
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "article_versions",
    [
      "id",
      "article_id",
      "version_no",
      "content_hash",
      "body_blocks_json",
      "media_refs_json",
      "completeness",
      "official_published_at",
      "fetched_at",
      "created_at",
    ],
    Array.from({ length: 120 }, (_, i) => [
      `av_${String(i + 1).padStart(3, "0")}`,
      `a_${String((i % 60) + 1).padStart(3, "0")}`,
      Math.floor(i / 60) + 1,
      `hash_${i + 1}`,
      JSON.stringify([{ kind: "text", body: `synthetic body ${i}` }]),
      JSON.stringify([]),
      "complete",
      T0 - 21 * DAY + i * 60_000,
      T0 - 10 * DAY + i * 60_000,
      T0 - 10 * DAY + i * 60_000,
    ]),
  );

  // 数据组 2：理解与事实
  await insertRows(
    "events",
    [
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
    ],
    Array.from({ length: 30 }, (_, i) => [
      `e_${String(i + 1).padStart(3, "0")}`,
      ["genshin", "hsr", "zzz"][i % 3],
      "CN",
      ["livestream", "maintenance", "limited_event", "gacha"][i % 4],
      "scheduled",
      `synthetic event ${i + 1}`,
      null,
      `https://example.invalid/ann/${i + 1}`,
      `/events/e_${i + 1}`,
      i,
      i % 3,
      0,
      T0 - 5 * DAY,
      T0 - 6 * DAY,
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "milestones",
    [
      "id",
      "event_id",
      "milestone_key",
      "node_type",
      "title",
      "time_exact_ms",
      "time_date",
      "source_timezone",
      "raw_expression",
      "time_basis",
      "time_precision",
      "public_ical_revision",
      "human_locked",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 90 }, (_, i) => [
      `m_${String(i + 1).padStart(3, "0")}`,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      `key_${Math.floor(i / 30) + 1}`,
      ["start", "end", "phase_unlock", "reward_deadline", "expected_end", "actual_end"][i % 6],
      `node ${i + 1}`,
      T0 + (i - 30) * DAY,
      null,
      "UTC+8",
      `synthetic raw ${i}`,
      "official_explicit",
      "datetime",
      i,
      0,
      T0 - 5 * DAY,
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "extraction_runs",
    [
      "id",
      "article_version_id",
      "extractor",
      "profile_ref",
      "status",
      "usage_json",
      "error",
      "created_at",
      "completed_at",
    ],
    Array.from({ length: 10 }, (_, i) => [
      `run_${i + 1}`,
      `av_${String(i * 10 + 1).padStart(3, "0")}`,
      i % 2 === 0 ? "rule" : "model",
      `profile-v${(i % 2) + 1}`,
      "succeeded",
      JSON.stringify({ in: 100, out: 50 }),
      null,
      T0 - 4 * DAY,
      T0 - 4 * DAY + 5_000,
    ]),
  );
  await insertRows(
    "candidates",
    [
      "id",
      "run_id",
      "event_id",
      "proposal_json",
      "review_status",
      "reviewer",
      "decided_at",
      "decision_reason",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 20 }, (_, i) => [
      `c_${String(i + 1).padStart(3, "0")}`,
      i < 10 ? `run_${i + 1}` : null,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      JSON.stringify({ synthetic: true }),
      ["pending", "approved", "rejected"][i % 3],
      i % 3 === 0 ? null : "admin-synthetic",
      i % 3 === 0 ? null : T0 - i * 3_600_000,
      i % 3 === 2 ? "synthetic reject" : null,
      T0 - 4 * DAY + i * 60_000,
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "evidence",
    [
      "id",
      "candidate_id",
      "event_id",
      "milestone_id",
      "article_version_id",
      "block_ref",
      "created_at",
    ],
    Array.from({ length: 20 }, (_, i) => [
      `ev_${String(i + 1).padStart(3, "0")}`,
      `c_${String((i % 20) + 1).padStart(3, "0")}`,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      `m_${String((i % 90) + 1).padStart(3, "0")}`,
      `av_${String((i % 120) + 1).padStart(3, "0")}`,
      `block-${i}`,
      T0 - 4 * DAY,
    ]),
  );
  await insertRows(
    "event_revisions",
    [
      "id",
      "event_id",
      "revision_no",
      "change_kind",
      "actor_path",
      "reason",
      "diff_json",
      "created_at",
    ],
    Array.from({ length: 30 }, (_, i) => [
      `er_${i + 1}`,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      i + 1,
      "synthetic-change",
      ["rule", "model", "manual"][i % 3],
      null,
      JSON.stringify({ synthetic: true }),
      T0 - i * 3_600_000,
    ]),
  );

  // 数据组 3：公共日历
  await insertRows(
    "calendar_projections",
    ["milestone_id", "event_id", "public_ical_revision", "projection_json", "updated_at"],
    Array.from({ length: 90 }, (_, i) => [
      `m_${String(i + 1).padStart(3, "0")}`,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      i,
      JSON.stringify({ synthetic: true }),
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "calendar_patches",
    [
      "id",
      "milestone_id",
      "patch_kind",
      "old_time_exact_ms",
      "old_time_date",
      "new_time_exact_ms",
      "new_time_date",
      "fact_reason",
      "effective_at",
      "retain_until",
      "superseded_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 10 }, (_, i) => [
      `cp_${i + 1}`,
      `m_${String(i * 9 + 1).padStart(3, "0")}`,
      "reschedule",
      T0 + i * DAY,
      null,
      T0 + (i + 40) * DAY,
      null,
      "synthetic reschedule",
      T0 - i * DAY,
      T0 + (60 + i) * DAY,
      null,
      T0 - i * DAY,
      T0 - i * DAY,
    ]),
  );
  await insertRows(
    "public_snapshots",
    ["id", "generation", "state", "built_at", "published_at", "created_at"],
    [
      ["snap_1", 1, "superseded", T0 - 3 * DAY, T0 - 3 * DAY, T0 - 3 * DAY],
      ["snap_2", 2, "current", T0 - 1 * DAY, T0 - 1 * DAY, T0 - 1 * DAY],
      ["snap_3", 3, "building", null, null, T0],
    ],
  );
  await insertRows(
    "public_snapshot_nodes",
    ["snapshot_id", "milestone_id", "node_json"],
    Array.from({ length: 90 }, (_, i) => [
      "snap_2",
      `m_${String(i + 1).padStart(3, "0")}`,
      JSON.stringify({ synthetic: i }),
    ]),
  );

  // 数据组 4：用户
  await insertRows(
    "users",
    [
      "id",
      "order",
      "status",
      "email_key",
      "email_binding_id",
      "email_ciphertext",
      "email_version",
      "auth_epoch",
      "recovery_epoch",
      "last_interactive_at",
      "last_feed_poll_at",
      "last_push_processed_at",
      "reclaim_grace_until",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 200 }, (_, i) => [
      `u_${String(i + 1).padStart(3, "0")}`,
      i + 1,
      i < 180 ? "active" : "inactive-synthetic",
      `ek_${String(i + 1).padStart(3, "0")}`,
      `eb_${String(i + 1).padStart(3, "0")}`,
      new Uint8Array([i % 256, 1, 2, 3]),
      1,
      0,
      0,
      T0 - i * DAY,
      T0 - i * 3_600_000,
      null,
      null,
      T0 - 60 * DAY + i * 60_000,
      T0 - i * 3_600_000,
    ]),
  );

  // 数据组 5：认证挑战
  await insertRows(
    "auth_challenges",
    [
      "id",
      "purpose",
      "email_key",
      "address_version",
      "preauth_id",
      "idempotency_key",
      "mac",
      "generation",
      "attempts",
      "deadline",
      "reservation_id",
      "consumed_at",
      "aborted_at",
      "receipt_ciphertext",
      "receipt_expires_at",
      "pending_session_id",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 40 }, (_, i) => [
      `ch_${String(i + 1).padStart(3, "0")}`,
      ["login", "register"][i % 2],
      `ek_${String((i % 200) + 1).padStart(3, "0")}`,
      1,
      `pa_${(i % 10) + 1}`,
      i < 20 ? `im_${i + 1}` : null,
      `mac_${i + 1}`,
      i % 3,
      i % 4,
      T0 + 10 * 60_000,
      null,
      i < 10 ? T0 - i * 60_000 : null,
      null,
      null,
      null,
      null,
      T0 - i * 60_000,
      T0 - i * 60_000,
    ]),
  );

  // 数据组 6：会话与恢复（每用户 1 pending + 2 active）
  const sessionRows: unknown[][] = [];
  for (let u = 1; u <= 100; u++) {
    const uid = `u_${String(u).padStart(3, "0")}`;
    sessionRows.push([
      `s_${u}_0`,
      uid,
      `th_${u}_0`,
      "pending",
      `pending device ${u}`,
      "unknown",
      T0,
      T0 + 180 * DAY,
      T0 - u * 60_000,
      T0,
      0,
      0,
      null,
      null,
      null,
      T0,
      T0,
    ]);
    sessionRows.push([
      `s_${u}_1`,
      uid,
      `th_${u}_1`,
      "active",
      `device ${u}-a`,
      "desktop",
      T0,
      T0 + 180 * DAY,
      T0 + 90 * DAY,
      T0,
      0,
      0,
      T0,
      null,
      null,
      T0,
      T0,
    ]);
    sessionRows.push([
      `s_${u}_2`,
      uid,
      `th_${u}_2`,
      "active",
      `device ${u}-b`,
      "mobile",
      T0,
      T0 + 179 * DAY,
      T0 + 89 * DAY,
      T0,
      0,
      0,
      T0,
      null,
      null,
      T0,
      T0,
    ]);
  }
  await insertRows(
    "sessions",
    [
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
      "activated_at",
      "revoked_at",
      "revoke_reason",
      "created_at",
      "updated_at",
    ],
    sessionRows,
  );
  await insertRows(
    "recovery_credentials",
    [
      "id",
      "user_id",
      "secret_hash",
      "generation",
      "consumed_at",
      "saved_confirmed_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 50 }, (_, i) => [
      `rc_${String(i + 1).padStart(3, "0")}`,
      `u_${String(i + 1).padStart(3, "0")}`,
      `rc_hash_${i + 1}`,
      1,
      null,
      i % 2 === 0 ? T0 - i * DAY : null,
      T0 - 50 * DAY,
      T0,
    ]),
  );

  // 数据组 7：云配置
  await insertRows(
    "user_subscriptions",
    [
      "user_id",
      "state",
      "schema_version",
      "revision",
      "scope_json",
      "calendar_json",
      "notifications_json",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 200 }, (_, i) => [
      `u_${String(i + 1).padStart(3, "0")}`,
      "initialized",
      3,
      i + 1,
      JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
      JSON.stringify({ event_types: ["livestream"], node_types: ["start"], alarms_enabled: true }),
      JSON.stringify({
        rule_ids: [],
        new_event: false,
        important_change: true,
        cancelled_or_retracted: true,
        late_discovery: true,
      }),
      T0 - 60 * DAY,
      T0 - i * 60_000,
    ]),
  );
  await insertRows(
    "subscription_interests",
    ["id", "user_id", "game", "region", "interest_kind", "interest_id", "enabled_at"],
    Array.from({ length: 200 }, (_, i) => [
      `si_${i + 1}`,
      `u_${String((i % 200) + 1).padStart(3, "0")}`,
      "genshin",
      "CN",
      i % 2 === 0 ? "rule" : "change_switch",
      i % 2 === 0 ? `rule_${(i % 10) + 1}` : "cancelled_or_retracted",
      T0 - i * 3_600_000,
    ]),
  );

  // 数据组 8：邮件
  await insertRows(
    "email_channels",
    [
      "user_id",
      "enabled",
      "routine_enabled",
      "consent_version",
      "address_version",
      "lease_expires_at",
      "last_renewed_at",
      "last_renewed_reason",
      "channel_revision",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 80 }, (_, i) => [
      `u_${String(i + 1).padStart(3, "0")}`,
      i % 2,
      i % 2 === 1 && i % 4 === 1 ? 1 : 0,
      i % 2,
      1,
      T0 + 30 * DAY,
      T0 - i * DAY,
      i % 2 ? "activity-auto-renew" : "user-consent",
      i,
      T0 - 40 * DAY,
      T0 - i * DAY,
    ]),
  );
  await insertRows(
    "consent_events",
    [
      "id",
      "user_id",
      "email_binding_id",
      "layer",
      "action",
      "consent_version",
      "context_json",
      "created_at",
    ],
    Array.from({ length: 40 }, (_, i) => [
      `ce_${i + 1}`,
      `u_${String((i % 80) + 1).padStart(3, "0")}`,
      `eb_${String((i % 80) + 1).padStart(3, "0")}`,
      i % 2 === 0 ? "seat" : "routine",
      "consent_given",
      i % 2,
      null,
      T0 - i * DAY,
    ]),
  );
  await insertRows(
    "suppressions",
    [
      "id",
      "address_key",
      "email_binding_id",
      "kind",
      "read_only",
      "reason",
      "created_at",
      "expires_at",
    ],
    Array.from({ length: 5 }, (_, i) => [
      `sup_${i + 1}`,
      `ak_${i + 1}`,
      `eb_${String(i + 1).padStart(3, "0")}`,
      i % 2 === 0 ? "complaint" : "hard_bounce",
      i % 2,
      "synthetic",
      T0 - i * DAY,
      i % 2 === 0 ? null : T0 + 30 * DAY,
    ]),
  );

  // 数据组 9：Feed
  await insertRows(
    "calendar_feeds",
    [
      "user_id",
      "namespace",
      "state",
      "token_hash",
      "token_ciphertext",
      "token_generation",
      "view_revision",
      "changed_at",
      "last_feed_poll_at",
      "last_served_node_count",
      "last_served_view_revision",
      "last_served_generation",
      "token_rotated_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 60 }, (_, i) => [
      `u_${String(i + 1).padStart(3, "0")}`,
      `ns-synthetic-${(i + 1).toString(16).padStart(4, "0")}`,
      "enabled",
      `fth_${String(i + 1).padStart(3, "0")}`,
      new Uint8Array([i % 256, 9, 8, 7]),
      i % 3,
      i,
      T0 - i * 60_000,
      T0 - i * 3_600_000,
      40 + (i % 5),
      i,
      2,
      T0 - i * DAY,
      T0 - 60 * DAY,
      T0 - i * 3_600_000,
    ]),
  );

  // 数据组 10：Push
  await insertRows(
    "push_bindings",
    [
      "id",
      "user_id",
      "endpoint_hash",
      "endpoint_ciphertext",
      "keys_ciphertext",
      "state",
      "binding_version",
      "receipt_token_hash",
      "lease_expires_at",
      "activated_at",
      "last_processed_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 60 }, (_, i) => [
      `pb_${String(i + 1).padStart(3, "0")}`,
      `u_${String((i % 200) + 1).padStart(3, "0")}`,
      `eph_${String(i + 1).padStart(3, "0")}`,
      new Uint8Array([i % 256, 4, 5, 6]),
      new Uint8Array([i % 256, 7, 8, 9]),
      i % 2 === 0 ? "active" : "pending",
      i,
      i % 2 === 0 ? `rth_${String(i + 1).padStart(3, "0")}` : null,
      T0 + 30 * DAY,
      i % 2 === 0 ? T0 - i * DAY : null,
      i % 2 === 0 ? T0 - i * 3_600_000 : null,
      T0 - 30 * DAY,
      T0 - i * 3_600_000,
    ]),
  );

  // 数据组 11：后台
  await insertRows(
    "jobs",
    [
      "id",
      "kind",
      "payload_json",
      "due_at",
      "status",
      "lease_version",
      "lease_owner",
      "lease_expires_at",
      "attempts",
      "last_error",
      "created_at",
      "updated_at",
      "completed_at",
    ],
    Array.from({ length: 50 }, (_, i) => [
      `job_${String(i + 1).padStart(3, "0")}`,
      "dispatch",
      JSON.stringify({ synthetic: true }),
      i < 30 ? T0 - i * 600_000 : T0 + i * 3_600_000,
      i < 30 ? "pending" : "done",
      0,
      null,
      null,
      0,
      null,
      T0 - i * 600_000,
      T0 - i * 600_000,
      i < 30 ? null : T0,
    ]),
  );
  await insertRows(
    "outbox",
    ["id", "topic", "dedupe_key", "payload_json", "dispatch_state", "created_at", "dispatched_at"],
    Array.from({ length: 20 }, (_, i) => [
      `ob_${String(i + 1).padStart(3, "0")}`,
      "snapshot_rebuild",
      `dk_${i + 1}`,
      JSON.stringify({ generation: 2 }),
      i < 15 ? "dispatched" : "pending",
      T0 - i * 3_600_000,
      i < 15 ? T0 - i * 3_600_000 + 5_000 : null,
    ]),
  );
  await insertRows(
    "occurrences",
    [
      "id",
      "event_id",
      "milestone_id",
      "schedule_revision",
      "kind",
      "due_at",
      "expires_at",
      "audience_upper_order",
      "backfill",
      "invalidated_at",
      "created_at",
    ],
    Array.from({ length: 30 }, (_, i) => [
      `oc_${String(i + 1).padStart(3, "0")}`,
      `e_${String((i % 30) + 1).padStart(3, "0")}`,
      `m_${String((i % 90) + 1).padStart(3, "0")}`,
      1,
      i % 2 === 0 ? `rule_${(i % 5) + 1}` : "late_discovery",
      T0 - 10 * DAY + i * 3_600_000,
      T0 + 7 * DAY,
      200,
      0,
      i < 5 ? T0 - i * 60_000 : null,
      T0 - 10 * DAY,
    ]),
  );

  // 数据组 12：实际发送
  await insertRows(
    "mail_outbox",
    [
      "id",
      "purpose",
      "priority",
      "period_key",
      "recipient_user_id",
      "email_binding_id",
      "address_version",
      "payload_kind",
      "payload_ref",
      "payload_ciphertext",
      "status",
      "message_id",
      "lease_version",
      "lease_owner",
      "lease_expires_at",
      "attempts",
      "idempotency_key",
      "sent_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 40 }, (_, i) => [
      `obx_${String(i + 1).padStart(3, "0")}`,
      ["existing_auth", "new_registration", "base_business", "urgent_business"][i % 4],
      i % 6,
      "2027-01",
      `u_${String((i % 200) + 1).padStart(3, "0")}`,
      `eb_${String((i % 200) + 1).padStart(3, "0")}`,
      1,
      i % 4 === 0 ? "otp-ciphertext" : "template",
      i % 4 === 0 ? null : `tpl_${i % 4}`,
      i % 4 === 0 ? new Uint8Array([i % 256, 1, 1]) : null,
      i < 30 ? "pending" : i < 35 ? "unknown" : "accepted",
      i >= 35 ? `mid_${i + 1}` : null,
      0,
      null,
      null,
      0,
      `ik_${i + 1}`,
      i >= 35 ? T0 - i * 60_000 : null,
      T0 - i * 3_600_000,
      T0,
    ]),
  );
  await insertRows(
    "deliveries",
    [
      "id",
      "occurrence_id",
      "user_id",
      "channel",
      "target_ref",
      "milestone_id",
      "schedule_revision",
      "rule_id",
      "kind",
      "priority",
      "dedupe_family",
      "mail_outbox_ref",
      "status",
      "skip_reason",
      "expires_at",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 600 }, (_, i) => [
      `d_${String(i + 1).padStart(4, "0")}`,
      `oc_${String((i % 30) + 1).padStart(3, "0")}`,
      `u_${String((i % 100) + 1).padStart(3, "0")}`,
      "email",
      `u_${String((i % 100) + 1).padStart(3, "0")}`,
      `m_${String((i % 90) + 1).padStart(3, "0")}`,
      1,
      `rule_${(i % 5) + 1}`,
      "rule",
      (i % 5) + 1,
      `m_${String((i % 90) + 1).padStart(3, "0")}|1|rule_${(i % 5) + 1}|email|u_${String((i % 100) + 1).padStart(3, "0")}`,
      `obx_${String((i % 40) + 1).padStart(3, "0")}`,
      i % 4 === 0 ? "pending" : ["accepted", "skipped", "expired"][i % 3],
      i % 4 === 1 ? null : "synthetic",
      T0 + 7 * DAY - i * 1_000,
      T0 - i * 60_000,
      T0,
    ]),
  );

  // 数据组 13：反馈与用量
  await insertRows(
    "mail_feedback",
    [
      "id",
      "provider_event_id",
      "message_id",
      "mail_outbox_id",
      "kind",
      "feedback_at",
      "raw_ref",
      "created_at",
    ],
    Array.from({ length: 20 }, (_, i) => [
      `fb_${String(i + 1).padStart(3, "0")}`,
      `pev_${String(i + 1).padStart(3, "0")}`,
      `mid_${36 + (i % 5)}`,
      `obx_${String(36 + (i % 5)).padStart(3, "0")}`,
      ["deferred", "bounced", "complained", "delivered"][i % 4],
      T0 - i * 3_600_000,
      null,
      T0 - i * 3_600_000,
    ]),
  );
  await insertRows(
    "usage_periods",
    [
      "id",
      "pool",
      "period_kind",
      "period_key",
      "user_id",
      "reserved",
      "settled",
      "uncertain",
      "envelope",
      "carry",
      "fragment_key",
      "fragment_approved",
      "period_start",
      "period_end",
      "created_at",
      "updated_at",
    ],
    [
      ...["existing_auth", "new_registration", "base_business", "urgent_business"].flatMap(
        (pool, i) => [
          [
            `up_m_${i + 1}`,
            pool,
            "utc_month",
            "2027-01",
            null,
            i,
            i * 10,
            i,
            pool === "base_business" ? 20 : null,
            pool === "base_business" ? 0.5 : 0,
            pool === "base_business" ? "2027-01-15" : null,
            i,
            T0,
            T0 + 31 * DAY,
            T0,
            T0,
          ],
          [
            `up_d_${i + 1}`,
            pool,
            "utc_day",
            "2027-01-15",
            null,
            0,
            i,
            0,
            null,
            0,
            null,
            0,
            T0,
            T0 + DAY,
            T0,
            T0,
          ],
        ],
      ),
      [
        "up_u_1",
        "base_business",
        "utc_day",
        "2027-01-15",
        "u_001",
        0,
        1,
        0,
        null,
        0,
        null,
        0,
        T0,
        T0 + DAY,
        T0,
        T0,
      ],
      [
        "up_u_2",
        "urgent_business",
        "utc_day",
        "2027-01-15",
        "u_001",
        0,
        0,
        0,
        null,
        0,
        null,
        0,
        T0,
        T0 + DAY,
        T0,
        T0,
      ],
    ],
  );
  await insertRows(
    "dispatch_cursors",
    ["pool", "priority", "last_order", "completed_lap", "updated_at"],
    [
      ["urgent_business", 1, 120, 0, T0],
      ["urgent_business", 2, 80, 0, T0],
      ["urgent_business", 3, 40, 1, T0],
      ["base_business", 4, 200, 2, T0],
      ["base_business", 5, 10, 0, T0],
      ["existing_auth", 0, 0, 0, T0],
    ],
  );
  await insertRows(
    "activity_write_failures",
    ["metric", "utc_day", "failures", "last_success_at", "updated_at"],
    [
      ["feed_poll_merge", "2027-01-14", 3, T0 - DAY, T0 - DAY],
      ["feed_poll_merge", "2027-01-15", 0, T0 - 3_600_000, T0],
      ["push_processed_merge", "2027-01-15", 1, T0 - 2 * 3_600_000, T0],
    ],
  );

  // 数据组 14：容量与管理
  await insertRows(
    "admission_reservations",
    [
      "id",
      "kind",
      "email_key",
      "state",
      "reserved_at",
      "expires_at",
      "converted_user_id",
      "created_at",
      "updated_at",
    ],
    Array.from({ length: 20 }, (_, i) => [
      `ar_${String(i + 1).padStart(3, "0")}`,
      "registration",
      i < 5 ? `arek_${i + 1}` : `arek_done_${i}`,
      i < 5 ? "reserved" : i < 10 ? "converted" : i < 15 ? "released" : "expired",
      T0 - i * 60_000,
      T0 + 10 * 60_000,
      i >= 5 && i < 10 ? `u_${String(i + 100).padStart(3, "0")}` : null,
      T0 - i * 60_000,
      T0,
    ]),
  );
  await insertRows(
    "capacity_state",
    ["key", "value", "version", "updated_at"],
    [
      ["accounts_total", 200, 200, T0],
      ["registrations:2027-01-15", 3, 3, T0],
    ],
  );
  await insertRows(
    "system_state",
    ["key", "value_json", "updated_at"],
    [
      ["registration_open", JSON.stringify(true), T0],
      ["reclaim_paused", JSON.stringify(false), T0],
    ],
  );
  await insertRows(
    "admin_sessions",
    [
      "id",
      "token_hash",
      "admin_id",
      "issued_at",
      "expires_at",
      "revoked_at",
      "last_used_at",
      "created_at",
    ],
    [
      ["as_1", "ath_1", "admin-synthetic", T0 - DAY, T0 + DAY, null, T0, T0 - DAY],
      [
        "as_2",
        "ath_2",
        "admin-synthetic",
        T0 - 10 * DAY,
        T0 - 9 * DAY,
        T0 - 9 * DAY,
        null,
        T0 - 10 * DAY,
      ],
    ],
  );
  await insertRows(
    "audit_log",
    [
      "id",
      "actor_type",
      "actor_id",
      "action",
      "target_type",
      "target_id",
      "reason",
      "detail_ref",
      "created_at",
      "expires_at",
    ],
    Array.from({ length: 100 }, (_, i) => [
      `al_${String(i + 1).padStart(3, "0")}`,
      i % 2 === 0 ? "admin" : "system",
      i % 2 === 0 ? "admin-synthetic" : "cron",
      i % 2 === 0 ? "candidate_approve" : "lease_repair",
      i % 2 === 0 ? "candidate" : "job",
      i % 2 === 0
        ? `c_${String((i % 20) + 1).padStart(3, "0")}`
        : `job_${String((i % 50) + 1).padStart(3, "0")}`,
      i % 2 === 0 ? "synthetic review" : null,
      null,
      T0 - i * 3_600_000,
      T0 + (30 - (i % 10)) * DAY,
    ]),
  );
}

describe("A-P1-DB D1 schema、索引与迁移框架", () => {
  it("A-P1-DB 空库顺序重放全部迁移后，表/列/索引/触发器与预期一致", async () => {
    expect(migrationNames.length).toBeGreaterThanOrEqual(14);
    const masterRows = await query<MasterRow>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${USER_OBJECT_FILTER}`,
    );
    const actualTables = masterRows
      .filter((r) => r.type === "table")
      .map((r) => r.name)
      .sort();
    expect(actualTables).toEqual(Object.keys(EXPECTED_TABLES).sort());

    for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLES)) {
      const info = await query<TableInfoRow>(`PRAGMA table_info("${table}")`);
      expect(
        info.map((row) => row.name).sort(),
        `表 ${table} 列集不一致（迁移 vs 预期注册表）`,
      ).toEqual([...expectedColumns].sort());
    }

    const actualIndexes = masterRows.filter((r) => r.type === "index" && r.sql !== null);
    expect(actualIndexes.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED_INDEXES).sort());
    for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
      const listed = await query<IndexListRow>(`PRAGMA index_list("${expected.table}")`);
      const entry = listed.find((row) => row.name === name);
      expect(entry, `索引 ${name} 未出现在 ${expected.table} 的 index_list`).toBeDefined();
      if (!entry) continue;
      expect(entry.unique === 1, `索引 ${name} 唯一性不符`).toBe(expected.unique === true);
      if (expected.partial) {
        expect(entry.partial, `索引 ${name} 应为部分索引`).toBe(1);
      }
      if (!expected.partial && !expected.expression) {
        const cols = await query<IndexInfoRow>(`PRAGMA index_info("${name}")`);
        expect(
          cols.map((row) => row.name),
          `索引 ${name} 列序不符`,
        ).toEqual([...expected.columns]);
      }
    }

    // 合同级 UNIQUE 约束（sqlite_autoindex_*，PRAGMA origin='u'）
    for (const [table, expectedSets] of Object.entries(EXPECTED_UNIQUE_CONSTRAINTS)) {
      const listed = await query<IndexListRow>(`PRAGMA index_list("${table}")`);
      const uniqueColumns = await Promise.all(
        listed
          .filter((row) => row.origin === "u")
          .map(async (row) => {
            const cols = await query<IndexInfoRow>(`PRAGMA index_info("${row.name}")`);
            return cols.map((c) => c.name).sort();
          }),
      );
      for (const expectedSet of expectedSets) {
        expect(
          uniqueColumns.some(
            (cols) => JSON.stringify(cols) === JSON.stringify([...expectedSet].sort()),
          ),
          `表 ${table} 缺少 UNIQUE 约束 (${expectedSet.join(", ")})`,
        ).toBe(true);
      }
    }

    const actualTriggers = masterRows
      .filter((r) => r.type === "trigger")
      .map((r) => r.name)
      .sort();
    expect(actualTriggers).toEqual([...EXPECTED_TRIGGERS].sort());
  }, 120_000);

  it("A-P1-DB 禁止对象不存在；三类业务版本量分列存在", async () => {
    const masterRows = await query<MasterRow>("SELECT type, name, sql FROM sqlite_master");
    const allNames = masterRows.map((r) => `${r.type}:${r.name}`).join("\n");
    const allColumnNames = (
      await Promise.all(
        Object.keys(EXPECTED_TABLES).map(async (table) => {
          const info = await query<TableInfoRow>(`PRAGMA table_info("${table}")`);
          return info.map((row) => `${table}.${row.name}`);
        }),
      )
    ).flat();
    for (const fragment of FORBIDDEN_NAME_FRAGMENTS) {
      expect(allNames.includes(fragment), `禁止对象出现：${fragment}`).toBe(false);
      expect(
        allColumnNames.some((name) => name.includes(fragment)),
        `禁止列名出现：${fragment}`,
      ).toBe(false);
    }
    // 三类版本量禁止合并成一个计数器（ENGINEERING.md §5.2）
    for (const [table, columns] of Object.entries(SEPARATE_VERSION_COLUMNS)) {
      const info = await query<TableInfoRow>(`PRAGMA table_info("${table}")`);
      for (const column of columns) {
        expect(
          info.some((row) => row.name === column),
          `${table}.${column} 必须独立存在`,
        ).toBe(true);
      }
    }
    expect(
      allColumnNames.some((name) => /change_no/.test(name)),
      "不得出现任何 *_change_no 列",
    ).toBe(false);
  });

  it("A-P1-DB CHECK 枚举与 packages/contracts 同步；合同不变式子句落位", async () => {
    const tableSql = new Map<string, string>();
    for (const row of await query<MasterRow>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
    )) {
      if (row.name && row.sql) tableSql.set(row.name, row.sql);
    }
    for (const [key, expected] of Object.entries(EXPECTED_ENUM_CHECKS)) {
      const [table, column] = key.split(".");
      const sql = tableSql.get(table ?? "");
      expect(sql, `缺少表 ${table} 的 DDL`).toBeDefined();
      const match = sql?.match(new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "m"));
      expect(
        match,
        `${table}.${column} 缺少 CHECK IN 枚举约束（来源 ${expected.source}）`,
      ).toBeDefined();
      const actual = (match?.[1] ?? "")
        .split(",")
        .map((piece) => piece.trim().replace(/^'|'$/g, ""))
        .sort();
      expect(actual, `${table}.${column} 的 CHECK 值与 ${expected.source} 不一致`).toEqual(
        [...expected.values].sort(),
      );
    }
    for (const invariant of EXPECTED_DDL_INVARIANTS) {
      const sql = tableSql.get(invariant.table);
      expect(
        invariant.pattern.test(sql ?? ""),
        `${invariant.table} 缺少合同不变式（${invariant.note}）`,
      ).toBe(true);
    }
  });

  it("A-P1-DB 任务卡必备字段全部落位", async () => {
    for (const [table, columns] of Object.entries(MANDATORY_COLUMNS)) {
      const expected = EXPECTED_TABLES[table];
      expect(expected, `预期注册表缺少表 ${table}`).toBeDefined();
      for (const column of columns) {
        expect(expected?.includes(column), `${table}.${column} 未登记`).toBe(true);
      }
      const info = await query<TableInfoRow>(`PRAGMA table_info("${table}")`);
      for (const column of columns) {
        expect(
          info.some((row) => row.name === column),
          `${table}.${column} 未在实际 schema 中出现`,
        ).toBe(true);
      }
    }
  });

  it("A-P1-DB §8.1 全部访问路径索引命中：真实 rows_read 基准报告", async () => {
    const report: Array<{ access: string; sql: string; rows_read: number; bound: number }> = [];
    const benchmarks: Array<{ access: string; sql: string; params: unknown[]; bound: number }> = [
      // bound 口径：真实 rows_read 含索引遍历开销（探针实测唯一/索引点查 ≈3），
      // 上限给少量余量，但必须远低于"缺索引时的全表扫描行数"（各表 20–600 行合成样本）。
      {
        access: "邮箱键 users.email_key（唯一）",
        sql: "SELECT id FROM users WHERE email_key = ?",
        params: ["ek_100"],
        bound: 5,
      },
      {
        access: "token hash sessions.token_hash（唯一）",
        sql: "SELECT id FROM sessions WHERE token_hash = ?",
        params: ["th_50_1"],
        bound: 5,
      },
      {
        access: "token hash calendar_feeds.token_hash（唯一）",
        sql: "SELECT user_id FROM calendar_feeds WHERE token_hash = ?",
        params: ["fth_030"],
        bound: 5,
      },
      {
        access: "endpoint hash push_bindings（唯一）",
        sql: "SELECT id FROM push_bindings WHERE endpoint_hash = ?",
        params: ["eph_030"],
        bound: 5,
      },
      {
        access: "反馈 ID mail_feedback.provider_event_id（唯一）",
        sql: "SELECT id FROM mail_feedback WHERE provider_event_id = ?",
        params: ["pev_007"],
        bound: 5,
      },
      {
        access: "去重键 deliveries.dedupe_family（唯一）",
        sql: "SELECT id FROM deliveries WHERE dedupe_family = ?",
        params: ["m_031|1|rule_1|email|u_001"],
        bound: 5,
      },
      {
        access: "所有者 sessions(user_id, state)",
        sql: "SELECT id FROM sessions WHERE user_id = ? AND state = 'active'",
        params: ["u_001"],
        bound: 6,
      },
      {
        access: "所有者 deliveries(user_id)",
        sql: "SELECT id FROM deliveries WHERE user_id = ?",
        params: ["u_001"],
        bound: 12,
      },
      {
        access: "发送状态/优先级 deliveries(status, priority)",
        sql: "SELECT id FROM deliveries WHERE status = 'pending' AND priority = 1",
        params: [],
        bound: 36,
      },
      {
        access: "发送状态/优先级 mail_outbox 领取（LIMIT 10）",
        sql: "SELECT id FROM mail_outbox WHERE status = 'pending' ORDER BY priority, created_at LIMIT 10",
        params: [],
        bound: 20,
      },
      {
        access: "任务到期 jobs(status, due_at)（LIMIT 10）",
        sql: "SELECT id FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 10",
        params: [T0],
        bound: 20,
      },
      {
        access: "任务到期 occurrences（部分索引，LIMIT 10）",
        sql: "SELECT id FROM occurrences WHERE invalidated_at IS NULL AND due_at <= ? LIMIT 10",
        params: [T0],
        bound: 20,
      },
      {
        access: "反馈 ID mail_feedback.message_id 关联",
        sql: "SELECT id FROM mail_feedback WHERE message_id = ?",
        params: ["mid_37"],
        bound: 6,
      },
      {
        access: "清理时间 sessions(state, expires_at)（LIMIT 20）",
        sql: "SELECT id FROM sessions WHERE state = 'pending' AND expires_at < ? LIMIT 20",
        params: [T0],
        bound: 30,
      },
      {
        access: "清理时间 audit_log.expires_at（LIMIT 50）",
        sql: "SELECT id FROM audit_log WHERE expires_at < ? LIMIT 50",
        params: [T0 + 60 * DAY],
        bound: 60,
      },
      {
        access: "分页 order users(status, order) keyset（LIMIT 20）",
        sql: 'SELECT id FROM users WHERE status = \'active\' AND "order" > 100 ORDER BY "order" LIMIT 20',
        params: [],
        bound: 30,
      },
      {
        access: "注册预占 admission_reservations（部分唯一）",
        sql: "SELECT id FROM admission_reservations WHERE email_key = ? AND state = 'reserved'",
        params: ["arek_1"],
        bound: 5,
      },
    ];

    for (const benchmark of benchmarks) {
      const rowsRead = await measure(benchmark.sql, ...benchmark.params);
      report.push({
        access: benchmark.access,
        sql: benchmark.sql,
        rows_read: rowsRead,
        bound: benchmark.bound,
      });
      expect(
        rowsRead,
        `访问路径未命中索引（rows_read 超上限）：${benchmark.access}\nSQL: ${benchmark.sql}`,
      ).toBeLessThanOrEqual(benchmark.bound);
    }

    // 位图/JSON 过滤的诚实示范（§8.1 末段）：不假定 JSON 过滤命中普通索引。
    // 全部 initialized 行都会被读取——这是合同要求"先缩小状态/区域范围再做有限匹配"的原因。
    const jsonScan = await measure(
      "SELECT count(*) AS n FROM user_subscriptions WHERE state = 'initialized' AND json_extract(scope_json, '$.games[0]') = 'genshin'",
    );
    expect(jsonScan).toBeGreaterThanOrEqual(200);

    console.info(
      `\n[A-P1-DB] rows_read 基准报告（真实 miniflare D1 meta.rows_read，合成样本）\n` +
        report
          .map((row) => `  ${row.access}: rows_read=${row.rows_read} (bound ${row.bound})`)
          .join("\n") +
        `\n  JSON 位图过滤示范（不允许假定命中索引）: rows_read=${jsonScan} >= 200\n`,
    );
  }, 120_000);

  it("A-P1-DB 合同不变式在数据库层生效（触发器与 CHECK 拒绝违约写入）", async () => {
    // §8.1：正文版本不可变
    await expect(
      run("UPDATE article_versions SET content_hash = 'tampered' WHERE id = 'av_001'"),
    ).rejects.toThrow(/不可变|immutable|constraint/i);
    // §4.5：绝对期限创建时固定
    await expect(
      run("UPDATE sessions SET absolute_expires_at = ? WHERE id = 's_1_1'", T0 + 200 * DAY),
    ).rejects.toThrow(/不得改写|absolute_expires_at|constraint/i);
    // §5.1：initialized 不可退回 uninitialized
    await expect(
      run("UPDATE user_subscriptions SET state = 'uninitialized' WHERE user_id = 'u_001'"),
    ).rejects.toThrow(/不可退回|uninitialized|constraint/i);
    // §6.1/§6.4：namespace 不随换 token 改变
    await expect(
      run("UPDATE calendar_feeds SET namespace = 'ns-tampered' WHERE user_id = 'u_001'"),
    ).rejects.toThrow(/namespace|constraint/i);

    // 不变式检查专用用户（避免与种子数据的唯一键/外键冲突）
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ).bind("u_chk_1", 901, "active", "chk_ek_1", "chk_eb_1", new Uint8Array([1]), T0, T0),
      env.DB.prepare(
        'INSERT INTO users (id, "order", status, email_key, email_binding_id, email_ciphertext, email_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ).bind("u_chk_2", 902, "active", "chk_ek_2", "chk_eb_2", new Uint8Array([2]), T0, T0),
    ]);

    // §5.1：initialized 行的 scope/calendar.event_types 非空约束
    await expect(
      run(
        "INSERT INTO user_subscriptions (user_id, state, schema_version, revision, scope_json, calendar_json, notifications_json, created_at, updated_at) VALUES ('u_chk_1', 'initialized', 3, 1, ?, ?, NULL, ?, ?)",
        JSON.stringify({ games: [], regions: ["CN"] }),
        JSON.stringify({ event_types: [], node_types: [], alarms_enabled: false }),
        T0,
        T0,
      ),
    ).rejects.toThrow(/CHECK/i);
    // uninitialized 允许空选择（§4.4：不写入任何默认值）
    await run(
      "INSERT INTO user_subscriptions (user_id, state, schema_version, revision, scope_json, calendar_json, notifications_json, created_at, updated_at) VALUES ('u_chk_2', 'uninitialized', 3, 0, NULL, NULL, NULL, ?, ?)",
      T0,
      T0,
    );
    // §4.5：expires_at 不得超过 absolute_expires_at
    await expect(
      run(
        "INSERT INTO sessions (id, user_id, token_hash, state, label, platform_hint, issued_at, absolute_expires_at, expires_at, renewed_at, auth_epoch, recovery_epoch, created_at, updated_at) VALUES ('s_chk', 'u_001', 'th_chk', 'pending', 'x', 'unknown', ?, ?, ?, ?, 0, 0, ?, ?)",
        T0,
        T0 + DAY,
        T0 + 2 * DAY,
        T0,
        T0,
        T0,
      ),
    ).rejects.toThrow(/constraint/i);
    // §7.5：routine 层是席位层的子集
    await expect(
      run(
        "INSERT INTO email_channels (user_id, enabled, routine_enabled, consent_version, address_version, channel_revision, created_at, updated_at) VALUES ('u_002', 0, 1, 0, 1, 0, ?, ?)",
        T0,
        T0,
      ),
    ).rejects.toThrow(/constraint/i);
    // §3.3：时间精度与存值形态一一对应（只有日期不补午夜）
    await expect(
      run(
        "INSERT INTO milestones (id, event_id, milestone_key, node_type, title, time_exact_ms, time_date, source_timezone, raw_expression, time_basis, time_precision, created_at, updated_at) VALUES ('m_chk', 'e_001', 'chk', 'start', 'x', ?, ?, 'UTC+8', 'raw', 'official_explicit', 'datetime', ?, ?)",
        T0,
        "2027-01-15",
        T0,
        T0,
      ),
    ).rejects.toThrow(/constraint/i);
    // §7.2：去重族唯一（同一逻辑提醒不重复）
    await expect(
      run(
        "INSERT INTO deliveries (id, occurrence_id, user_id, channel, target_ref, milestone_id, schedule_revision, rule_id, kind, priority, dedupe_family, mail_outbox_ref, status, expires_at, created_at, updated_at) VALUES ('d_chk', 'oc_001', 'u_001', 'email', 'u_001', 'm_001', 1, 'rule_1', 'rule', 1, ?, 'obx_001', 'pending', ?, ?, ?)",
        "m_001|1|rule_1|email|u_001",
        T0 + DAY,
        T0,
        T0,
      ),
    ).rejects.toThrow(/constraint|unique/i);
  }, 120_000);
});
