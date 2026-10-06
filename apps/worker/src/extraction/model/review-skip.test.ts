// A-P3-REVIEW-SKIP · 「跳过审核」（P3-25，ADR-0018）：通过全部检查的 AI 草稿由系统批准为模型候选，
// 发布不加人工锁；任何一项检查没过都留给人工（本地 D1；真实公告样本 + 固定模型输出，零推理请求）。
import "../../admin/test-support";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import zzzContent from "../../../../../fixtures/sources/zzz-ann/content-1301.json";
import { extractArticleVersion } from "../../executors/pipeline/extract";
import { publishApprovedCandidate } from "../../publishing/publish";
import { denoiseTitle, splitBodyBlocks } from "../../sources/articles/blocks";
import type { StoredArticleVersion } from "../article";
import { eventIdentity } from "../identity";
import type { CandidateProposal } from "../schema";
import { reviseCandidate } from "../service";
import { buildDraftProposal, parseModelJson } from "./build";
import {
  approveDraftWithoutReview,
  REVIEW_SKIP_REASON,
  REVIEW_SKIP_REVIEWER,
  titleKey,
} from "./review-skip";
import { DRAFT_PROFILE_REF, writeDraft } from "./store";
import {
  DRAFT_T0,
  type FixtureBody,
  fixtureEntry,
  GACHA_21876_OUTPUT,
  seedRuleCandidate,
} from "./test-support";

const zzzEntry = fixtureEntry(zzzContent as unknown as FixtureBody, 1301);
const gachaEntry = fixtureEntry(genshinContent as unknown as FixtureBody, 21876);
let now = DRAFT_T0;
const tick = () => (now += 1_000);

