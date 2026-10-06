// A-P3-DRAFT · PipelineDO 草稿待办：watchdog 补排、alarm 串行处理、开关与绑定缺失（本地 D1；固定响应替身）。
import "../../admin/test-support";
import { env } from "cloudflare:test";
import { MATCH_PAGE, utcDayPeriod } from "@hoyo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import zzzContent from "../../../../../fixtures/sources/zzz-ann/content-1301.json";
import { DRAFT_PROFILE_REF, readDraft } from "../../extraction/model/store";
import {
  DRAFT_T0,
  type FixtureBody,
  fakeAi,
  fixtureEntry,
  GACHA_21876_OUTPUT,
  modelResponse,
  seedRuleCandidate,
} from "../../extraction/model/test-support";
import type { PipelineControls } from "./controls";
import { DRAFT_JOB, PipelineRuntime, PUBLICATION_JOB } from "./runtime";

const gachaEntry = fixtureEntry(genshinContent as unknown as FixtureBody, 21876);
let now = DRAFT_T0;
let controls: PipelineControls;

function runtime(extra: Partial<ConstructorParameters<typeof PipelineRuntime>[0]> = {}) {
  return new PipelineRuntime({
    db: env.DB,
    readControls: async () => controls,
    now: () => now,
    ...extra,
  });
}
async function draftJobs() {
  return (
    await env.DB.prepare(
      "SELECT id, status, due_at, last_error FROM jobs WHERE kind = ? ORDER BY id",
    )
      .bind(DRAFT_JOB)
      .all<{ id: string; status: string; due_at: number; last_error: string | null }>()
  ).results;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM ai_drafts"),
    env.DB.prepare(
      "UPDATE candidates SET review_status = 'rejected', reviewer = 'test', decided_at = 1",
    ),
  ]);
  now += 86_400_000;
  controls = { sources: {}, automaticPublication: false, model: true, reviewSkip: false };
});

