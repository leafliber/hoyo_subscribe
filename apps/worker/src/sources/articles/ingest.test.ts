// A-P3-ARTICLE · 文章身份、不可变版本与红线落点（任务卡 P3-02）——L2 测试，
// 真实 workerd + miniflare D1（迁移空库顺序重放，纪律同 cas.test.ts / mutations.test.ts）。
// (source_id, external_id) 唯一；语义内容变化新增不可变 ArticleVersion（P1-04 触发器不被绕过）；
// ★ 抓取失败/列表为空零写入、无取消语义。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21819.json";
import genshinList from "../../../../../fixtures/sources/genshin-ann/list-page-1.json";
import { splitSqlStatements } from "../../storage/split-sql";
import { createAnnouncementAdapter } from "../adapters/announcement";
import type { AnnouncementSourceEntry } from "../registry";
import { getSourceEntry, SOURCE_REGISTRY } from "../registry";
import { sha256Hex } from "../snapshot-diff";
import type { ArticleCompletenessSignals, ArticleFetchResult, SourceItemStub } from "../types";
import {
  type ArticleSaveOutcome,
  buildArticleIngestPlan,
  saveArticleVersion,
  saveArticleVersions,
} from "./ingest";

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

// 合成基准时刻（非真实时间；两批间隔代表下一次轮询）。
const T1 = 1_800_000_000_000;
const T2 = 1_800_000_900_000;

interface MasterRow {
  type: string;
  name: string;
}

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length > 0 ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

