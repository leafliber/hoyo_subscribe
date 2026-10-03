// A-P3-PUBLISH · 合成官方材料，本地 D1 真事务；无网络/真实发信。
// P4-01 获准跨卡改动：仅验证同一发布事务追加通知 outbox 的用例。

import { env } from "cloudflare:test";
import { API_BODY_MAX_BYTES, NOTIFICATION_PUBLICATION_TOPIC } from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { eventIdentity, milestoneIdentity } from "../extraction/identity";
import { parseAnnouncementExactTime } from "../extraction/time";
import { getSourceEntry } from "../sources/registry";
import { splitSqlStatements } from "../storage/split-sql";
import {
  associateApprovedCandidate,
  publishApprovedCandidate,
  publishManualCorrection,
  retractWithApprovedCandidate,
} from "./publish";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}
const migrations = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T0 = 1_800_000_000_000;
const BODY = "限时活动，2026/10/01 12:00 开始；2026/10/03 12:00 结束。官方取消说明。";

async function one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}
async function externalIdOf(articleId: string): Promise<string> {
  const row = await one<{ external_id: string }>(
    "SELECT external_id FROM articles WHERE id = ?",
    articleId,
  );
  if (row === null) throw new Error("测试文章不存在");
  return row.external_id;
}
async function count(table: string, where = "1=1", ...params: unknown[]): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    ...params,
  );
  return row?.n ?? 0;
}

async function publicationState() {
  return Promise.all(
    [
      "events",
      "milestones",
      "evidence",
      "event_revisions",
      "calendar_projections",
      "outbox",
      "system_state",
    ].map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
    ),
  );
}

let next = 0;
function id(prefix: string): string {
  return `${prefix}_${++next}`;
}