/** 1301「虚境逐影争锋」块 2 的两个完整时刻（与 build.test 同一份真实正文）。 */
function activityOutput(title = "「虚境逐影争锋」活动") {
  return {
    classification: "events",
    ambiguities: [],
    events: [
      {
        event_type: "limited_event",
        status: "scheduled",
        title,
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
  };
}

async function draftFor(
  candidateId: string,
  article: StoredArticleVersion,
  proposal: CandidateProposal,
): Promise<void> {
  await writeDraft(env.DB, {
    candidateId,
    articleVersionId: article.articleVersionId,
    status: "ready",
    proposal,
    notes: [],
    reasonCode: null,
    usage: null,
    called: true,
    nowMs: tick(),
  });
}

async function readyActivity(title?: string) {
  const seeded = await seedRuleCandidate("zzz-ann", zzzEntry, { nowMs: tick() });
  const built = buildDraftProposal(seeded.article, activityOutput(title));
  expect(built.status).toBe("ready");
  await draftFor(seeded.candidateId, seeded.article, built.proposal);
  return { ...seeded, proposal: built.proposal };
}

async function candidate(id: string) {
  return env.DB.prepare(
    `SELECT c.review_status, c.reviewer, c.decision_reason, c.run_id, er.extractor, er.profile_ref
       FROM candidates c LEFT JOIN extraction_runs er ON er.id = c.run_id WHERE c.id = ?`,
  )
    .bind(id)
    .first<{
      review_status: string;
      reviewer: string | null;
      decision_reason: string | null;
      run_id: string | null;
      extractor: string | null;
      profile_ref: string | null;
    }>();
}

/** 同一文章的第 2 版（正文末尾多一段），用来测试已发布事件被人工锁定后的新草稿。 */
async function secondVersion(article: StoredArticleVersion): Promise<string> {
  const versionId = crypto.randomUUID();
  const html = `${zzzEntry.content}<p>补充说明。</p>`;
  const blocks = [{ kind: "title", text: denoiseTitle(zzzEntry.title) }, ...splitBodyBlocks(html)];
  await env.DB.prepare(
    `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json, media_refs_json,
                                   completeness, official_published_at, fetched_at, created_at)
     VALUES (?, ?, 2, ?, ?, ?, 'complete', NULL, ?, ?)`,
  )
    .bind(
      versionId,
      article.articleId,
      versionId,
      JSON.stringify(blocks),
      JSON.stringify(article.mediaRefs),
      tick(),
      now,
    )
    .run();
  return versionId;
}

describe("A-P3-REVIEW-SKIP 跳过审核：系统批准 AI 草稿", () => {
  it("通过全部检查时改为挂在模型抽取运行上的已批准候选，写系统审计；发布待办重抽不另建候选；发布不加人工锁", async () => {
    const { candidateId, versionId, article } = await readyActivity();
    const outcome = await approveDraftWithoutReview(env.DB, candidateId, tick());
    expect(outcome.kind).toBe("approved");
    expect(await candidate(candidateId)).toMatchObject({
      review_status: "approved",
      reviewer: REVIEW_SKIP_REVIEWER,
      decision_reason: REVIEW_SKIP_REASON,
      extractor: "model",
      profile_ref: DRAFT_PROFILE_REF,
    });
    expect(
      await env.DB.prepare(
        "SELECT actor_type, actor_id, action, target_type FROM audit_log WHERE target_id = ? AND action = 'candidate_review_skip'",
      )
        .bind(candidateId)
        .all(),
    ).toMatchObject({
      results: [
        {
          actor_type: "system",
          actor_id: "system",
          action: "candidate_review_skip",
          target_type: "candidate",
        },
      ],
    });

    // 发布待办被唤醒后重抽：取到同一条模型候选（人工 > 模型 > 规则），队列里不多出待审候选。
    const replay = await extractArticleVersion(env.DB, versionId, tick());
    expect(replay.candidate).toMatchObject({
      candidateId,
      path: "model",
      reviewStatus: "approved",
    });
    const pending = await env.DB.prepare(
      `SELECT count(*) AS n FROM candidates c JOIN evidence e ON e.candidate_id = c.id
        WHERE e.article_version_id = ? AND c.review_status = 'pending'`,
    )
      .bind(versionId)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);

    expect((await publishApprovedCandidate(env.DB, candidateId, tick(), false)).outcome).toBe(
      "published",
    );
    const eventId = await eventIdentity(article.sourceId, article.externalId, "primary");
    expect(
      await env.DB.prepare(
        "SELECT e.human_locked, r.actor_path FROM events e JOIN event_revisions r ON r.event_id = e.id WHERE e.id = ?",
      )
        .bind(eventId)
        .first(),
    ).toEqual({ human_locked: 0, actor_path: "model" });
    expect(
      await env.DB.prepare("SELECT max(human_locked) AS locked FROM milestones WHERE event_id = ?")
        .bind(eventId)
        .first(),
    ).toEqual({ locked: 0 });
  });

  it("无日程草稿同样由系统确认；不产生发布", async () => {
    const seeded = await seedRuleCandidate("zzz-ann", zzzEntry, { nowMs: tick() });
    await draftFor(seeded.candidateId, seeded.article, {
      classification: "no_event",
      events: [],
      ambiguities: [],
    });
    expect((await approveDraftWithoutReview(env.DB, seeded.candidateId, tick())).kind).toBe(
      "approved",
    );
    expect(await candidate(seeded.candidateId)).toMatchObject({
      review_status: "approved",
      extractor: "model",
    });
    expect(
      (await publishApprovedCandidate(env.DB, seeded.candidateId, tick(), false)).outcome,
    ).toBe("unchanged");
  });

  it("不确定、有歧义、时间未定、没有可用草稿、人工已接手的都留给人工，候选原样", async () => {
    const uncertain = await seedRuleCandidate("zzz-ann", zzzEntry, { nowMs: tick() });
    await draftFor(uncertain.candidateId, uncertain.article, {
      classification: "uncertain",
      events: [],
      ambiguities: ["看不出起止时间"],
    });
    expect(await approveDraftWithoutReview(env.DB, uncertain.candidateId, tick())).toEqual({
      kind: "held",
      reason: "uncertain",
    });

    const ambiguous = await readyActivity();
    await draftFor(ambiguous.candidateId, ambiguous.article, {
      ...ambiguous.proposal,
      ambiguities: ["图片里可能有第二阶段"],
    });
    expect(await approveDraftWithoutReview(env.DB, ambiguous.candidateId, tick())).toEqual({
      kind: "held",
      reason: "ambiguous",
    });

    // 真实卡池输出的开始是"7.1版本更新后"：版本时间没确认，推不出日期。
    const gacha = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: tick() });
    const built = buildDraftProposal(gacha.article, parseModelJson(GACHA_21876_OUTPUT));
    await draftFor(gacha.candidateId, gacha.article, built.proposal);
    expect(await approveDraftWithoutReview(env.DB, gacha.candidateId, tick())).toEqual({
      kind: "held",
      reason: "unresolved_time",
    });

    const missing = await seedRuleCandidate("zzz-ann", zzzEntry, { nowMs: tick() });
    expect(await approveDraftWithoutReview(env.DB, missing.candidateId, tick())).toEqual({
      kind: "held",
      reason: "draft_not_ready",
    });

    const taken = await readyActivity();
    await reviseCandidate(env.DB, taken.candidateId, taken.proposal, tick());
    expect(await approveDraftWithoutReview(env.DB, taken.candidateId, tick())).toEqual({
      kind: "held",
      reason: "not_pending",
    });

    for (const id of [
      uncertain.candidateId,
      ambiguous.candidateId,
      gacha.candidateId,
      missing.candidateId,
    ])
      expect(await candidate(id)).toMatchObject({ review_status: "pending", extractor: "rule" });
    expect(await candidate(taken.candidateId)).toMatchObject({
      review_status: "pending",
      run_id: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'candidate_review_skip' AND target_id IN (?, ?, ?, ?, ?)",
      )
        .bind(
          uncertain.candidateId,
          ambiguous.candidateId,
          gacha.candidateId,
          missing.candidateId,
          taken.candidateId,
        )
        .first(),
    ).toEqual({ n: 0 });
  });

  it("别篇公告已发布同名、日期交叠的活动时视为疑似重复，留给人工", async () => {
    const first = await readyActivity("「重复检查样例」");
    expect((await approveDraftWithoutReview(env.DB, first.candidateId, tick())).kind).toBe(
      "approved",
    );
    expect((await publishApprovedCandidate(env.DB, first.candidateId, tick(), false)).outcome).toBe(
      "published",
    );
    // 另一篇公告（不同外部 ID）写的是同一个活动，标题带"活动"后缀、括号不同。
    const second = await readyActivity("『重复检查样例』活动");
    expect(await approveDraftWithoutReview(env.DB, second.candidateId, tick())).toEqual({
      kind: "held",
      reason: "possible_duplicate",
    });
    expect(await candidate(second.candidateId)).toMatchObject({ review_status: "pending" });
  });

  it("目标活动已被人工锁定时，新版本的草稿留给人工", async () => {
    const first = await readyActivity("「虚境逐影争锋」活动 · 锁定测试");
    await approveDraftWithoutReview(env.DB, first.candidateId, tick());
    await publishApprovedCandidate(env.DB, first.candidateId, tick(), false);
    const eventId = await eventIdentity(
      first.article.sourceId,
      first.article.externalId,
      "primary",
    );
    await env.DB.prepare("UPDATE events SET human_locked = 1 WHERE id = ?").bind(eventId).run();

    const versionId = await secondVersion(first.article);
    const next = await extractArticleVersion(env.DB, versionId, tick());
    expect(next.candidate.reviewStatus).toBe("pending");
    const article = { ...first.article, articleVersionId: versionId };
    const built = buildDraftProposal(article, activityOutput("「虚境逐影争锋」活动 · 锁定测试"));
    await draftFor(next.candidate.candidateId, article, built.proposal);
    expect(await approveDraftWithoutReview(env.DB, next.candidate.candidateId, tick())).toEqual({
      kind: "held",
      reason: "human_locked",
    });
  });

  it("标题比较键：去掉括号、标点与结尾的「活动」后比较，全角半角一致", () => {
    expect(titleKey("「『弹球勇者』哐哐当！」活动")).toBe(titleKey("「弹球勇者」哐哐当！"));
    expect(titleKey("「锵锵！球仔成长日记」活动")).toBe(titleKey("锵锵!球仔成长日记"));
    expect(titleKey("「爱，幽灵与机器人」")).toBe("爱幽灵与机器人");
    expect(titleKey("「跛脚乌鸦奇探录」活动说明")).toBe("跛脚乌鸦奇探录");
    expect(titleKey("「烬夜安眠」调频活动")).not.toBe(titleKey("「绯月银棺」调频活动"));
    expect(titleKey("「」")).toBe("");
  });
});