const USER_OBJECT_FILTER = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";

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
        // 外键依赖：多轮重试直到清空
      }
    }
    remaining = (
      await query<MasterRow>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND ${USER_OBJECT_FILTER}`,
      )
    ).map((row) => row.name);
    if (!progress && remaining.length === 0) break;
  }
}

/** 空库顺序重放全部迁移（splitSqlStatements 切分后 batch；D1 exec 不感知纯注释段，P1-04 经验）。 */
async function replayMigrations(): Promise<void> {
  for (const path of Object.keys(migrationFiles).sort()) {
    const statements = splitSqlStatements(migrationFiles[path] ?? "");
    expect(statements.length, `迁移 ${path} 切分后为空`).toBeGreaterThan(0);
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }
}

/** 回放固定 JSON 响应的 fetch 替身（同 announcement.test.ts，不发真实网络请求）。 */
function replayFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const genshinEntry = getSourceEntry("genshin-ann") as AnnouncementSourceEntry;

interface ContentEntry {
  ann_id: number;
  title: string;
  content: string;
}

const contentEntries = (genshinContent as { body: { data: { list: ContentEntry[] } } }).body.data
  .list;

function findContentEntry(annId: number): ContentEntry {
  const entry = contentEntries.find((candidate) => candidate.ann_id === annId);
  if (entry === undefined) throw new Error(`fixtures 中找不到 ann_id=${annId}`);
  return entry;
}

function signalsFor(
  contentHtml: string,
  overrides: Partial<ArticleCompletenessSignals> = {},
): ArticleCompletenessSignals {
  return {
    contentEmpty: contentHtml.length === 0,
    imageCount: (contentHtml.match(/<img\b/gi) ?? []).length,
    contentBytes: new TextEncoder().encode(contentHtml).byteLength,
    bodyTruncated: false,
    ...overrides,
  };
}

/** 构造 fetched 抓取结果（形状与公告适配器一致；内容可替换以模拟官方修订）。 */
async function fetchedResult(
  entry: ContentEntry,
  contentHtml: string,
  fetchedAtMs: number,
): Promise<ArticleFetchResult> {
  return {
    status: "fetched",
    sourceId: genshinEntry.sourceId,
    externalId: String(entry.ann_id),
    title: entry.title,
    contentHtml,
    contentSha256: await sha256Hex(contentHtml),
    signals: signalsFor(contentHtml),
    fetchedAtMs,
  };
}

/** 真实列表里的 stub（外部身份与列表字段的官方事实来源）。 */
async function genshinStub(annId: string): Promise<SourceItemStub> {
  const adapter = createAnnouncementAdapter(genshinEntry, {
    fetchFn: replayFetch((genshinList as { body: unknown }).body),
  });
  const list = await adapter.list(null, Number.POSITIVE_INFINITY);
  const stub = list.items.find((candidate) => candidate.externalId === annId);
  if (stub === undefined) throw new Error(`列表样本中找不到 ann_id=${annId}`);
  return stub;
}

interface VersionRow {
  id: string;
  article_id: string;
  version_no: number;
  content_hash: string;
  body_blocks_json: string;
  media_refs_json: string;
  completeness: string;
  official_published_at: number | null;
  fetched_at: number;
  created_at: number;
}

interface ArticleRow {
  id: string;
  source_id: string;
  external_id: string;
  official_url: string;
  first_seen_at: number;
  last_checked_at: number;
}

async function versionsOf(articleId: string): Promise<VersionRow[]> {
  return query<VersionRow>(
    "SELECT * FROM article_versions WHERE article_id = ? ORDER BY version_no",
    articleId,
  );
}

async function articleByExternalId(externalId: string): Promise<ArticleRow | undefined> {
  const rows = await query<ArticleRow>(
    "SELECT * FROM articles WHERE source_id = ? AND external_id = ?",
    genshinEntry.sourceId,
    externalId,
  );
  return rows[0];
}

/** 独立的合成文章身份，正文仍用 P0-02 真实样本，避免六条回归场景共享版本历史。 */
async function syntheticGenshinCase(externalId: string): Promise<{
  stub: SourceItemStub;
  fetched: (atMs: number) => Promise<ArticleFetchResult>;
  truncated: ArticleFetchResult;
  missing: ArticleFetchResult;
}> {
  const content = findContentEntry(21928);
  const stub: SourceItemStub = { ...(await genshinStub("21928")), externalId };
  const fetched = async (atMs: number): Promise<ArticleFetchResult> => ({
    ...(await fetchedResult(content, content.content, atMs)),
    externalId,
  });
  const truncated: ArticleFetchResult = {
    status: "truncated",
    sourceId: genshinEntry.sourceId,
    externalId,
    observedAtLeastBytes: genshinEntry.requestLimits.maxResponseBytes + 1,
    capBytes: genshinEntry.requestLimits.maxResponseBytes,
  };
  const missing: ArticleFetchResult = {
    status: "missing-from-content-set",
    sourceId: genshinEntry.sourceId,
    externalId,
    note: "合成：全量正文集合缺条",
  };
  return { stub, fetched, truncated, missing };
}

async function saveSyntheticPlan(
  stub: SourceItemStub,
  result: ArticleFetchResult,
  nowMs: number,
): Promise<ArticleSaveOutcome> {
  const plan = await buildArticleIngestPlan(genshinEntry, stub, result, nowMs);
  if (plan.kind !== "version") throw new Error("该回归场景必须产版本计划");
  return saveArticleVersion(env.DB, plan.plan);
}

beforeAll(async () => {
  await resetToEmptyDatabase();
  await replayMigrations();
  // articles.source_id 有外键指向 sources：先播种来源注册行（值取自 SOURCE_REGISTRY 单一来源；
  // 来源注册表的持久化接线属后续任务卡，本测试只提供外键父行）。
  const seedRows = SOURCE_REGISTRY.map((entry) => [
    entry.sourceId,
    entry.game,
    entry.region,
    entry.adapterId,
    JSON.stringify(entry.approvedHosts),
    JSON.stringify(entry.verifiedPublishers),
    JSON.stringify({ model: entry.cursorModel }),
    JSON.stringify(entry.pollPolicy),
    entry.verificationState,
    Date.parse(entry.lastSuccessAtUtc),
    T1,
    T1,
  ]);
  await env.DB.batch(
    seedRows.map((row) =>
      env.DB.prepare(
        `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json, verified_publishers_json, cursor_json, poll_policy_json, verification_state, last_success_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...row),
    ),
  );
});