async function seedSource(): Promise<void> {
  const entry = getSourceEntry("genshin-ann");
  await env.DB.prepare(
    `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json,
      verified_publishers_json, cursor_json, poll_policy_json, verification_state,
      last_success_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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

async function seedArticle(
  externalId: string,
  versionNo = 1,
  articleId?: string,
  completeness = "complete",
  body = BODY,
) {
  const aid = articleId ?? id("article");
  if (articleId === undefined)
    await env.DB.prepare(
      `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at,
      last_checked_at, created_at, updated_at) VALUES (?, 'genshin-ann', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(aid, externalId, `https://example.invalid/${externalId}`, T0, T0, T0, T0)
      .run();
  const vid = id("version");
  await env.DB.prepare(
    `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json,
      media_refs_json, completeness, official_published_at, fetched_at, created_at)
      VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  )
    .bind(
      vid,
      aid,
      versionNo,
      id("hash"),
      JSON.stringify([{ kind: "text", text: body }]),
      completeness,
      T0,
      T0,
      T0,
    )
    .run();
  return { articleId: aid, versionId: vid };
}

function proposal(
  options: {
    title?: string;
    time?: string;
    date?: string;
    status?: "scheduled" | "cancelled" | "retracted";
    classification?: string;
  } = {},
) {
  if (options.classification === "uncertain")
    return { classification: "uncertain", events: [], ambiguities: ["合成缺口"] };
  const raw = options.time ?? "2026/10/01 12:00";
  const time =
    options.date === undefined
      ? parseAnnouncementExactTime(raw)
      : {
          precision: "date",
          date: options.date,
          source_timezone: "UTC+08:00",
          raw_expression: options.date.replaceAll("-", "/"),
          time_basis: "official_explicit",
        };
  if (time === null) throw new Error("测试时间无效");
  return {
    classification: "events",
    ambiguities: [],
    events: [
      {
        event_key: "moon_trial",
        event_type: "limited_event",
        status: options.status ?? "scheduled",
        title: options.title ?? "月影试炼",
        summary: null,
        type_evidence: { block_ref: "blocks/0", quote: "限时活动", tag: null },
        status_evidence:
          options.status === "cancelled"
            ? { block_ref: "blocks/0", quote: "官方取消说明", tag: null }
            : null,
        change_relation: null,
        milestones: [
          {
            milestone_key: "start",
            node_type: "start",
            title: "开始",
            time,
            time_evidence: {
              block_ref: "blocks/0",
              quote: options.date === undefined ? raw : options.date.replaceAll("-", "/"),
              tag: null,
            },
          },
        ],
      },
    ],
  };
}

async function seedCandidate(
  versionId: string,
  data: unknown = proposal(),
  manual = false,
  status = "approved",
) {
  const candidateId = id("candidate");
  const runId = manual ? null : id("run");
  if (runId !== null)
    await env.DB.prepare(
      `INSERT INTO extraction_runs (id, article_version_id, extractor, profile_ref, status,
      usage_json, error, created_at, completed_at) VALUES (?, ?, 'rule', ?, 'succeeded', NULL, NULL, ?, ?)`,
    )
      .bind(runId, versionId, id("profile"), T0, T0)
      .run();
  await env.DB.prepare(
    `INSERT INTO candidates (id, run_id, event_id, proposal_json, review_status, reviewer,
      decided_at, decision_reason, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(candidateId, runId, JSON.stringify(data), status, T0, T0)
    .run();
  await env.DB.prepare(
    `INSERT INTO evidence (id, candidate_id, article_version_id, block_ref, created_at)
      VALUES (?, ?, ?, 'blocks/0', ?)`,
  )
    .bind(id("evidence"), candidateId, versionId, T0)
    .run();
  return candidateId;
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) {
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  }
  await seedSource();
});

describe("A-P3-PUBLISH 原子发布、身份与版本", () => {
  it("同一次发布条件提交生成逐事件修订通知信号；未提交不留信号", async () => {
    const article = await seedArticle(id("external"));
    const candidate = await seedCandidate(article.versionId);
    expect((await publishApprovedCandidate(env.DB, candidate, T0)).outcome).toBe("published");
    const eventId = await eventIdentity(
      "genshin-ann",
      await externalIdOf(article.articleId),
      "moon_trial",
    );
    const signal = await one<{ topic: string; payload_json: string }>(
      "SELECT topic,payload_json FROM outbox WHERE dedupe_key = ?",
      `notification:${eventId}:1`,
    );
    expect(signal?.topic).toBe(NOTIFICATION_PUBLICATION_TOPIC);
    expect(JSON.parse(signal?.payload_json ?? "null")).toMatchObject({
      event_id: eventId,
      event_revision: 1,
      schedule_revision: 1,
      change_kind: "created",
    });
    expect(await publishApprovedCandidate(env.DB, candidate, T0 + 1)).toEqual({
      outcome: "unchanged",
    });
    expect(await count("outbox", "dedupe_key = ?", `notification:${eventId}:1`)).toBe(1);
  });

  it.each([
    { eventCount: 12, nodeCount: 1 },
    { eventCount: 4, nodeCount: 4 },
  ])("$eventCount 个事件各 $nodeCount 个节点的更新重发", async ({ eventCount, nodeCount }) => {
    const external = id("external");
    const first = await seedArticle(external);
    const data = proposal();
    const event = data.events[0];
    const node = event?.milestones[0];
    if (event === undefined || node === undefined) throw new Error("测试事件缺失");
    data.events = Array.from({ length: eventCount }, (_, eventIndex) => ({
      ...event,
      event_key: `event${eventIndex}`,
      milestones: Array.from({ length: nodeCount }, (_, nodeIndex) => ({
        ...node,
        milestone_key: `node${nodeIndex}`,
      })),
    }));
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThanOrEqual(
      API_BODY_MAX_BYTES,
    );
    const initial = await publishApprovedCandidate(
      env.DB,
      await seedCandidate(first.versionId, data),
      T0,
    );
    expect(initial.outcome).toBe("published");
    const second = await seedArticle(external, 2, first.articleId);
    data.events = data.events.map((item) => ({ ...item, title: "更正标题" }));
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThanOrEqual(
      API_BODY_MAX_BYTES,
    );
    const candidate = await seedCandidate(second.versionId, data);
    const guardBindings: number[] = [];
    const batchSizes: number[] = [];
    const db = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith("UPDATE candidates SET updated_at = updated_at")) return statement;
        return {
          bind: (...values: unknown[]) => {
            guardBindings.push(values.length);
            return statement.bind(...values);
          },
        } as D1PreparedStatement;
      },
      batch: (statements: D1PreparedStatement[]) => {
        batchSizes.push(statements.length);
        return env.DB.batch(statements);
      },
    } as D1Database;
    expect(await publishApprovedCandidate(db, candidate, T0 + 1)).toEqual(initial);
    // 结构断言：两个形状都只有 11 个守卫参数；不是新增平台可调阈值。
    expect(guardBindings).toEqual([11]);
    // P5-01：同一 batch 额外读取一次守卫直接 changes()，不增加业务写入。
    expect(batchSizes).toEqual([4 + eventCount * (4 + nodeCount * 3)]);
    for (const item of data.events) {
      const eventId = await eventIdentity("genshin-ann", external, item.event_key);
      expect(
        await one(
          "SELECT title, event_revision, schedule_revision FROM events WHERE id = ?",
          eventId,
        ),
      ).toEqual({ title: "更正标题", event_revision: 2, schedule_revision: 1 });
      expect(await count("event_revisions", "event_id = ?", eventId)).toBe(2);
      expect(await count("milestones", "event_id = ? AND public_ical_revision = 2", eventId)).toBe(
        nodeCount,
      );
      expect(
        await count("calendar_projections", "event_id = ? AND public_ical_revision = 2", eventId),
      ).toBe(nodeCount);
      expect(await count("evidence", "candidate_id = ? AND event_id = ?", candidate, eventId)).toBe(
        nodeCount + 1,
      );
    }
    expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(1);
    expect(
      await one("SELECT updated_at FROM system_state WHERE key = 'public_snapshot_pending'"),
    ).toEqual({ updated_at: T0 + 1 });
  });

  it.each([
    "event_revision",
    "event_lock",
    "node_revision",
    "node_lock",
    "projection_revision",
    "missing_projection",
    "article_link",
    "new_event_exists",
    "new_node_exists",
  ])("JSON 守卫在提交前发生 %s 时整批未命中", async (race) => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(env.DB, await seedCandidate(first.versionId), T0);
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    const nodeId = await milestoneIdentity(eventId, "start");
    const second = await seedArticle(external, 2, first.articleId);
    const data = proposal({ title: "更正标题" });
    const event = data.events[0];
    const node = event?.milestones[0];
    if (event === undefined || node === undefined) throw new Error("测试事件缺失");
    event.milestones.push({ ...node, milestone_key: "extra" });
    data.events = [...data.events, { ...event, event_key: "extra_event" }];
    const candidate = await seedCandidate(second.versionId, data);
    let before: Awaited<ReturnType<typeof publicationState>> | undefined;
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const mutations: Record<string, { sql: string; params: unknown[] }> = {
          event_revision: {
            sql: "UPDATE events SET event_revision = event_revision + 1 WHERE id = ?",
            params: [eventId],
          },
          event_lock: { sql: "UPDATE events SET human_locked = 1 WHERE id = ?", params: [eventId] },
          node_revision: {
            sql: "UPDATE milestones SET public_ical_revision = public_ical_revision + 1 WHERE id = ?",
            params: [nodeId],
          },
          node_lock: {
            sql: "UPDATE milestones SET human_locked = 1 WHERE id = ?",
            params: [nodeId],
          },
          projection_revision: {
            sql: "UPDATE calendar_projections SET public_ical_revision = public_ical_revision + 1 WHERE milestone_id = ?",
            params: [nodeId],
          },
          missing_projection: {
            sql: "DELETE FROM calendar_projections WHERE milestone_id = ?",
            params: [nodeId],
          },
          article_link: {
            sql: `INSERT INTO evidence (id, event_id, article_version_id, block_ref, created_at)
              VALUES (?, ?, ?, 'blocks/0', ?)`,
            params: [id("race_evidence"), eventId, second.versionId, T0],
          },
          new_event_exists: {
            sql: `INSERT INTO events (id, game, region, event_type, status, title, created_at, updated_at)
              SELECT ?, game, region, event_type, status, title, created_at, updated_at FROM events WHERE id = ?`,
            params: [await eventIdentity("genshin-ann", external, "extra_event"), eventId],
          },
          new_node_exists: {
            sql: `INSERT INTO milestones (id, event_id, milestone_key, node_type, title, source_timezone,
              raw_expression, time_basis, time_precision, created_at, updated_at)
              VALUES (?, ?, 'extra', 'start', '合成并发节点', 'UTC+08:00', '待定', 'unresolved', 'unknown', ?, ?)`,
            params: [await milestoneIdentity(eventId, "extra"), eventId, T0, T0],
          },
        };
        const mutation = mutations[race];
        if (mutation === undefined) throw new Error("未知并发场景");
        await env.DB.prepare(mutation.sql)
          .bind(...mutation.params)
          .run();
        before = await publicationState();
        return env.DB.batch(statements);
      },
    } as D1Database;
    expect(await publishApprovedCandidate(db, candidate, T0 + 1)).toEqual({
      outcome: "condition_missed",
    });
    expect(before).toBeDefined();
    expect(await publicationState()).toEqual(before);
  });

  it("同一候选发布两次：第二次零事件写入、零修订、零 outbox", async () => {
    const article = await seedArticle(id("external"));
    const candidate = await seedCandidate(article.versionId);
    expect((await publishApprovedCandidate(env.DB, candidate, T0)).outcome).toBe("published");
    const eventId = await eventIdentity(
      "genshin-ann",
      await externalIdOf(article.articleId),
      "moon_trial",
    );
    const before = await one<{ event_revision: number }>(
      "SELECT event_revision FROM events WHERE id = ?",
      eventId,
    );
    const revisions = await count("event_revisions", "event_id = ?", eventId);
    const outbox = await count("outbox", "dedupe_key = ?", `publish:${candidate}`);
    expect(await publishApprovedCandidate(env.DB, candidate, T0 + 1)).toEqual({
      outcome: "unchanged",
    });
    expect(await one("SELECT event_revision FROM events WHERE id = ?", eventId)).toEqual(before);
    expect(await count("event_revisions", "event_id = ?", eventId)).toBe(revisions);
    expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(outbox);
    expect(outbox).toBe(1);
    expect(
      await one<{ value_json: string }>(
        "SELECT value_json FROM system_state WHERE key = 'public_snapshot_pending'",
      ),
    ).toEqual({ value_json: JSON.stringify({ pending: true }) });
  });

  it("旧 ArticleVersion 候选晚到只留候选历史，不覆盖新状态", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    const oldCandidate = await seedCandidate(first.versionId, proposal({ title: "旧标题" }));
    const newer = await seedArticle(external, 2, first.articleId);
    const newCandidate = await seedCandidate(newer.versionId, proposal({ title: "新标题" }));
    expect((await publishApprovedCandidate(env.DB, newCandidate, T0)).outcome).toBe("published");
    const before = await one<{ title: string; event_revision: number; schedule_revision: number }>(
      "SELECT title, event_revision, schedule_revision FROM events WHERE id = ?",
      await eventIdentity("genshin-ann", external, "moon_trial"),
    );
    expect(await publishApprovedCandidate(env.DB, oldCandidate, T0 + 1)).toEqual({
      outcome: "stale",
    });
    expect(
      await one(
        "SELECT title, event_revision, schedule_revision FROM events WHERE id = ?",
        await eventIdentity("genshin-ann", external, "moon_trial"),
      ),
    ).toEqual(before);
    expect(
      await count(
        "event_revisions",
        "event_id = ?",
        await eventIdentity("genshin-ann", external, "moon_trial"),
      ),
    ).toBe(1);
    expect(await count("evidence", "candidate_id = ? AND event_id IS NULL", oldCandidate)).toBe(1);
    expect(await count("outbox", "dedupe_key = ?", `publish:${oldCandidate}`)).toBe(0);
  });

  it("同一文章的另一抽取版本即使标题有歧义也不覆盖已关联业务事件", async () => {
    const external = id("external");
    const article = await seedArticle(external);
    await publishApprovedCandidate(env.DB, await seedCandidate(article.versionId), T0);
    const candidate = await seedCandidate(article.versionId, proposal({ title: "另一抽取结果" }));
    expect(await publishApprovedCandidate(env.DB, candidate, T0 + 1)).toEqual({
      outcome: "unchanged",
    });
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    expect(await count("event_revisions", "event_id = ?", eventId)).toBe(1);
    expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(0);
    expect(await count("outbox", "dedupe_key = ?", `notification:${eventId}:1`)).toBe(1);
    expect(await count("evidence", "candidate_id = ? AND event_id IS NULL", candidate)).toBe(1);
  });

  it("只改标题增事件修订和节点 ICS，改时刻再增计划版本且 Milestone ID 不变", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(env.DB, await seedCandidate(first.versionId), T0);
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    const milestoneId = await milestoneIdentity(eventId, "start");
    const second = await seedArticle(external, 2, first.articleId);
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(second.versionId, proposal({ title: "新标题" })),
      T0 + 1,
    );
    expect(
      await one("SELECT event_revision, schedule_revision FROM events WHERE id = ?", eventId),
    ).toEqual({ event_revision: 2, schedule_revision: 1 });
    expect(
      await one("SELECT public_ical_revision FROM milestones WHERE id = ?", milestoneId),
    ).toEqual({ public_ical_revision: 2 });
    const third = await seedArticle(external, 3, first.articleId);
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(third.versionId, proposal({ title: "新标题", time: "2026/10/03 12:00" })),
      T0 + 2,
    );
    expect(
      await one("SELECT event_revision, schedule_revision FROM events WHERE id = ?", eventId),
    ).toEqual({ event_revision: 3, schedule_revision: 2 });
    expect(
      await one("SELECT public_ical_revision FROM milestones WHERE id = ?", milestoneId),
    ).toEqual({ public_ical_revision: 3 });
    expect(await count("milestones", "event_id = ?", eventId)).toBe(1);
    expect(
      await one(
        "SELECT public_ical_revision FROM calendar_projections WHERE milestone_id = ?",
        milestoneId,
      ),
    ).toEqual({ public_ical_revision: 3 });
  });

  it("人锁使规则路径跳过并留历史；带理由人工操作可以改且理由写入修订", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(first.versionId, proposal(), true),
      T0,
    );
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    const second = await seedArticle(external, 2, first.articleId);
    const rule = await seedCandidate(second.versionId, proposal({ title: "规则标题" }));
    expect(await publishApprovedCandidate(env.DB, rule, T0 + 1)).toEqual({ outcome: "locked" });
    expect(await count("evidence", "candidate_id = ? AND event_id IS NULL", rule)).toBe(1);
    const manual = await seedCandidate(second.versionId, proposal({ title: "人工标题" }), true);
    expect(
      (await publishManualCorrection(env.DB, manual, "官方正文人工核对", T0 + 2)).outcome,
    ).toBe("published");
    expect(await one("SELECT title, human_locked FROM events WHERE id = ?", eventId)).toEqual({
      title: "人工标题",
      human_locked: 1,
    });
    expect(
      await one(
        "SELECT reason FROM event_revisions WHERE event_id = ? AND revision_no = 2",
        eventId,
      ),
    ).toEqual({ reason: "官方正文人工核对" });
  });

  it("两篇近似标题不自动合并，只有带理由的显式关联才合并", async () => {
    const a = id("external");
    const b = id("external");
    const first = await seedArticle(a);
    await publishApprovedCandidate(env.DB, await seedCandidate(first.versionId), T0);
    const second = await seedArticle(b);
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(second.versionId, proposal({ title: "月影试炼！" })),
      T0 + 1,
    );
    const firstId = await eventIdentity("genshin-ann", a, "moon_trial");
    const secondId = await eventIdentity("genshin-ann", b, "moon_trial");
    expect(firstId).not.toBe(secondId);
    expect(await count("events", "id IN (?, ?)", firstId, secondId)).toBe(2);
    const thirdExternal = id("external");
    const third = await seedArticle(thirdExternal);
    const candidate = await seedCandidate(
      third.versionId,
      proposal({ title: "月影试炼 合并公告" }),
      true,
    );
    expect(
      (await associateApprovedCandidate(env.DB, candidate, firstId, "人工核对官方更正公告", T0 + 2))
        .outcome,
    ).toBe("published");
    expect(await count("events", "id IN (?, ?)", firstId, secondId)).toBe(2);
    expect(
      await count(
        "events",
        "id = ?",
        await eventIdentity("genshin-ann", thirdExternal, "moon_trial"),
      ),
    ).toBe(0);
    expect(
      await count("evidence", "candidate_id = ? AND event_id = ?", candidate, firstId),
    ).toBeGreaterThan(0);
    expect(
      await one(
        "SELECT change_kind, reason FROM event_revisions WHERE event_id = ? AND revision_no = 2",
        firstId,
      ),
    ).toEqual({ change_kind: "associated", reason: "人工核对官方更正公告" });
  });

  it("uncertain、缺口、未批准候选拒绝发布且零写入", async () => {
    for (const kind of ["uncertain", "gap", "pending"]) {
      const article = await seedArticle(
        id("external"),
        1,
        undefined,
        kind === "gap" ? "gap-body-truncated" : "complete",
      );
      const candidate = await seedCandidate(
        article.versionId,
        kind === "uncertain" ? proposal({ classification: "uncertain" }) : proposal(),
        false,
        kind === "pending" ? "pending" : "approved",
      );
      await expect(publishApprovedCandidate(env.DB, candidate, T0)).rejects.toThrow();
      expect(
        await count(
          "events",
          "id = ?",
          await eventIdentity("genshin-ann", await externalIdOf(article.articleId), "moon_trial"),
        ),
      ).toBe(0);
      expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(0);
    }
  });

  it("条件未命中与数据库错误分别处理；依赖投影失败整批回滚", async () => {
    const article = await seedArticle(id("external"));
    const candidate = await seedCandidate(article.versionId);
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE candidates SET review_status = 'pending' WHERE id = ?")
          .bind(candidate)
          .run();
        return env.DB.batch(statements);
      },
    } as D1Database;
    expect(await publishApprovedCandidate(db, candidate, T0)).toEqual({
      outcome: "condition_missed",
    });
    expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(0);
    const external = await externalIdOf(article.articleId);
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    expect(await count("outbox", "dedupe_key = ?", `notification:${eventId}:1`)).toBe(0);
    expect(await count("events", "id = ?", eventId)).toBe(0);
    await env.DB.prepare("UPDATE candidates SET review_status = 'approved' WHERE id = ?")
      .bind(candidate)
      .run();
    await env.DB.exec(
      "CREATE TRIGGER fail_p3_projection BEFORE INSERT ON calendar_projections BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END;",
    );
    try {
      await expect(publishApprovedCandidate(env.DB, candidate, T0)).rejects.toThrow(
        /synthetic projection failure/,
      );
    } finally {
      await env.DB.exec("DROP TRIGGER fail_p3_projection;");
    }
    expect(await count("events", "id = ?", eventId)).toBe(0);
    expect(await count("milestones", "event_id = ?", eventId)).toBe(0);
    expect(await count("evidence", "candidate_id = ? AND event_id IS NOT NULL", candidate)).toBe(0);
    expect(await count("event_revisions", "event_id = ?", eventId)).toBe(0);
    expect(await count("outbox", "dedupe_key = ?", `publish:${candidate}`)).toBe(0);
    expect(await count("outbox", "dedupe_key = ?", `notification:${eventId}:1`)).toBe(0);
  });

  it("纯日期发布与改期不造午夜，也不更换 Milestone 身份", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(first.versionId, proposal({ date: "2026-10-01" })),
      T0,
    );
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    const nodeId = await milestoneIdentity(eventId, "start");
    expect(
      await one(
        "SELECT time_precision, time_exact_ms, time_date FROM milestones WHERE id = ?",
        nodeId,
      ),
    ).toEqual({ time_precision: "date", time_exact_ms: null, time_date: "2026-10-01" });
    const second = await seedArticle(
      external,
      2,
      first.articleId,
      "complete",
      BODY.replace("2026/10/01", "2026/10/02"),
    );
    await publishApprovedCandidate(
      env.DB,
      await seedCandidate(second.versionId, proposal({ date: "2026-10-02" })),
      T0 + 1,
    );
    expect(
      await one(
        "SELECT time_precision, time_exact_ms, time_date FROM milestones WHERE id = ?",
        nodeId,
      ),
    ).toEqual({ time_precision: "date", time_exact_ms: null, time_date: "2026-10-02" });
    expect(await count("milestones", "event_id = ?", eventId)).toBe(1);
  });

  it("官方取消必须有原文引文，合法取消推进提醒与公共节点版本", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(env.DB, await seedCandidate(first.versionId), T0);
    const second = await seedArticle(external, 2, first.articleId);
    const invalid = proposal({ status: "cancelled" });
    (invalid.events[0] as { status_evidence: unknown }).status_evidence = null;
    const invalidCandidate = await seedCandidate(second.versionId, invalid);
    await expect(publishApprovedCandidate(env.DB, invalidCandidate, T0 + 1)).rejects.toThrow();
    const valid = await seedCandidate(second.versionId, proposal({ status: "cancelled" }));
    expect((await publishApprovedCandidate(env.DB, valid, T0 + 2)).outcome).toBe("published");
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    const nodeId = await milestoneIdentity(eventId, "start");
    expect(await one("SELECT status, schedule_revision FROM events WHERE id = ?", eventId)).toEqual(
      { status: "cancelled", schedule_revision: 2 },
    );
    expect(await one("SELECT public_ical_revision FROM milestones WHERE id = ?", nodeId)).toEqual({
      public_ical_revision: 2,
    });
  });

  it("撤回是带理由的人工领域操作，区别于官方取消", async () => {
    const external = id("external");
    const first = await seedArticle(external);
    await publishApprovedCandidate(env.DB, await seedCandidate(first.versionId), T0);
    const second = await seedArticle(external, 2, first.articleId);
    const candidate = await seedCandidate(
      second.versionId,
      proposal({ status: "retracted" }),
      true,
    );
    await expect(publishApprovedCandidate(env.DB, candidate, T0 + 1)).rejects.toThrow(/撤回/);
    await expect(retractWithApprovedCandidate(env.DB, candidate, "", T0 + 1)).rejects.toThrow();
    expect(
      (await retractWithApprovedCandidate(env.DB, candidate, "本站事实纠错", T0 + 1)).outcome,
    ).toBe("published");
    const eventId = await eventIdentity("genshin-ann", external, "moon_trial");
    expect(await one("SELECT status, schedule_revision FROM events WHERE id = ?", eventId)).toEqual(
      { status: "retracted", schedule_revision: 2 },
    );
    expect(
      await one(
        "SELECT change_kind, reason FROM event_revisions WHERE event_id = ? AND revision_no = 2",
        eventId,
      ),
    ).toEqual({ change_kind: "retracted", reason: "本站事实纠错" });
  });
});
