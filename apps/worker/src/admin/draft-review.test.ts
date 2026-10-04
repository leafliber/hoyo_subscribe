// A-P3-DRAFT · 审核 API：队列一次带回标题与草稿状态、详情带可读正文与草稿、采用草稿 + 批准的闭环。
import "./test-support";
import { env } from "cloudflare:test";
import { AI_SOFT_DAY } from "@hoyo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import genshinContent from "../../../../fixtures/sources/genshin-ann/content-21928.json";
import { runDraftJob } from "../extraction/model/draft";
import { DRAFT_PROFILE_REF } from "../extraction/model/store";
import {
  DRAFT_T0,
  type FixtureBody,
  fakeAi,
  fixtureEntry,
  GACHA_21876_OUTPUT,
  MAINTENANCE_21928_OUTPUT,
  modelResponse,
  seedRuleCandidate,
} from "../extraction/model/test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../shell";
import { ADMIN_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext, testKeyring } from "../shell/test-support";
import { generateSecretToken } from "../storage/crypto/random";
import { makeAdminReviewRoutes } from "./review";
import { combinedAuthenticator, issueAdminSession } from "./session";

const genshin = genshinContent as unknown as FixtureBody;
const gachaEntry = fixtureEntry(genshin, 21876);
const maintenanceEntry = fixtureEntry(genshin, 21928);
let now = DRAFT_T0;
let headers: Record<string, string>;
const site = "https://app.test";
const shell = createApiShell({
  authenticator: combinedAuthenticator(
    env.DB,
    () => testKeyring,
    () => now,
  ),
  csrfKey: async () => (await testKeyring).csrf(),
  routes: makeAdminReviewRoutes(() => now),
});
beforeAll(async () => {
  const ring = await testKeyring;
  const session = await issueAdminSession(env.DB, ring, "owner", "synthetic", now);
  const csrf = await mintCsrfToken(ring.csrf(), session.tokenHash, generateSecretToken().bytes);
  headers = {
    origin: site,
    "content-type": "application/json",
    [CSRF_HEADER_NAME]: csrf,
    cookie: `${ADMIN_SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
  };
});
async function call(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  now += 1;
  return shell.fetch(
    new Request(`${site}/api/v2/admin/review/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    fakeExecutionContext,
  );
}
async function drafted(entry = gachaEntry, output = GACHA_21876_OUTPUT) {
  now += 1;
  const seeded = await seedRuleCandidate("genshin-ann", entry, { nowMs: now });
  await runDraftJob({
    db: env.DB,
    ai: fakeAi(modelResponse(output)),
    candidateId: seeded.candidateId,
    modelEnabled: true,
    deadline: now + 120_000,
    now: () => now,
  });
  const detail = (await (await call(`candidates/${seeded.candidateId}`)).json()) as {
    candidate: { id: string; updated_at: number };
  };
  return { ...seeded, updatedAt: detail.candidate.updated_at };
}
/** 默认绑定库里当前这一版草稿（审核员看到的版本）；用例可以传入过期版本。 */
async function adopt(
  candidateId: string,
  expected: number,
  extra: { exclude?: string[]; confirm_ambiguities?: boolean; draftUpdatedAt?: number } = {},
) {
  const draft = await env.DB.prepare("SELECT updated_at FROM ai_drafts WHERE candidate_id = ?")
    .bind(candidateId)
    .first<{ updated_at: number }>();
  const shown = (await (await call(`candidates/${candidateId}`)).json()) as {
    draft: { derivation_key: string } | null;
  };
  return call("adopt-draft", {
    candidate_id: candidateId,
    expected_updated_at: expected,
    expected_draft_updated_at: extra.draftUpdatedAt ?? draft?.updated_at ?? 0,
    expected_derivation_key: shown.draft?.derivation_key ?? "[]",
    reason: "已对照官方原文核对草稿",
    exclude: extra.exclude ?? [],
    confirm_ambiguities: extra.confirm_ambiguities ?? false,
  });
}

describe("A-P3-DRAFT 审核队列与详情", () => {
  it("队列一页带回标题、游戏、来源与草稿状态，并附今日 AI 用量；详情带可读正文、图片数与草稿", async () => {
    const { candidateId } = await drafted();
    const queue = (await (await call("queue")).json()) as {
      candidates: Record<string, unknown>[];
      ai_usage: { cap: number; settled: number };
    };
    expect(queue.candidates.find((row) => row.id === candidateId)).toMatchObject({
      source_id: "genshin-ann",
      game: "genshin",
      title: "「煦风欢舞时」祈愿：「雪宴之锋·薇斯纳(风)」概率UP！",
      draft_status: "ready",
    });
    expect(queue.ai_usage.cap).toBe(AI_SOFT_DAY);
    const detail = (await (await call(`candidates/${candidateId}`)).json()) as {
      readable_blocks: string[];
      media_count: number;
      draft: {
        status: string;
        profile_ref: string;
        proposal: { events: unknown[] };
        notes: string[];
      };
      article: { blocks: unknown[] };
    };
    expect(detail.readable_blocks).toHaveLength(detail.article.blocks.length);
    expect(detail.readable_blocks[4]).toContain("7.1版本更新后 ~ 2026/10/13 17:59");
    expect(detail.media_count).toBeGreaterThanOrEqual(0);
    expect(detail.draft).toMatchObject({ status: "ready", profile_ref: DRAFT_PROFILE_REF });
    // ADR-0011：版本时间未确认时，"7.1版本更新后"保持未定并提示去版本时间表确认。
    expect(detail.draft.notes).toEqual([
      "「7.1版本更新后」：7.1 版本的更新开始时间尚未确认，暂为未定时刻；在「版本时间表」确认后自动推导。",
    ]);
    expect(detail.draft.proposal.events).toHaveLength(1);
  });
});

describe("A-P3-DRAFT 采用草稿", () => {
  it("采用 = 一次带理由与审计的人工修正；随后批准即发布，候选从待审队列消失", async () => {
    const { candidateId, updatedAt } = await drafted();
    const adopted = await adopt(candidateId, updatedAt);
    expect(adopted.status).toBe(200);
    const body = (await adopted.json()) as { review_status: string; updated_at: number };
    expect(body.review_status).toBe("pending");
    const row = await env.DB.prepare("SELECT run_id, proposal_json FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ run_id: string | null; proposal_json: string }>();
    expect(row?.run_id).toBeNull();
    expect(JSON.parse(row?.proposal_json ?? "{}").classification).toBe("events");
    const audit = await env.DB.prepare(
      "SELECT action, reason, detail_ref FROM audit_log WHERE target_id = ? ORDER BY created_at",
    )
      .bind(candidateId)
      .all<{ action: string; reason: string; detail_ref: string }>();
    expect(audit.results).toEqual([
      {
        action: "candidate_adopt_draft",
        reason: "已对照官方原文核对草稿",
        detail_ref: `ai_draft:${DRAFT_PROFILE_REF};excluded=0;confirmed=false`,
      },
    ]);
    const approved = await call("approve", {
      candidate_id: candidateId,
      expected_updated_at: body.updated_at,
      reason: "已对照官方原文核对草稿",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      review_status: "approved",
      publication: { outcome: "published" },
    });
    const queue = (await (await call("queue")).json()) as { candidates: { id: string }[] };
    expect(queue.candidates.map((c) => c.id)).not.toContain(candidateId);
  });

  it("排除勾掉的节点；排空全部事件、非法路径、过期版本都被拒绝且不写库", async () => {
    const { candidateId, updatedAt } = await drafted(maintenanceEntry, MAINTENANCE_21928_OUTPUT);
    expect((await adopt(candidateId, updatedAt, { exclude: ["e0"] })).status).toBe(400);
    expect((await adopt(candidateId, updatedAt, { exclude: ["events[0]"] })).status).toBe(400);
    expect((await adopt(candidateId, updatedAt - 1)).status).toBe(409);
    const before = await env.DB.prepare("SELECT updated_at FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ updated_at: number }>();
    expect(before?.updated_at).toBe(updatedAt);
    const ok = await adopt(candidateId, updatedAt, { exclude: ["e0.m1"] });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare("SELECT proposal_json FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ proposal_json: string }>();
    const milestones = JSON.parse(row?.proposal_json ?? "{}").events[0].milestones as {
      node_type: string;
    }[];
    expect(milestones.map((m) => m.node_type)).toEqual(["start"]);
  });

  it("有歧义的草稿必须勾选确认才能采用；没有草稿的候选不能走采用", async () => {
    const ambiguous = JSON.stringify({
      ...JSON.parse(GACHA_21876_OUTPUT),
      classification: "uncertain",
      ambiguities: ["卡池时间与另一篇公告不同"],
    });
    const { candidateId, updatedAt } = await drafted(gachaEntry, ambiguous);
    const refused = await adopt(candidateId, updatedAt);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { details: { fields: [{ path: "confirm_ambiguities", reason: "required" }] } },
    });
    expect((await adopt(candidateId, updatedAt, { confirm_ambiguities: true })).status).toBe(200);
    now += 1;
    const bare = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const detail = (await (await call(`candidates/${bare.candidateId}`)).json()) as {
      candidate: { updated_at: number };
      draft: unknown;
    };
    expect(detail.draft).toBeNull();
    const missing = await adopt(bare.candidateId, detail.candidate.updated_at);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { details: { fields: [{ path: "candidate_id", reason: "draft_missing" }] } },
    });
  });

  it("采用是写操作：缺 CSRF 或缺理由被外壳拒绝", async () => {
    const { candidateId, updatedAt } = await drafted();
    const noCsrf = await call(
      "adopt-draft",
      {
        candidate_id: candidateId,
        expected_updated_at: updatedAt,
        expected_draft_updated_at: 0,
        expected_derivation_key: "[]",
        reason: "x",
        exclude: [],
        confirm_ambiguities: false,
      },
      { [CSRF_HEADER_NAME]: "" },
    );
    expect(noCsrf.status).toBe(401);
    const noReason = await call("adopt-draft", {
      candidate_id: candidateId,
      expected_updated_at: updatedAt,
      expected_draft_updated_at: 0,
      expected_derivation_key: "[]",
      reason: " ",
      exclude: [],
      confirm_ambiguities: false,
    });
    expect(noReason.status).toBe(400);
  });

  it("ADR-0010 草稿在后台被重新起草后，按旧版本采用返回 409 且不写候选", async () => {
    const { candidateId, updatedAt } = await drafted();
    const seen = await env.DB.prepare("SELECT updated_at FROM ai_drafts WHERE candidate_id = ?")
      .bind(candidateId)
      .first<{ updated_at: number }>();
    await env.DB.prepare("UPDATE ai_drafts SET updated_at = updated_at + 5 WHERE candidate_id = ?")
      .bind(candidateId)
      .run();
    const stale = await adopt(candidateId, updatedAt, { draftUpdatedAt: seen?.updated_at });
    expect(stale.status).toBe(409);
    const row = await env.DB.prepare("SELECT updated_at, run_id FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ updated_at: number; run_id: string | null }>();
    expect(row?.updated_at).toBe(updatedAt);
    expect(row?.run_id).not.toBeNull();
    expect((await adopt(candidateId, updatedAt)).status).toBe(200);
  });
});