describe("A-P3-ARTICLE 文章身份与不可变版本（真实样本：genshin 21928 维护预告）", () => {
  it("首版入账：文章行 + 版本 1；标题块在版本内；official_url 为官方正文端点", async () => {
    const entry = findContentEntry(21928);
    const stub = await genshinStub("21928");
    const plan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      await fetchedResult(entry, entry.content, T1),
      T1,
    );
    expect(plan.kind).toBe("version");
    if (plan.kind !== "version") return;
    expect(plan.plan.completeness).toBe("complete");
    expect(plan.plan.officialUrl).toBe(
      "https://hk4e-ann-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent?game=hk4e&game_biz=hk4e_cn&bundle_id=hk4e_cn&channel_id=1&lang=zh-cn&level=60&platform=pc&region=cn_gf01&uid=100000000",
    );

    const outcome = await saveArticleVersion(env.DB, plan.plan);
    expect(outcome).toBe("created");

    const article = await articleByExternalId("21928");
    expect(article).toBeDefined();
    if (article === undefined) return;
    expect(article.source_id).toBe("genshin-ann");
    expect(article.external_id).toBe("21928");
    const rows = await versionsOf(article.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].version_no).toBe(1);
    const blocks = JSON.parse(rows[0].body_blocks_json) as Array<{
      kind: string;
      text?: string;
      html?: string;
    }>;
    expect(blocks[0]).toEqual({ kind: "title", text: "7.1版本更新维护预告" });
    // 公告列表 start_time 是展示窗口时间（§3.1 红线）：不写入 official_published_at。
    expect(rows[0].official_published_at).toBeNull();
    // 版本内正文块保真保留 t_gl 转义标签（JSON 序列化后引号转义，断言转义形态）。
    expect(rows[0].body_blocks_json).toContain("&lt;t class=");
    expect(rows[0].body_blocks_json).toContain('\\"t_gl\\"');
  });

  it("语义内容变化（官方修订维护时间 06:00→另一时间）→ 新增不可变版本 2，旧版本逐字段不被改写", async () => {
    const entry = findContentEntry(21928);
    const stub = await genshinStub("21928");
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    const before = (await versionsOf(article.id))[0];

    // 官方勘误：仅改时间文本，标题与块结构不变（真实修订形态）。
    const revised = entry.content.replaceAll("2026/09/23 06:00", "2026/09/24 06:00");
    expect(revised).not.toBe(entry.content);
    const plan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      await fetchedResult(entry, revised, T2),
      T2,
    );
    if (plan.kind !== "version") throw new Error("内容变化必须产版本计划");
    expect(await saveArticleVersion(env.DB, plan.plan)).toBe("created");

    const rows = await versionsOf(article.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].version_no).toBe(2);
    expect(rows[1].content_hash).not.toBe(rows[0].content_hash);
    // 旧版本逐字段原样（不可变：内容、时间与完整性都不被覆盖）。
    const after = rows[0];
    expect(after.id).toBe(before.id);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.body_blocks_json).toBe(before.body_blocks_json);
    expect(after.media_refs_json).toBe(before.media_refs_json);
    expect(after.completeness).toBe(before.completeness);
    expect(after.fetched_at).toBe(before.fetched_at);
    expect(after.created_at).toBe(before.created_at);
    // 文章身份唯一：(source_id, external_id) 仍然只有一行。
    expect(await articleByExternalId("21928")).toMatchObject({ id: article.id });
  });

  it("仅标题变化（正文不变）同样触发新版本——标题在版本内容内（仅正文变化已由上一用例覆盖）", async () => {
    const entry = findContentEntry(21928);
    const stub = await genshinStub("21928");
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    const countBefore = (await versionsOf(article.id)).length;

    // 上一用例已验证"仅正文变化"；此处验证"仅标题变化、正文回到原样"也产新版本。
    const retitled: ContentEntry = { ...entry, title: `${entry.title}（更新）` };
    const plan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      await fetchedResult(retitled, entry.content, T2 + 1),
      T2 + 1,
    );
    if (plan.kind !== "version") throw new Error("标题变化必须产版本计划");
    expect(await saveArticleVersion(env.DB, plan.plan)).toBe("created");
    const rows = await versionsOf(article.id);
    expect(rows).toHaveLength(countBefore + 1);
    const blocks = JSON.parse(rows[rows.length - 1].body_blocks_json) as Array<{
      kind: string;
      text?: string;
    }>;
    expect(blocks[0]?.text).toBe("7.1版本更新维护预告（更新）");
  });

  it("相同语义内容重复抓取（仅抓取时间不同）→ unchanged：噪声不触发新版本，只推进复查水位", async () => {
    const entry = findContentEntry(21928);
    const stub = await genshinStub("21928");
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    const rowsBefore = await versionsOf(article.id);

    const plan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      await fetchedResult(entry, entry.content, T2 + 2),
      T2 + 2,
    );
    if (plan.kind !== "version") throw new Error("有效抓取必须产版本计划");
    expect(await saveArticleVersion(env.DB, plan.plan)).toBe("unchanged");

    const rowsAfter = await versionsOf(article.id);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    const refreshed = await articleByExternalId("21928");
    expect(refreshed?.last_checked_at).toBe(T2 + 2); // 复查水位推进（§3.2 近期公告复查）
  });

  it("P1-04 触发器不被绕过：任何 UPDATE 版本行都被拒绝（不可变合同）", async () => {
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    await expect(
      env.DB.prepare("UPDATE article_versions SET completeness = 'complete' WHERE article_id = ?")
        .bind(article.id)
        .run(),
    ).rejects.toThrow(/不可变/);
  });

  it("UNIQUE (article_id, content_hash)：同 hash 直插被约束拒绝（守卫路径之外的双保险）", async () => {
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    const first = (await versionsOf(article.id))[0];
    await expect(
      env.DB.prepare(
        `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json, media_refs_json, completeness, official_published_at, fetched_at, created_at)
           VALUES ('dup-test', ?, 99, ?, '[]', '[]', 'complete', NULL, ?, ?)`,
      )
        .bind(article.id, first.content_hash, T2, T2)
        .run(),
    ).rejects.toThrow();
  });
});