describe("A-P3-DRAFT 管线草稿待办", () => {
  it("开关关闭或未配置 AI 绑定时 watchdog 不排草稿；打开后只排规则入队的 uncertain 候选", async () => {
    const { candidateId } = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    controls = { ...controls, model: false };
    await runtime({ ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)) }).watchdog();
    expect(await draftJobs()).toEqual([]);
    controls = { ...controls, model: true };
    await runtime().watchdog();
    expect(await draftJobs()).toEqual([]);
    await runtime({ ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)) }).watchdog();
    expect(await draftJobs()).toEqual([
      { id: `pipeline:draft:${candidateId}`, status: "pending", due_at: now, last_error: null },
    ]);
  });

  it("每个周期最多补排 MATCH_PAGE 个，新公告优先", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= MATCH_PAGE; i++)
      ids.push(
        (await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now + i })).candidateId,
      );
    await runtime({ ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)) }).watchdog();
    const queued = (await draftJobs()).map((row) => row.id.slice("pipeline:draft:".length));
    expect(queued).toHaveLength(MATCH_PAGE);
    expect(queued).not.toContain(ids[0]);
  });

  it("alarm 处理草稿待办后完成；已起草的候选不再补排；关着开关完成的待办在打开后复活", async () => {
    const { candidateId } = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    await runtime({ ai }).watchdog();
    controls = { ...controls, model: false };
    await runtime({ ai }).tick();
    expect(await draftJobs()).toMatchObject([{ status: "done", last_error: "model_disabled" }]);
    expect(ai.calls).toHaveLength(0);
    controls = { ...controls, model: true };
    now += 1;
    await runtime({ ai }).watchdog();
    expect(await draftJobs()).toMatchObject([{ status: "pending", last_error: null }]);
    await runtime({ ai }).tick();
    expect(ai.calls).toHaveLength(1);
    expect(await draftJobs()).toMatchObject([{ status: "done", last_error: null }]);
    expect((await readDraft(env.DB, candidateId))?.status).toBe("ready");
    now += 1;
    await runtime({ ai }).watchdog();
    expect(await draftJobs()).toMatchObject([{ status: "done" }]);
  });

  it("同一时刻到期时先处理来源与发布待办，草稿排在后面", async () => {
    await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    await runtime({ ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)) }).watchdog();
    await env.DB.prepare(
      `INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at)
       VALUES ('pipeline:publication:x', ?, '{"versionId":"missing","backfill":false}', ?, 'pending', ?, ?)`,
    )
      .bind(PUBLICATION_JOB, now, now, now)
      .run();
    const seen: string[] = [];
    await runtime({
      ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)),
      draft: async (input) => {
        seen.push(input.candidateId);
        return { kind: "done", reason: null };
      },
    }).tick();
    expect(seen).toEqual([]);
    const publication = await env.DB.prepare(
      "SELECT attempts FROM jobs WHERE id = 'pipeline:publication:x'",
    ).first<{ attempts: number }>();
    expect(publication?.attempts).toBe(1);
  });

  it("预算用尽的草稿待办停到下一个 UTC 日，alarm 按到期时间排", async () => {
    await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    await runtime({ ai }).watchdog();
    const nextDay = utcDayPeriod(now).endMsExclusive;
    await runtime({
      ai,
      draft: async () => ({ kind: "later", reason: "ai_budget_exhausted", dueAt: nextDay }),
    }).tick();
    expect(await draftJobs()).toMatchObject([
      { status: "pending", due_at: nextDay, last_error: "ai_budget_exhausted" },
    ]);
    expect(await runtime({ ai }).nextAlarm()).toBe(nextDay);
  });

  it("ADR-0010 旧 profile 的确定草稿会被补排重新起草，当前 profile 的不会", async () => {
    const old = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const fresh = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now + 1 });
    const insert = (candidateId: string, versionId: string, profile: string) =>
      env.DB.prepare(
        `INSERT INTO ai_drafts (candidate_id, article_version_id, profile_ref, status, attempts, proposal_json,
                                notes_json, reason_code, usage_json, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', 1, NULL, '[]', NULL, NULL, ?, ?)`,
      )
        .bind(candidateId, versionId, profile, now, now)
        .run();
    await insert(
      old.candidateId,
      old.versionId,
      "@cf/qwen/qwen3-30b-a3b-fp8/draft-prompt-v1/candidate-schema-v1",
    );
    await insert(fresh.candidateId, fresh.versionId, DRAFT_PROFILE_REF);
    await runtime({ ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)) }).watchdog();
    expect((await draftJobs()).map((row) => row.id)).toEqual([`pipeline:draft:${old.candidateId}`]);
  });

  it("A-P3-REVIEW-SKIP 跳过审核开启时新草稿由系统批准，停放的发布待办随后发布；关闭时草稿留在队列", async () => {
    const zzzEntry = fixtureEntry(zzzContent as unknown as FixtureBody, 1301);
    const output = JSON.stringify({
      classification: "events",
      ambiguities: [],
      events: [
        {
          event_type: "limited_event",
          status: "scheduled",
          title: "「虚境逐影争锋」活动",
          type_quote: { block: 0, quote: "「虚境逐影争锋」活动说明" },
          status_quote: null,
          milestones: [
            {
              node_type: "start",
              label: "",
              block: 2,
              time_text: "2026/09/16 10:00",
              estimated: false,
            },
            {
              node_type: "end",
              label: "",
              block: 2,
              time_text: "2026/10/05 03:59",
              estimated: false,
            },
          ],
        },
      ],
    });
    /** 规则入队的候选与它停放着等人工的发布待办（与来源待办入库后的状态一致）。 */
    const parked = async () => {
      const seeded = await seedRuleCandidate("zzz-ann", zzzEntry, { nowMs: now });
      const row = await env.DB.prepare("SELECT updated_at FROM candidates WHERE id = ?")
        .bind(seeded.candidateId)
        .first<{ updated_at: number }>();
      await env.DB.prepare(
        `INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at)
         VALUES (?, ?, ?, ?, 'awaiting_review', ?, ?)`,
      )
        .bind(
          `pipeline:publication:${seeded.versionId}`,
          PUBLICATION_JOB,
          JSON.stringify({ versionId: seeded.versionId, backfill: false, seenAt: row?.updated_at }),
          now,
          now,
          now,
        )
        .run();
      return seeded;
    };
    const status = (id: string) =>
      env.DB.prepare(
        `SELECT c.review_status, er.extractor FROM candidates c
           LEFT JOIN extraction_runs er ON er.id = c.run_id WHERE c.id = ?`,
      )
        .bind(id)
        .first<{ review_status: string; extractor: string | null }>();

    const off = await parked();
    now += 1;
    await runtime({ ai: fakeAi(modelResponse(output)) }).watchdog();
    await runtime({ ai: fakeAi(modelResponse(output)) }).tick();
    expect((await readDraft(env.DB, off.candidateId))?.status).toBe("ready");
    expect(await status(off.candidateId)).toEqual({ review_status: "pending", extractor: "rule" });

    controls = { ...controls, reviewSkip: true };
    const on = await parked();
    now += 1;
    await runtime({ ai: fakeAi(modelResponse(output)) }).watchdog();
    await runtime({ ai: fakeAi(modelResponse(output)) }).tick();
    expect(await status(on.candidateId)).toEqual({ review_status: "approved", extractor: "model" });
    // 开关只作用于新写好的草稿：先前留在队列里的那条不受影响。
    expect(await status(off.candidateId)).toEqual({ review_status: "pending", extractor: "rule" });

    now += 1;
    await runtime().watchdog();
    await runtime().tick();
    expect(
      await env.DB.prepare("SELECT status, last_error FROM jobs WHERE id = ?")
        .bind(`pipeline:publication:${on.versionId}`)
        .first(),
    ).toEqual({ status: "done", last_error: "published" });
    expect(
      await env.DB.prepare(
        `SELECT e.human_locked, e.title FROM events e JOIN evidence ev ON ev.event_id = e.id
          WHERE ev.article_version_id = ? LIMIT 1`,
      )
        .bind(on.versionId)
        .first(),
    ).toEqual({ human_locked: 0, title: "「虚境逐影争锋」活动" });
  });
});
