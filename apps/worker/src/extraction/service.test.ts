// A-P3-EXTRACT · 真实公告样本 + 本地 D1；不访问官方网络，也不调用模型。
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import genshinMaintenance from "../../../../fixtures/sources/genshin-ann/content-21928.json";
import hsrActivity from "../../../../fixtures/sources/hsr-ann/content-1392.json";
import zzzPhasedActivity from "../../../../fixtures/sources/zzz-ann/content-1301.json";
import zzzActivity from "../../../../fixtures/sources/zzz-ann/content-1303.json";
import { extractArticleVersion } from "../executors/pipeline/extract";
import { classifyPipelineFailure } from "../executors/pipeline/failure";
import {
  blockVisibleText,
  denoiseTitle,
  extractImageRefsFromHtml,
  splitBodyBlocks,
} from "../sources/articles/blocks";
import type { ArticleCompleteness } from "../sources/articles/completeness";
import { getSourceEntry } from "../sources/registry";
import { splitSqlStatements } from "../storage/split-sql";
import { loadStoredArticleVersion } from "./article";
import { extractByRules } from "./rules";
import {
  createManualCandidate,
  decideCandidate,
  listReviewQueue,
  reviseCandidate,
} from "./service";

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
const T0 = 1_800_000_000_000;

interface MasterRow {
  type: string;
  name: string;
}
interface FixtureEntry {
  ann_id: number;
  title: string;
  content: string;
}
interface FixtureBody {
  body: { data: { list: FixtureEntry[] } };
}

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const statement = params.length === 0 ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(...params);
  return (await statement.all<T>()).results ?? [];
}

async function resetDatabase(): Promise<void> {
  const filter = "name NOT LIKE 'sqlite_%' AND substr(name, 1, 3) <> '_cf'";
  for (const obj of await query<MasterRow>(
    `SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND ${filter}`,
  ))
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  let tables = (
    await query<MasterRow>(
      `SELECT type, name FROM sqlite_master WHERE type = 'table' AND ${filter}`,
    )
  ).map((row) => row.name);
  for (let pass = 0; tables.length > 0 && pass < 20; pass++) {
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table}";`);
      } catch {
        /* 外键依赖，下一轮重试 */
      }
    }
    tables = (
      await query<MasterRow>(
        `SELECT type, name FROM sqlite_master WHERE type = 'table' AND ${filter}`,
      )
    ).map((row) => row.name);
  }
  expect(tables).toEqual([]);
  for (const path of Object.keys(migrationFiles).sort()) {
    const statements = splitSqlStatements(migrationFiles[path] ?? "");
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  }
}