describe("A-P3-ARTICLE ★ 抓取失败与空列表：零写入、无取消语义", () => {
  it("抓取失败不落任何行（不建文章行、不产空版本伪装成正文为空）", async () => {
    const stub = await genshinStub("21819"); // 列表里有、尚未入库的另一条
    const failed: ArticleFetchResult = {
      status: "failed",
      sourceId: genshinEntry.sourceId,
      externalId: "21819",
      failure: { kind: "network-error", name: "Error" },
    };
    const plan = await buildArticleIngestPlan(genshinEntry, stub, failed, T1);
    expect(plan.kind).toBe("no-write");
    const report = await saveArticleVersions(env.DB, [plan]);
    expect(report).toEqual({ created: 0, unchanged: 0, skippedNoWrite: 1, skippedDegraded: 0 });
    expect(await articleByExternalId("21819")).toBeUndefined();
  });

  it("抓取失败不触碰已有文章的任何版本（已入库内容原样保留，不产生删除/取消类写）", async () => {
    const article = await articleByExternalId("21928");
    if (article === undefined) throw new Error("前置用例应已建文章行");
    const rowsBefore = await versionsOf(article.id);
    const stub = await genshinStub("21928");
    const failed: ArticleFetchResult = {
      status: "failed",
      sourceId: genshinEntry.sourceId,
      externalId: "21928",
      failure: { kind: "timeout" },
    };
    const plan = await buildArticleIngestPlan(genshinEntry, stub, failed, T2);
    expect(plan.kind).toBe("no-write");
    await saveArticleVersions(env.DB, [plan]);
    const rowsAfter = await versionsOf(article.id);
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it("空列表批次 → 零 SQL 效果（articles / article_versions 行数都不变）", async () => {
    const articlesBefore = await query<{ count: number }>("SELECT COUNT(*) AS count FROM articles");
    const versionsBefore = await query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM article_versions",
    );
    const report = await saveArticleVersions(env.DB, []);
    expect(report).toEqual({ created: 0, unchanged: 0, skippedNoWrite: 0, skippedDegraded: 0 });
    const articlesAfter = await query<{ count: number }>("SELECT COUNT(*) AS count FROM articles");
    const versionsAfter = await query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM article_versions",
    );
    expect(articlesAfter[0]?.count).toBe(articlesBefore[0]?.count);
    expect(versionsAfter[0]?.count).toBe(versionsBefore[0]?.count);
  });
});

