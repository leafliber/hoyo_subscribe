// A-P3-VERSION · 版本时间表：建议入库、逐项确认（CAS/审计/下一版本推导）、审核详情推导与采用核对。
import "./test-support";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import genshinContent from "../../../../fixtures/sources/genshin-ann/content-21928.json";
import { runDraftJob } from "../extraction/model/draft";
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
import { makeAdminVersionRoutes } from "./versions";

const genshin = genshinContent as unknown as FixtureBody;
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
  routes: [...makeAdminReviewRoutes(() => now), ...makeAdminVersionRoutes(() => now)],
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
async function call(path: string, body?: unknown) {
  now += 1;
  return shell.fetch(
    new Request(`${site}/api/v2/admin/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    fakeExecutionContext,
  );
}
async function draft(annId: number, output: string) {
  now += 1;
  const seeded = await seedRuleCandidate("genshin-ann", fixtureEntry(genshin, annId), {
    nowMs: now,
  });
  await runDraftJob({
    db: env.DB,
    ai: fakeAi(modelResponse(output)),
    candidateId: seeded.candidateId,
    modelEnabled: true,
    deadline: now + 120_000,
    now: () => now,
  });
  return seeded;
}
const WINDOW_OUTPUT = JSON.stringify({
  ...JSON.parse(MAINTENANCE_21928_OUTPUT),
  version_window: {
    version: "7.1",
    update_start: { block: 6, time_text: "2026/09/23 06:00" },
    update_duration_text: "预计5个小时完成",
    version_end: null,
  },
});
interface Listing {
  versions: { version: string; update_start_ms: number | null; updated_at: number }[];
  suggestions: {
    id: string;
    version: string;
    update_start_ms: number | null;
    update_start: unknown;
    title: string;
  }[];
  pending_references: Record<string, number>;
}
async function listing(): Promise<Listing> {
  return (await (await call("versions")).json()) as Listing;
}
type Detail = {
  candidate: { updated_at: number };
  draft: {
    updated_at: number;
    derivation_key: string;
    derived_count: number;
    notes: string[];
    proposal: { events: { milestones: { time: Record<string, unknown> }[] }[] };
  };
};
async function detail(candidateId: string): Promise<Detail> {
  return (await (await call(`review/candidates/${candidateId}`)).json()) as Detail;
}

describe("A-P3-VERSION 版本时间表", () => {
  it("版本公告的草稿带出建议；列表给出建议原文与待审草稿的引用数", async () => {
    await draft(21928, WINDOW_OUTPUT);
    await draft(21876, GACHA_21876_OUTPUT);
    const list = await listing();
    const suggestion = list.suggestions.find((row) => row.version === "7.1");
    expect(suggestion).toMatchObject({
      update_start_ms: Date.parse("2026-09-22T22:00:00Z"),
      update_start: { block_ref: "blocks/6", quote: "2026/09/23 06:00" },
      title: "7.1版本更新维护预告",
    });
    expect(list.pending_references["genshin:7.1"]).toBeGreaterThanOrEqual(1);
    expect(list.versions).toEqual([]);
  });

  it("逐项确认：只取已核对的建议，CAS、理由与审计齐备；版本结束可取下一版本的更新开始", async () => {
    const { suggestions } = await listing();
    const suggestion = suggestions.find((row) => row.version === "7.1");
    const base = { game: "genshin", version: "7.1", reason: "已核对版本公告原文" };
    const bad = await call("versions/confirm", {
      ...base,
      field: "update_start",
      suggestion_id: "missing",
      expected_updated_at: 0,
    });
    expect(bad.status).toBe(400);
    const ok = await call("versions/confirm", {
      ...base,
      field: "update_start",
      suggestion_id: suggestion?.id,
      expected_updated_at: 0,
    });
    expect(ok.status).toBe(200);
    const row = ((await ok.json()) as { version: { update_start_ms: number; updated_at: number } })
      .version;
    expect(row.update_start_ms).toBe(Date.parse("2026-09-22T22:00:00Z"));
    const stale = await call("versions/confirm", {
      ...base,
      field: "update_start",
      suggestion_id: suggestion?.id,
      expected_updated_at: 0,
    });
    expect(stale.status).toBe(409);
    const audit = await env.DB.prepare(
      "SELECT action, reason, detail_ref FROM audit_log WHERE target_id = 'genshin:CN:7.1'",
    ).all<{ action: string; reason: string; detail_ref: string }>();
    expect(audit.results).toEqual([
      {
        action: "version_confirm",
        reason: "已核对版本公告原文",
        detail_ref: `update_start:suggestion:${suggestion?.id}`,
      },
    ]);
    // 下一版本未确认时不能借用；确认 7.2 的更新开始后，7.1 结束取它。
    const early = await call("versions/confirm", {
      ...base,
      field: "version_end",
      from_next_version: true,
      expected_updated_at: row.updated_at,
    });
    expect(early.status).toBe(400);
    const id72 = crypto.randomUUID();
    const { versionId } = await seedRuleCandidate("genshin-ann", fixtureEntry(genshin, 21928), {
      nowMs: now,
    });
    await env.DB.prepare(
      `INSERT INTO game_version_suggestions (id, game, region, version, article_version_id, update_start_ms,
         update_start_json, update_duration_json, version_end_ms, version_end_json, created_at)
       VALUES (?, 'genshin', 'CN', '7.2', ?, ?, '{"block_ref":"blocks/2","quote":"合成"}', NULL, NULL, NULL, ?)`,
    )
      .bind(id72, versionId, Date.parse("2026-11-03T22:00:00Z"), now)
      .run();
    expect(
      (
        await call("versions/confirm", {
          game: "genshin",
          version: "7.2",
          field: "update_start",
          suggestion_id: id72,
          expected_updated_at: 0,
          reason: "已核对",
        })
      ).status,
    ).toBe(200);
    const end = await call("versions/confirm", {
      ...base,
      field: "version_end",
      from_next_version: true,
      expected_updated_at: row.updated_at,
    });
    expect(end.status).toBe(200);
    expect(((await end.json()) as { version: Record<string, unknown> }).version).toMatchObject({
      version_end_ms: Date.parse("2026-11-03T22:00:00Z"),
      version_end_basis: "next_update",
    });
  });
});

describe("A-P3-VERSION 审核推导", () => {
  it("确认前保持未定并提示；确认后详情按日期推导，采用必须带审核员看到的推导版本", async () => {
    now += 1;
    await env.DB.prepare(
      "DELETE FROM game_versions WHERE game = 'genshin' AND version = '7.1'",
    ).run();
    const { candidateId } = await draft(21876, GACHA_21876_OUTPUT);
    const before = await detail(candidateId);
    expect(before.draft.derived_count).toBe(0);
    expect(before.draft.proposal.events[0].milestones[0].time).toMatchObject({
      precision: "unknown",
    });
    expect(before.draft.notes.join("\n")).toContain("7.1 版本的更新开始时间尚未确认");
    const { suggestions } = await listing();
    const suggestion = suggestions.find((row) => row.version === "7.1");
    await call("versions/confirm", {
      game: "genshin",
      version: "7.1",
      field: "update_start",
      suggestion_id: suggestion?.id,
      expected_updated_at: 0,
      reason: "已核对",
    });
    const after = await detail(candidateId);
    expect(after.draft.derived_count).toBe(1);
    expect(after.draft.proposal.events[0].milestones[0].time).toEqual({
      precision: "date",
      date: "2026-09-23",
      source_timezone: "UTC+08:00",
      raw_expression: "7.1版本更新后",
      time_basis: "deterministic_derived",
    });
    expect(after.draft.derivation_key).not.toBe(before.draft.derivation_key);
    const body = {
      candidate_id: candidateId,
      expected_updated_at: after.candidate.updated_at,
      expected_draft_updated_at: after.draft.updated_at,
      reason: "已核对",
      exclude: [],
      confirm_ambiguities: false,
    };
    expect(
      (
        await call("review/adopt-draft", {
          ...body,
          expected_derivation_key: before.draft.derivation_key,
        })
      ).status,
    ).toBe(409);
    const adopted = await call("review/adopt-draft", {
      ...body,
      expected_derivation_key: after.draft.derivation_key,
    });
    expect(adopted.status).toBe(200);
    const row = await env.DB.prepare("SELECT proposal_json FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ proposal_json: string }>();
    expect(JSON.parse(row?.proposal_json ?? "{}").events[0].milestones[0].time).toMatchObject({
      precision: "date",
      date: "2026-09-23",
      time_basis: "deterministic_derived",
    });
    // 采用后版本时间被清除：批准不发布过期的推导；重新确认同一值后才能批准。
    const revision = ((await adopted.json()) as { updated_at: number }).updated_at;
    const confirmed = (await listing()).versions.find((v) => v.version === "7.1");
    const cleared = await call("versions/clear", {
      game: "genshin",
      version: "7.1",
      field: "update_start",
      expected_updated_at: confirmed?.updated_at,
      reason: "核对有误，先撤下",
    });
    expect(cleared.status).toBe(200);
    const blocked = await call("review/approve", {
      candidate_id: candidateId,
      expected_updated_at: revision,
      reason: "已核对",
    });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({
      error: {
        details: { fields: [{ path: "candidate_id", reason: "version_derivation_mismatch" }] },
      },
    });
    const restored = ((await cleared.json()) as { version: { updated_at: number } }).version;
    await call("versions/confirm", {
      game: "genshin",
      version: "7.1",
      field: "update_start",
      suggestion_id: suggestion?.id,
      expected_updated_at: restored.updated_at,
      reason: "复核无误",
    });
    const approved = await call("review/approve", {
      candidate_id: candidateId,
      expected_updated_at: revision,
      reason: "已核对",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ publication: { outcome: "published" } });
  });

  it("人工修正不能给版本锚点手填与确认值不一致的时间", async () => {
    const { candidateId } = await draft(21876, GACHA_21876_OUTPUT);
    const current = await detail(candidateId);
    const proposal = structuredClone(current.draft.proposal) as unknown as {
      classification: string;
      ambiguities: string[];
      events: { milestones: { time: Record<string, unknown> }[] }[];
    };
    proposal.classification = "events";
    proposal.ambiguities = [];
    proposal.events[0].milestones[0].time = {
      precision: "date",
      date: "2026-09-24",
      source_timezone: "UTC+08:00",
      raw_expression: "7.1版本更新后",
      time_basis: "deterministic_derived",
    };
    const response = await call("review/revise", {
      candidate_id: candidateId,
      expected_updated_at: current.candidate.updated_at,
      reason: "人工修正",
      proposal_json: JSON.stringify(proposal),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        details: { fields: [{ path: "proposal_json", reason: "version_derivation_mismatch" }] },
      },
    });
  });
});
