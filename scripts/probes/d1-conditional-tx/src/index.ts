// P0-01 探针：d1-conditional-tx
// 目的：观测真实 D1 上 batch 与条件更新（CAS）的行为，特别是——
//   「CAS 更新命中 0 行时，同批其他写入是否照样提交」（主方案 §3.6、§8.1、[R08]：
//   D1 batch 的 SQL 失败回滚 ≠ CAS 零行会自动失败；必须用统一条件守卫或约束保证整批一致）。
//
// 只读原则的边界说明：本探针在绑定的 D1 里创建并删除【自己的临时表】
// （p0_probe_cas / p0_probe_log），不接触任何业务表——观测 batch 语义必须真实写入。
// 请在临时/专用探针数据库上运行（OWNER_CHECKLIST）；结束时自动 DROP 清理。
//
// 运行（本地 miniflare，无需账户）：node scripts/probes/d1-conditional-tx/run-local.mjs
// 运行（目标环境，需所有者）：见 docs/evidence/p0/OWNER_CHECKLIST.md §B-3
// ⚠ 仅供临时运行取证，禁止公开部署。

interface D1MetaRecord {
  [key: string]: unknown;
}

interface D1ResultLike {
  success: boolean;
  meta: D1MetaRecord | null;
  results?: unknown[];
}