describe("A-P3-ARTICLE 缺口成态：截断 / 图片承载日期 / 来源暂空（都不是「无活动」）", () => {
  it("纯图片正文（genshin 21922 真实样本）→ review-image-borne 版本", async () => {
    const entry = findContentEntry(21922);
    const stub = await genshinStub("21922");
    const plan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      await fetchedResult(entry, entry.content, T1),
      T1,
    );
    if (plan.kind !== "version") throw new Error("有效抓取必须产版本计划");
    expect(plan.plan.completeness).toBe("review-image-borne");
    expect(await saveArticleVersion(env.DB, plan.plan)).toBe("created");
    const article = await articleByExternalId("21922");
    if (article === undefined) throw new Error("应已建文章行");
    const rows = await versionsOf(article.id);
    expect(rows[0].completeness).toBe("review-image-borne");
    const mediaRefs = JSON.parse(rows[0].media_refs_json) as unknown[];
    expect(mediaRefs).toHaveLength(1);
  });

  it("A-P3-TRUNCATE 截断态只存列表标题，绝不把无法解析的正文当完整正文", async () => {
    const stub = await genshinStub("21928");
    const truncated: ArticleFetchResult = {
      status: "truncated",
      sourceId: genshinEntry.sourceId,
      externalId: "21928",
      observedAtLeastBytes: genshinEntry.requestLimits.maxResponseBytes + 1,
      capBytes: genshinEntry.requestLimits.maxResponseBytes,
    };
    const plan = await buildArticleIngestPlan(genshinEntry, stub, truncated, T1);
    if (plan.kind !== "version") throw new Error("该场景必须产版本计划");
    expect(plan.plan.completeness).toBe("gap-body-truncated");
    expect(plan.plan.blocks).toEqual([{ kind: "title", text: stub.title }]);

    // 即便适配器返回 fetched 形状，显式 bodyTruncated 信号仍使正文不可被信任。
    const entry = findContentEntry(21928);
    const signaled = await fetchedResult(entry, entry.content, T1);
    if (signaled.status !== "fetched") throw new Error("测试原料应为 fetched");
    const signaledPlan = await buildArticleIngestPlan(
      genshinEntry,
      stub,
      { ...signaled, signals: { ...signaled.signals, bodyTruncated: true } },
      T1,
    );
    if (signaledPlan.kind !== "version") throw new Error("截断信号应产缺口计划");
    expect(signaledPlan.plan.completeness).toBe("gap-body-truncated");
    expect(signaledPlan.plan.blocks).toEqual([{ kind: "title", text: stub.title }]);
  });

  it("来源暂空：列表声称有正文而正文集合给空 → gap-source-empty 版本（构造空正文的真实条目）", async () => {
    const entry = findContentEntry(21928);
    const stub = await genshinStub("21928");
    const emptied: ContentEntry = { ...entry, content: "" };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let plan: Awaited<ReturnType<typeof buildArticleIngestPlan>>;
    let logLines: string[] = [];
    try {
      plan = await buildArticleIngestPlan(
        genshinEntry,
        stub,
        await fetchedResult(emptied, "", T1),
        T1,
      );
      logLines = logSpy.mock.calls.map(([line]) => String(line));
    } finally {
      logSpy.mockRestore();
    }
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "source_content_gap",
        source: genshinEntry.sourceId,
        reason_code: "source_empty",
        count: 1,
      }),
    );
    expect(logLines.join("\n")).not.toContain(stub.externalId);
    if (plan.kind !== "version") throw new Error("该场景必须产版本计划");
    expect(plan.plan.completeness).toBe("gap-source-empty");
    expect(plan.plan.blocks).toHaveLength(1); // 只剩标题块
  });

  it("列表声称有正文但正文集合缺该条 → gap-content-missing 版本", async () => {
    const stub = await genshinStub("21928");
    const missing: ArticleFetchResult = {
      status: "missing-from-content-set",
      sourceId: genshinEntry.sourceId,
      externalId: "21928",
      note: "全量正文响应中无此 ann_id",
    };
    const plan = await buildArticleIngestPlan(genshinEntry, stub, missing, T1);
    if (plan.kind !== "version") throw new Error("该场景必须产版本计划");
    expect(plan.plan.completeness).toBe("gap-content-missing");
  });
});