async function seedSource(sourceId: string): Promise<void> {
  const entry = getSourceEntry(sourceId);
  await env.DB.prepare(
    `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json,
                          verified_publishers_json, cursor_json, poll_policy_json,
                          verification_state, last_success_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      entry.sourceId,
      entry.game,
      entry.region,
      entry.adapterId,
      JSON.stringify(entry.approvedHosts),
      JSON.stringify(entry.verifiedPublishers),
      JSON.stringify({ model: entry.cursorModel }),
      JSON.stringify(entry.pollPolicy),
      entry.verificationState,
      T0,
      T0,
    )
    .run();
}

function fixtureEntry(fixture: FixtureBody, annId: number): FixtureEntry {
  const entry = fixture.body.data.list.find((item) => item.ann_id === annId);
  if (entry === undefined) throw new Error(`fixture 缺 ann_id ${annId}`);
  return entry;
}

async function seedArticle(
  sourceId: string,
  entry: FixtureEntry,
  completeness: ArticleCompleteness = "complete",
  html = entry.content,
  externalId = String(entry.ann_id),
): Promise<string> {
  const source = getSourceEntry(sourceId);
  const articleId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blocks = [{ kind: "title", text: denoiseTitle(entry.title) }, ...splitBodyBlocks(html)];
  const mediaRefs = extractImageRefsFromHtml(html).map((url) => ({ url, origin: "body" }));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at,
                             last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(articleId, sourceId, externalId, `https://${source.approvedHosts[0]}/`, T0, T0, T0, T0),
    env.DB.prepare(
      `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json,
                                     media_refs_json, completeness, official_published_at, fetched_at, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      versionId,
      articleId,
      crypto.randomUUID(),
      JSON.stringify(blocks),
      JSON.stringify(mediaRefs),
      completeness,
      T0,
      T0,
    ),
  ]);
  return versionId;
}

let hsrVersion: string;
let zzzVersion: string;
let genshinVersion: string;
let zzzPhasedVersion: string;

beforeAll(async () => {
  await resetDatabase();
  for (const sourceId of ["hsr-ann", "zzz-ann", "genshin-ann"]) await seedSource(sourceId);
  hsrVersion = await seedArticle("hsr-ann", fixtureEntry(hsrActivity, 1392));
  zzzVersion = await seedArticle("zzz-ann", fixtureEntry(zzzActivity, 1303));
  genshinVersion = await seedArticle("genshin-ann", fixtureEntry(genshinMaintenance, 21928));
  zzzPhasedVersion = await seedArticle("zzz-ann", fixtureEntry(zzzPhasedActivity, 1301));
});

describe("A-P3-EXTRACT 规则白名单与人工审核领域层", () => {
  it("真实星铁 1392：t_lc/t_gl 双精确节点自动批准、证据可定位、重放不重复写", async () => {
    const model = { propose: vi.fn(async () => ({ fabricated: true })) };
    const first = await extractArticleVersion(env.DB, hsrVersion, T0 + 1, model);
    expect(first.rule.kind).toBe("ready_for_publication");
    if (first.rule.kind === "ready_for_publication")
      expect(first.rule.templateId).toBe("hsr-activity-time-tags-v1");
    expect(first.candidate.reviewStatus).toBe("approved");
    expect(first.candidate.proposal.events[0].event_type).toBe("limited_event");
    expect(first.candidate.proposal.events[0].milestones.map((m) => m.time_evidence.tag)).toEqual([
      "t_lc",
      "t_gl",
    ]);
    expect(first.candidate.proposal.events[0].milestones[0].time).toMatchObject({
      precision: "datetime",
      utc_ms: Date.parse("2026-09-18T20:00:00Z"),
      time_basis: "official_explicit",
    });
    expect(first.candidate.sourceId).toBe("hsr-ann");
    expect(first.candidate.region).toBe("CN");
    const second = await extractArticleVersion(env.DB, hsrVersion, T0 + 2, model);
    expect(second.replayed).toBe(true);
    expect(second.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(model.propose).not.toHaveBeenCalled();
    expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM events"))[0].n).toBe(0);
    expect(
      (
        await query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM evidence WHERE candidate_id = ?",
          first.candidate.candidateId,
        )
      )[0].n,
    ).toBe(2);
  });

  it("真实绝区零 1303：服务器时间双完整节点自动批准，图片/多阶段样本 1301 进审核", async () => {
    const accepted = await extractArticleVersion(env.DB, zzzVersion, T0 + 3);
    expect(accepted.rule.kind).toBe("ready_for_publication");
    if (accepted.rule.kind === "ready_for_publication")
      expect(accepted.rule.templateId).toBe("zzz-server-time-range-v1");
    expect(
      accepted.candidate.proposal.events[0].milestones.map((m) => m.time_evidence.tag),
    ).toEqual([null, null]);
    expect(accepted.candidate.proposal.events[0].milestones[1].time).toMatchObject({
      precision: "datetime",
      utc_ms: Date.parse("2026-09-27T19:59:00Z"),
    });
    const phased = await extractArticleVersion(env.DB, zzzPhasedVersion, T0 + 4);
    expect(phased.rule.kind).toBe("review");
    expect(phased.candidate.reviewStatus).toBe("pending");
    expect(phased.candidate.proposal.classification).toBe("uncertain");
  });

  it("来源运行中转为维护态时，历史完整正文也不走自动批准", async () => {
    const entry = fixtureEntry(hsrActivity, 1392);
    const version = await seedArticle(
      "hsr-ann",
      entry,
      "complete",
      entry.content,
      "1392-synthetic-maintenance",
    );
    await env.DB.prepare(
      "UPDATE sources SET verification_state = 'maintenance-required' WHERE source_id = 'hsr-ann'",
    ).run();
    try {
      const outcome = await extractArticleVersion(env.DB, version, T0 + 4);
      expect(outcome.rule.kind).toBe("review");
      expect(outcome.candidate.reviewStatus).toBe("pending");
    } finally {
      await env.DB.prepare(
        "UPDATE sources SET verification_state = 'verified-working' WHERE source_id = 'hsr-ann'",
      ).run();
    }
  });

  it("纯日期节点、缺年跨年范围、更新后开放都不猜时刻且不自动批准", async () => {
    const original = fixtureEntry(zzzActivity, 1303);
    const dateOnly = original.content
      .replace("2026/09/23 04:00", "2026/09/23")
      .replace("2026/09/28 03:59", "2026/09/28");
    const dateVersion = await seedArticle(
      "zzz-ann",
      original,
      "complete",
      dateOnly,
      "1303-synthetic-date-only",
    );
    const dateOutcome = await extractArticleVersion(env.DB, dateVersion, T0 + 5);
    expect(dateOutcome.rule.kind).toBe("review");
    expect(dateOutcome.candidate.reviewStatus).toBe("pending");
    expect(JSON.stringify(dateOutcome.candidate.proposal)).not.toContain("00:00");

    const missingYear = original.content
      .replace("2026/09/23 04:00", "12/31 04:00")
      .replace("2026/09/28 03:59", "01/02 03:59");
    const yearVersion = await seedArticle(
      "zzz-ann",
      original,
      "complete",
      missingYear,
      "1303-synthetic-missing-year",
    );
    expect((await extractArticleVersion(env.DB, yearVersion, T0 + 6)).candidate.reviewStatus).toBe(
      "pending",
    );

    const relative = original.content.replace("2026/09/23 04:00", "版本更新后开放");
    const relativeVersion = await seedArticle(
      "zzz-ann",
      original,
      "complete",
      relative,
      "1303-synthetic-relative",
    );
    expect(
      (await extractArticleVersion(env.DB, relativeVersion, T0 + 7)).candidate.reviewStatus,
    ).toBe("pending");
  });

  it("预计维护五小时不是实际开服；模型计费 profile 关闭时绝不调用端口", async () => {
    const model = {
      propose: vi.fn(async () => {
        throw new Error("不应调用模型");
      }),
    };
    const outcome = await extractArticleVersion(env.DB, genshinVersion, T0 + 8, model);
    expect(outcome.rule.kind).toBe("review");
    expect(outcome.candidate.reviewStatus).toBe("pending");
    expect(outcome.candidate.proposal.events).toEqual([]);
    expect(model.propose).not.toHaveBeenCalled();
    await expect(
      decideCandidate(
        env.DB,
        outcome.candidate.candidateId,
        "approved",
        "reviewer-id",
        "仍有缺口",
        T0 + 9,
      ),
    ).rejects.toThrow("不能批准");
  });

  it("五种非 complete 完整性状态均只形成审核缺口，不得断言无事件或取消", async () => {
    const original = fixtureEntry(zzzActivity, 1303);
    const gaps: ArticleCompleteness[] = [
      "gap-body-truncated",
      "gap-content-missing",
      "gap-source-empty",
      "gap-channel-unavailable",
      "review-image-borne",
    ];
    for (const [index, completeness] of gaps.entries()) {
      const version = await seedArticle(
        "zzz-ann",
        original,
        completeness,
        original.content,
        `1303-synthetic-${completeness}`,
      );
      const outcome = await extractArticleVersion(env.DB, version, T0 + 10 + index);
      expect(outcome.rule.kind).toBe("review");
      expect(outcome.candidate.proposal.classification).toBe("uncertain");
      expect(outcome.candidate.proposal.events).toEqual([]);
      expect(outcome.candidate.reviewStatus).toBe("pending");
    }
  });

  it("人工可在没有任何抽取运行时直接依据已保存正文创建完整事件候选", async () => {
    const entry = fixtureEntry(hsrActivity, 1392);
    const version = await seedArticle(
      "hsr-ann",
      entry,
      "complete",
      entry.content,
      "1392-synthetic-manual-first",
    );
    const article = await loadStoredArticleVersion(env.DB, version);
    const rule = extractByRules(article);
    expect(rule.kind).toBe("ready_for_publication");
    if (rule.kind !== "ready_for_publication") return;
    expect(
      (
        await query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM extraction_runs WHERE article_version_id = ?",
          version,
        )
      )[0].n,
    ).toBe(0);
    const manual = await createManualCandidate(env.DB, version, rule.proposal, T0 + 19);
    expect(manual.path).toBe("manual");
    expect(manual.reviewStatus).toBe("pending");
    expect(manual.proposal.events[0].milestones).toHaveLength(2);
    expect(
      (
        await query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM extraction_runs WHERE article_version_id = ?",
          version,
        )
      )[0].n,
    ).toBe(0);
  });

  it("无需模型运行即可从保存的 ArticleVersion 人工新建、修正并裁定候选；人工接管优先", async () => {
    const article = await loadStoredArticleVersion(env.DB, zzzPhasedVersion);
    const timeIndex =
      article.blocks.findIndex((block) => blockVisibleText(block).trim() === "【活动时间】") + 1;
    expect(timeIndex).toBeGreaterThan(0);
    const title = blockVisibleText(article.blocks[0]);
    const input = {
      classification: "events",
      ambiguities: [],
      events: [
        {
          event_key: "primary",
          event_type: "limited_event",
          status: "scheduled",
          title,
          summary: null,
          type_evidence: { block_ref: "blocks/0", quote: "活动说明", tag: null },
          status_evidence: null,
          change_relation: null,
          milestones: [
            {
              milestone_key: "start",
              node_type: "start",
              title: "玩法开始",
              time: {
                precision: "datetime",
                utc_ms: Date.parse("2026-09-16T02:00:00Z"),
                source_timezone: "UTC+08:00",
                raw_expression: "2026/09/16 10:00",
                time_basis: "official_explicit",
              },
              time_evidence: {
                block_ref: `blocks/${timeIndex}`,
                quote: "2026/09/16 10:00",
                tag: null,
              },
            },
            {
              milestone_key: "end",
              node_type: "end",
              title: "玩法结束",
              time: {
                precision: "datetime",
                utc_ms: Date.parse("2026-10-04T19:59:00Z"),
                source_timezone: "UTC+08:00",
                raw_expression: "2026/10/05 03:59",
                time_basis: "official_explicit",
              },
              time_evidence: {
                block_ref: `blocks/${timeIndex}`,
                quote: "2026/10/05 03:59",
                tag: null,
              },
            },
          ],
        },
      ],
    };
    const manual = await createManualCandidate(env.DB, zzzPhasedVersion, input, T0 + 20);
    expect(manual.path).toBe("manual");
    expect(manual.reviewStatus).toBe("pending");
    expect(manual.sourceId).toBe("zzz-ann");
    expect(manual.articleVersionId).toBe(zzzPhasedVersion);
    expect(
      (
        await query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM extraction_runs WHERE article_version_id = ?",
          zzzPhasedVersion,
        )
      )[0].n,
    ).toBe(1); // 先前只有规则入队，无模型结果
    expect(
      (await listReviewQueue(env.DB)).some(
        (candidate) => candidate.candidateId === manual.candidateId,
      ),
    ).toBe(true);
    await expect(
      reviseCandidate(
        env.DB,
        manual.candidateId,
        {
          ...input,
          events: [
            {
              ...input.events[0],
              milestones: [
                { ...input.events[0].milestones[0], milestone_key: "opening" },
                input.events[0].milestones[1],
              ],
            },
          ],
        },
        T0 + 21,
      ),
    ).rejects.toThrow("milestone_key");
    const corrected = await reviseCandidate(
      env.DB,
      manual.candidateId,
      {
        ...input,
        events: [{ ...input.events[0], summary: "人工核对图片后保留完整时刻" }],
      },
      T0 + 21,
    );
    expect(corrected.candidateId).toBe(manual.candidateId);
    expect(corrected.proposal.events[0].milestones.map((m) => m.milestone_key)).toEqual([
      "start",
      "end",
    ]);
    const decided = await decideCandidate(
      env.DB,
      manual.candidateId,
      "approved",
      "reviewer-id",
      "已核对原文",
      T0 + 22,
    );
    expect(decided.reviewStatus).toBe("approved");
    expect(decided.path).toBe("manual");
    expect(
      (await listReviewQueue(env.DB)).some(
        (candidate) => candidate.candidateId === manual.candidateId,
      ),
    ).toBe(false);
    const rerun = await extractArticleVersion(env.DB, zzzPhasedVersion, T0 + 23);
    expect(rerun.candidate.candidateId).toBe(manual.candidateId);
    expect(rerun.candidate.path).toBe("manual");
    expect(rerun.replayed).toBe(true);
  });

  it("人工输入伪造 source_id/article_version 及无官方时间引文时拒绝，来源身份来自存储", async () => {
    const article = await loadStoredArticleVersion(env.DB, zzzVersion);
    const rule = extractByRules(article);
    expect(rule.kind).toBe("ready_for_publication");
    if (rule.kind !== "ready_for_publication") return;
    await expect(
      createManualCandidate(
        env.DB,
        zzzVersion,
        { ...rule.proposal, source_id: "hsr-ann" },
        T0 + 30,
      ),
    ).rejects.toThrow("未知字段");
    await expect(
      createManualCandidate(
        env.DB,
        zzzVersion,
        { ...rule.proposal, article_version: "forged" },
        T0 + 31,
      ),
    ).rejects.toThrow("未知字段");
    const event = rule.proposal.events[0];
    const milestone = event.milestones[0];
    await expect(
      createManualCandidate(
        env.DB,
        zzzVersion,
        {
          ...rule.proposal,
          events: [
            {
              ...event,
              milestones: [
                {
                  ...milestone,
                  time_evidence: { block_ref: "blocks/1", quote: "2026/09/23 00:00", tag: null },
                },
              ],
            },
          ],
        },
        T0 + 32,
      ),
    ).rejects.toThrow();
  });
});

describe("A-P3-SOURCE-RETIRE 已下线来源的历史文章（ADR-0016）", () => {
  it("米游社历史版本不再用于抽取、审核或发布：读取即明确报错，管线按终止处理不重试", async () => {
    const articleId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,
                              cursor_json,poll_policy_json,verification_state,created_at,updated_at)
         VALUES ('miyoushe-news','genshin','cn','miyoushe-painter-news','[]','[]','{}','{}',
                 'maintenance-required-list-only',?,?) ON CONFLICT(source_id) DO NOTHING`,
      ).bind(T0, T0),
      env.DB.prepare(
        `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at,
                               last_checked_at, created_at, updated_at)
         VALUES (?, 'miyoushe-news', 'retired-post', 'https://bbs-api.miyoushe.com/', ?, ?, ?, ?)`,
      ).bind(articleId, T0, T0, T0, T0),
      env.DB.prepare(
        `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json,
                                      media_refs_json, completeness, official_published_at, fetched_at, created_at)
         VALUES (?, ?, 1, ?, ?, '[]', 'gap-channel-unavailable', ?, ?, ?)`,
      ).bind(
        versionId,
        articleId,
        crypto.randomUUID(),
        JSON.stringify([{ kind: "title", text: "历史帖子" }]),
        T0,
        T0,
        T0,
      ),
    ]);
    const error = await loadStoredArticleVersion(env.DB, versionId).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("来源已下线");
    expect(classifyPipelineFailure(error)).toEqual({ terminal: true, reason: "invalid_data" });
  });
});