interface D1PreparedStatementLike {
  run(): Promise<D1ResultLike>;
  all(): Promise<D1ResultLike>;
  first<T = unknown>(col?: string): Promise<T | null>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

interface Env {
  PROBE_DB: D1DatabaseLike;
}

interface Step {
  id: string;
  purpose: string;
  threw: boolean;
  error: { name: string; message: string } | null;
  batch_meta: Array<Record<string, unknown>> | null;
  observation: Record<string, unknown>;
}

interface Summary {
  sqlite_version: string | null;
  batch_rolls_back_on_sql_error: boolean | null;
  cas_zero_rows_batch_threw: boolean | null;
  dependent_write_persisted_despite_cas_zero_rows: boolean | null;
  batch_rolls_back_on_cas_zero_rows: boolean | null;
  changes_guard_insert_ran_when_update_matched: boolean | null;
  changes_guard_blocked_dependent_write_on_miss: boolean | null;
  single_cas_miss_threw: boolean | null;
  single_cas_miss_changes: unknown;
  single_sql_error_threw: boolean | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimError(e: unknown): { name: string; message: string } {
  const err = e as { name?: string; message?: string };
  return {
    name: String(err?.name ?? typeof e),
    message: String(err?.message ?? e).slice(0, 300),
  };
}

function metasOf(results: D1ResultLike[]): Array<Record<string, unknown>> {
  return results.map((r) => ({ ...(r.meta ?? {}) }));
}

async function runExperiments(db: D1DatabaseLike) {
  const steps: Step[] = [];
  const metaFieldNames = new Set<string>();
  const trackMeta = (r: D1ResultLike | D1ResultLike[]) => {
    for (const one of Array.isArray(r) ? r : [r]) {
      for (const key of Object.keys(one.meta ?? {})) metaFieldNames.add(key);
    }
  };
  /** 执行一个实验步骤：统一记录 是否抛错 / 错误摘要 / batch meta / 附加观测。 */
  const step = async (
    id: string,
    purpose: string,
    body: () => Promise<{
      batch_meta?: Array<Record<string, unknown>>;
      observation?: Record<string, unknown>;
    }>,
  ): Promise<Step> => {
    const s: Step = { id, purpose, threw: false, error: null, batch_meta: null, observation: {} };
    try {
      const out = await body();
      s.batch_meta = out.batch_meta ?? null;
      s.observation = out.observation ?? {};
    } catch (e) {
      s.threw = true;
      s.error = trimError(e);
    }
    steps.push(s);
    return s;
  };
  const summary: Summary = {
    sqlite_version: null,
    batch_rolls_back_on_sql_error: null,
    cas_zero_rows_batch_threw: null,
    dependent_write_persisted_despite_cas_zero_rows: null,
    batch_rolls_back_on_cas_zero_rows: null,
    changes_guard_insert_ran_when_update_matched: null,
    changes_guard_blocked_dependent_write_on_miss: null,
    single_cas_miss_threw: null,
    single_cas_miss_changes: null,
    single_sql_error_threw: null,
  };

  // —— setup：重建探针自有临时表并种子一行 ——
  const setup = await step(
    "setup",
    "创建探针自有临时表 p0_probe_cas / p0_probe_log（结束后删除）",
    async () => {
      await db.prepare("DROP TABLE IF EXISTS p0_probe_cas").run();
      await db.prepare("DROP TABLE IF EXISTS p0_probe_log").run();
      await db
        .prepare(
          "CREATE TABLE p0_probe_cas (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)",
        )
        .run();
      await db
        .prepare(
          "CREATE TABLE p0_probe_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, created_at TEXT NOT NULL)",
        )
        .run();
      const seed = await db
        .prepare("INSERT INTO p0_probe_cas (id, version, done) VALUES (1, 1, 0)")
        .run();
      trackMeta(seed);
      return { observation: { seeded_row: { id: 1, version: 1, done: 0 } } };
    },
  );
  if (setup.threw) {
    return {
      ok: false,
      summary,
      steps,
      d1_meta_fields_observed: [...metaFieldNames].sort(),
      cleanup_ok: null,
    };
  }

  // —— sqlite_version（可选观测，某些 D1 部署禁用该函数，失败不阻断实验） ——
  const ver = await step(
    "sqlite-version",
    "SELECT sqlite_version()（可选；本地/部分部署可能禁用）",
    async () => {
      const v = await db.prepare("SELECT sqlite_version() AS v").first<string>("v");
      summary.sqlite_version = v ?? null;
      return { observation: { sqlite_version: v ?? null } };
    },
  );
  if (ver.threw) {
    summary.sqlite_version = null; // 函数被禁用（如本地 D1），本身也是一条观测
    ver.observation = { note: "sqlite_version() 不可用（该部署禁用了此函数）" };
  }

  // —— E1：batch 中第二条 SQL 语法错误 → 第一条 UPDATE 是否被回滚 ——
  const e1 = await step(
    "E1-sql-error-rollback",
    "batch([合法 UPDATE, 语法错误 SQL])：SQL 失败时整批是否回滚",
    async () => {
      const results = await db.batch([
        db.prepare("UPDATE p0_probe_cas SET version = 2 WHERE id = 1"),
        db.prepare("THIS IS NOT VALID SQL"),
      ]);
      trackMeta(results);
      return { batch_meta: metasOf(results), observation: { unexpected_success: true } };
    },
  );
  {
    const row = await db
      .prepare("SELECT version FROM p0_probe_cas WHERE id = 1")
      .first<number>("version");
    const versionAfter = row ?? null;
    summary.batch_rolls_back_on_sql_error = e1.threw && versionAfter === 1;
    e1.observation = { version_after_batch: versionAfter, expected_if_rolled_back: 1 };
  }

  // —— E2（核心）：CAS 更新命中 0 行 + 依赖写入同批 → 依赖写入是否照样提交 ——
  await db.prepare("UPDATE p0_probe_cas SET version = 1, done = 0 WHERE id = 1").run();
  const e2 = await step(
    "E2-cas-zero-rows",
    "batch([UPDATE WHERE version=99（永不命中）, INSERT 依赖行])：CAS 零行时 batch 是否回滚",
    async () => {
      const results = await db.batch([
        db.prepare("UPDATE p0_probe_cas SET version = 2, done = 1 WHERE id = 1 AND version = 99"),
        db.prepare(
          "INSERT INTO p0_probe_log (tag, created_at) VALUES ('depended-on-cas', datetime('now'))",
        ),
      ]);
      trackMeta(results);
      return { batch_meta: metasOf(results), observation: { unexpected_success: true } };
    },
  );
  {
    const persisted = await db
      .prepare("SELECT COUNT(*) AS n FROM p0_probe_log WHERE tag = 'depended-on-cas'")
      .first<number>("n");
    const persistedRows = persisted ?? -1;
    summary.cas_zero_rows_batch_threw = e2.threw;
    summary.dependent_write_persisted_despite_cas_zero_rows = !e2.threw && persistedRows === 1;
    summary.batch_rolls_back_on_cas_zero_rows = e2.threw && persistedRows === 0;
    e2.observation = {
      depended_rows_persisted: persistedRows,
      first_statement_changes: e2.batch_meta?.[0]?.changes ?? null,
      second_statement_changes: e2.batch_meta?.[1]?.changes ?? null,
    };
  }

  // —— E3：changes() 守卫模式 —— 用「上一条 UPDATE 命中行数」门控同批依赖写入 ——
  const runGuardCase = async (id: string, purpose: string, casCondition: string) =>
    step(id, purpose, async () => {
      await db.prepare("UPDATE p0_probe_cas SET version = 1, done = 0 WHERE id = 1").run();
      await db.prepare("DELETE FROM p0_probe_log WHERE tag = 'guard-ok'").run();
      const results = await db.batch([
        db.prepare(
          `UPDATE p0_probe_cas SET version = 2, done = 1 WHERE id = 1 AND ${casCondition}`,
        ),
        db.prepare(
          "INSERT INTO p0_probe_log (tag, created_at) SELECT 'guard-ok', datetime('now') WHERE changes() = 1",
        ),
      ]);
      trackMeta(results);
      const guardRows = await db
        .prepare("SELECT COUNT(*) AS n FROM p0_probe_log WHERE tag = 'guard-ok'")
        .first<number>("n");
      return {
        batch_meta: metasOf(results),
        observation: {
          cas_condition: casCondition,
          guard_rows: guardRows ?? -1,
          update_changes: results[0]?.meta?.changes ?? null,
        },
      };
    });

  const e3a = await runGuardCase(
    "E3a-changes-guard-hit",
    "batch([UPDATE 命中(version=1), INSERT ... WHERE changes()=1])：守卫应放行依赖写入",
    "version = 1 AND done = 0",
  );
  const e3b = await runGuardCase(
    "E3b-changes-guard-miss",
    "batch([UPDATE 不命中(version=99), INSERT ... WHERE changes()=1])：守卫应拦下依赖写入",
    "version = 99 AND done = 0",
  );
  if (!e3a.threw)
    summary.changes_guard_insert_ran_when_update_matched = Number(e3a.observation.guard_rows) === 1;
  if (!e3b.threw)
    summary.changes_guard_blocked_dependent_write_on_miss =
      Number(e3b.observation.guard_rows) === 0;

  // —— E4：单条语句层面「数据库报错」与「条件未命中」是否是两种不同结果 ——
  const e4a = await step(
    "E4a-single-cas-miss",
    "prepare('UPDATE WHERE version=99').run()：条件未命中是否抛错",
    async () => {
      const r = await db
        .prepare("UPDATE p0_probe_cas SET version = 3 WHERE id = 1 AND version = 99")
        .run();
      trackMeta(r);
      return { observation: { meta: { ...(r.meta ?? {}) } } };
    },
  );
  summary.single_cas_miss_threw = e4a.threw;
  summary.single_cas_miss_changes =
    (e4a.observation.meta as Record<string, unknown> | undefined)?.changes ?? null;

  const e4b = await step(
    "E4b-single-sql-error",
    "prepare('STILL NOT SQL').run()：语法错误应抛错",
    async () => {
      const r = await db.prepare("STILL NOT SQL").run();
      trackMeta(r);
      return { observation: { unexpected_success: true, meta: { ...(r.meta ?? {}) } } };
    },
  );
  summary.single_sql_error_threw = e4b.threw;

  // —— cleanup：删除探针自有表 ——
  const cleanup = await step("cleanup", "DROP 探针自有临时表", async () => {
    await db.prepare("DROP TABLE IF EXISTS p0_probe_cas").run();
    await db.prepare("DROP TABLE IF EXISTS p0_probe_log").run();
    return { observation: { dropped: ["p0_probe_cas", "p0_probe_log"] } };
  });

  return {
    ok: true,
    summary,
    steps,
    d1_meta_fields_observed: [...metaFieldNames].sort(),
    cleanup_ok: !cleanup.threw,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(`${JSON.stringify(body, null, 2)}\n`, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });

    if (url.pathname === "/health") {
      return json({ ok: true, probe: "d1-conditional-tx" });
    }
    if (url.pathname !== "/probe" || request.method !== "GET") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (!env.PROBE_DB) {
      return json(
        { ok: false, error: "missing_binding", hint: "需要 PROBE_DB（D1）绑定，见 wrangler.jsonc" },
        500,
      );
    }

    const experiment = await runExperiments(env.PROBE_DB);
    return json({
      probe: "d1-conditional-tx",
      schema_version: 1,
      generated_at_utc: nowIso(),
      environment_self_report: {
        runtime_user_agent: navigator.userAgent,
        note: "run_environment 由 runner / save-from-url.mjs 落盘时标注；remote 模式才代表目标环境",
      },
      experiment,
      notes: [
        "本探针只写自己的临时表 p0_probe_cas / p0_probe_log，结束时 DROP；不接触任何业务表。",
        "E2 是关键观测：CAS 零行 + 依赖写入同批提交 → 证实『batch 不会因 CAS 零行自动回滚』（[R08]），实现必须自带统一条件守卫。",
        "E3 观测 changes() 守卫在同批内是否可用；这只是行为记录，不构成 P1-05 条件提交原语的实现承诺。",
      ],
    });
  },
};