describe("A-P3-TRUNCATE 受限读体到落库的闭环（合成超限响应）", () => {
  it("全量正文超限时用真实列表条目落 gap-body-truncated 行，不保存残缺正文，也不追加请求", async () => {
    const stub = await genshinStub("762");
    const cap = 1024; // 测试专用小上限；生产值只从 SOURCE_LIMIT_PROFILE 取。
    const privateBodyMarker = "SYNTHETIC_TRUNCATED_BODY_MUST_NOT_BE_STORED";
    const responseBody = JSON.stringify({
      retcode: 0,
      data: { list: [{ ann_id: 762, content: `${privateBodyMarker}${"x".repeat(cap)}` }] },
    });
    expect(new TextEncoder().encode(responseBody).byteLength).toBeGreaterThan(cap);
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      return new Response(responseBody, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const adapter = createAnnouncementAdapter(
      {
        ...genshinEntry,
        requestLimits: { ...genshinEntry.requestLimits, maxResponseBytes: cap },
      },
      { fetchFn },
    );
    const article = await adapter.fetchArticle({
      sourceId: genshinEntry.sourceId,
      externalId: stub.externalId,
      title: stub.title,
    });
    expect(article).toMatchObject({
      status: "truncated",
      capBytes: cap,
      observedAtLeastBytes: expect.any(Number),
    });
    const plan = await buildArticleIngestPlan(genshinEntry, stub, article, T2);
    expect(plan.kind).toBe("version");
    if (plan.kind !== "version") return;
    expect(plan.plan.completeness).toBe("gap-body-truncated");
    expect(plan.plan.blocks).toEqual([{ kind: "title", text: stub.title }]);
    expect(JSON.stringify(plan.plan)).not.toContain(privateBodyMarker);
    expect(requests).toBe(1);

    expect(await saveArticleVersions(env.DB, [plan])).toEqual({
      created: 1,
      unchanged: 0,
      skippedNoWrite: 0,
      skippedDegraded: 0,
    });
    const saved = await articleByExternalId(stub.externalId);
    expect(saved).toBeDefined();
    if (saved === undefined) return;
    const rows = await versionsOf(saved.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].completeness).toBe("gap-body-truncated");
    expect(rows[0].body_blocks_json).not.toContain(privateBodyMarker);
  });
});

describe("A-P3-TRUNCATE 降级抓取不得覆盖真实正文（独立合成身份）", () => {
  it("A-P3-TRUNCATE 完整→截断→同正文恢复：最新版本始终是完整版", async () => {
    const { stub, fetched, truncated } = await syntheticGenshinCase("p3-08-truncate-recover");
    expect(await saveSyntheticPlan(stub, await fetched(T1), T1)).toBe("created");
    const article = await articleByExternalId(stub.externalId);
    if (article === undefined) throw new Error("应已建文章行");
    const first = (await versionsOf(article.id))[0];
    expect(first.completeness).toBe("complete");

    const degraded = await buildArticleIngestPlan(genshinEntry, stub, truncated, T2);
    expect(await saveArticleVersions(env.DB, [degraded])).toEqual({
      created: 0,
      unchanged: 0,
      skippedNoWrite: 0,
      skippedDegraded: 1,
    });
    expect(await saveSyntheticPlan(stub, await fetched(T2 + 1), T2 + 1)).toBe("unchanged");
    const versions = await versionsOf(article.id);
    expect(versions).toHaveLength(1);
    expect(versions.at(-1)).toEqual(first);
    expect((await articleByExternalId(stub.externalId))?.last_checked_at).toBe(T2 + 1);
  });

  it("A-P3-TRUNCATE 完整→集合缺条→同正文恢复：最新版本仍是完整版且缺条有信号", async () => {
    const { stub, fetched, missing } = await syntheticGenshinCase("p3-08-missing-recover");
    expect(await saveSyntheticPlan(stub, await fetched(T1), T1)).toBe("created");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let logLines: string[] = [];
    try {
      expect(await saveSyntheticPlan(stub, missing, T2)).toBe("degraded-skipped");
      logLines = logSpy.mock.calls.map(([line]) => String(line));
    } finally {
      logSpy.mockRestore();
    }
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "source_content_gap",
        source: genshinEntry.sourceId,
        reason_code: "content_set_missing",
        count: 1,
      }),
    );
    expect(logLines.join("\n")).not.toContain(stub.externalId);
    expect(await saveSyntheticPlan(stub, await fetched(T2 + 1), T2 + 1)).toBe("unchanged");
    const article = await articleByExternalId(stub.externalId);
    if (article === undefined) throw new Error("应已建文章行");
    const versions = await versionsOf(article.id);
    expect(versions).toHaveLength(1);
    expect(versions.at(-1)?.completeness).toBe("complete");
  });

  it("A-P3-TRUNCATE 新文章先截断落标题缺口版，再取得正文成为最新完整版", async () => {
    const { stub, fetched, truncated } = await syntheticGenshinCase("p3-08-first-gap");
    expect(await saveSyntheticPlan(stub, truncated, T1)).toBe("created");
    const article = await articleByExternalId(stub.externalId);
    if (article === undefined) throw new Error("缺口版应建立文章行");
    const first = (await versionsOf(article.id))[0];
    expect(first.completeness).toBe("gap-body-truncated");
    expect(JSON.parse(first.body_blocks_json)).toEqual([{ kind: "title", text: stub.title }]);

    expect(await saveSyntheticPlan(stub, await fetched(T2), T2)).toBe("created");
    const versions = await versionsOf(article.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ version_no: 2, completeness: "complete" });
    expect(versions[1].body_blocks_json).toContain("&lt;t class=");
  });

  it("A-P3-TRUNCATE 最新完整遇截断：无新版本、有超限信号、复查水位不推进", async () => {
    const { stub, fetched } = await syntheticGenshinCase("p3-08-no-success-watermark");
    expect(await saveSyntheticPlan(stub, await fetched(T1), T1)).toBe("created");
    const article = await articleByExternalId(stub.externalId);
    if (article === undefined) throw new Error("应已建文章行");
    const before = await versionsOf(article.id);
    const cap = 1024; // 测试专用；生产上限来自 SOURCE_LIMIT_PROFILE。
    const adapter = createAnnouncementAdapter(
      {
        ...genshinEntry,
        requestLimits: { ...genshinEntry.requestLimits, maxResponseBytes: cap },
      },
      {
        fetchFn: replayFetch({
          retcode: 0,
          data: { list: [{ ann_id: 21928, content: "x".repeat(cap) }] },
        }),
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let result: ArticleFetchResult | undefined;
    let logLines: string[] = [];
    try {
      result = await adapter.fetchArticle({
        sourceId: genshinEntry.sourceId,
        externalId: stub.externalId,
        title: stub.title,
      });
      logLines = logSpy.mock.calls.map(([line]) => String(line));
    } finally {
      logSpy.mockRestore();
    }
    if (result === undefined) throw new Error("适配器应返回抓取结果");
    expect(result.status).toBe("truncated");
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "source_response_truncated",
        source: genshinEntry.approvedHosts[0],
        reason_code: "response_cap_exceeded",
        count: 1,
      }),
    );
    expect(await saveSyntheticPlan(stub, result, T2)).toBe("degraded-skipped");
    expect(await versionsOf(article.id)).toEqual(before);
    expect((await articleByExternalId(stub.externalId))?.last_checked_at).toBe(T1);
  });

  it("A-P3-TRUNCATE 降级→降级且列表标题变化：新增降级版本", async () => {
    const { stub, truncated } = await syntheticGenshinCase("p3-08-gap-retitle");
    expect(await saveSyntheticPlan(stub, truncated, T1)).toBe("created");
    const retitled: SourceItemStub = { ...stub, title: `${stub.title}（列表修订）` };
    expect(await saveSyntheticPlan(retitled, truncated, T2)).toBe("created");
    const article = await articleByExternalId(stub.externalId);
    if (article === undefined) throw new Error("应已建文章行");
    const versions = await versionsOf(article.id);
    expect(versions).toHaveLength(2);
    expect(versions[1].completeness).toBe("gap-body-truncated");
    expect(JSON.parse(versions[1].body_blocks_json)).toEqual([
      { kind: "title", text: retitled.title },
    ]);
    expect((await articleByExternalId(stub.externalId))?.last_checked_at).toBe(T1);
  });
});
