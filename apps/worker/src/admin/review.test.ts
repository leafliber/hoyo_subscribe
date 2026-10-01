import "./test-support";
import { env } from "cloudflare:test";
import { ADMIN_AUDIT_TTL, MATCH_PAGE, PUBLIC_READ_LIMITS } from "@hoyo/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildPublicSnapshot } from "../calendar/public/snapshot";
import { eventIdentity } from "../extraction/identity";
import { createManualCandidate, decideCandidate, findCandidateById } from "../extraction/service";
import { publishApprovedCandidate } from "../publishing/publish";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../shell";
import { ADMIN_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext, testKeyring } from "../shell/test-support";
import { ARTICLE_COMPLETENESS_STATES } from "../sources/articles/completeness";
import { generateSecretToken } from "../storage/crypto/random";
import { makeAdminReviewRoutes } from "./review";
import { REVIEW_NOW, reviewProposal, seedReviewArticle } from "./review-fixtures";
import { combinedAuthenticator, issueAdminSession } from "./session";

let now = REVIEW_NOW;
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
async function call(path: string, body?: unknown, db = env.DB) {
  now += 1;
  return shell.fetch(
    new Request(`${site}/api/v2/admin/review/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, DB: db },
    fakeExecutionContext,
  );
}
async function makeCandidate(proposal = reviewProposal(), versionId?: string) {
  const saved = versionId ?? (await seedReviewArticle()).versionId;
  const response = await call("create", {
    article_version_id: saved,
    proposal_json: JSON.stringify(proposal),
    reason: "人工核对已保存官方正文",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    candidate: {
      candidateId: string;
      updatedAtMs: number;
      articleVersionId: string;
      proposal: typeof proposal;
    };
  };
}
async function audits(id: string) {
  return (
    await env.DB.prepare("SELECT * FROM audit_log WHERE target_id=? ORDER BY created_at,id")
      .bind(id)
      .all<{
        action: string;
        reason: string;
        actor_id: string;
        created_at: number;
        expires_at: number;
        detail_ref: string | null;
      }>()
  ).results;
}
const fields = (candidate: { candidateId: string; updatedAtMs: number }) => ({
  candidate_id: candidate.candidateId,
  expected_updated_at: candidate.updatedAtMs,
  reason: "已核对正文与证据",
});
async function facts() {
  return Promise.all(
    [
      "events",
      "milestones",
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

describe("A-P3-ADMIN 审核 HTTP 到条件发布的闭环", () => {
  it("保存正文直接建候选，详情包含原始块与证据；批准生成事实、outbox 与单条到期审计", async () => {
    const { candidate } = await makeCandidate();
    const detail = await call(`candidates/${candidate.candidateId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      article: { articleVersionId: candidate.articleVersionId, blocks: [{ kind: "text" }] },
      evidence: [{ block_ref: "blocks/0" }],
    });
    const response = await call("approve", fields(candidate));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review_status: "approved",
      publication: { outcome: "published" },
    });
    const rows = await audits(candidate.candidateId);
    expect(rows.map((row) => row.action)).toEqual(["candidate_create", "candidate_approve"]);
    expect(rows[1].detail_ref).toBe("publication:published");
    for (const row of rows) {
      expect(row.expires_at).toBe(row.created_at + ADMIN_AUDIT_TTL * 1_000);
      expect(row.actor_id).toBe("owner");
      expect(row.reason.length).toBeGreaterThan(0);
    }
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE topic='public_snapshot_rebuild'",
      ).first("n"),
    ).not.toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("候选修正替换证据并绑定 expected_updated_at；陈旧修正与未知字段被拒绝", async () => {
    const { candidate } = await makeCandidate();
    const before = await env.DB.prepare("SELECT id FROM evidence WHERE candidate_id=?")
      .bind(candidate.candidateId)
      .first("id");
    const response = await call("revise", {
      ...fields(candidate),
      proposal_json: JSON.stringify(reviewProposal({ title: "修正名称" })),
    });
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM evidence WHERE candidate_id=?")
        .bind(candidate.candidateId)
        .first("id"),
    ).not.toEqual(before);
    expect(
      (
        await call("revise", {
          ...fields(candidate),
          proposal_json: JSON.stringify(reviewProposal()),
        })
      ).status,
    ).toBe(409);
    expect((await call("reject", { ...fields(candidate), admin_id: "forged" })).status).toBe(400);
    expect((await audits(candidate.candidateId)).map((row) => row.action)).toEqual([
      "candidate_create",
      "candidate_revise",
    ]);
  });
  it("伪造引文、未解歧义、空理由、过长中文/转义文本均不能批准或写入", async () => {
    const article = await seedReviewArticle();
    const base = reviewProposal();
    const invalidQuote = {
      ...base,
      events: base.events.map((e) => ({
        ...e,
        type_evidence: { ...e.type_evidence, quote: "正文没有此引文" },
      })),
    };
    // 构造故意无效输入，不修改领域只读对象。
    for (const proposal of [
      invalidQuote,
      reviewProposal({ title: "界".repeat(PUBLIC_READ_LIMITS.nodeBytes / 32) }),
      reviewProposal({ title: '"'.repeat(PUBLIC_READ_LIMITS.nodeBytes / 32) }),
    ]) {
      expect(
        (
          await call("create", {
            article_version_id: article.versionId,
            proposal_json: JSON.stringify(proposal),
            reason: "synthetic",
          })
        ).status,
      ).toBe(400);
    }
    const { candidate } = await makeCandidate(reviewProposal({ classification: "uncertain" }));
    expect((await call("approve", fields(candidate))).status).toBe(400);
    expect((await call("reject", { ...fields(candidate), reason: "  " })).status).toBe(400);
    expect((await call("reject", fields(candidate))).status).toBe(200);
  });
  it("显式 correction 修改人工锁定字段；association 关联跨公告；retract 留理由", async () => {
    const article = await seedReviewArticle();
    const original = (await makeCandidate(reviewProposal(), article.versionId)).candidate;
    const first = await call("approve", fields(original));
    expect(first.status).toBe(200);
    const eventId = await eventIdentity("genshin-ann", article.articleId, "moon_trial");
    const next = await seedReviewArticle(article.articleId, 2);
    const correction = (await makeCandidate(reviewProposal({ title: "名称更正" }), next.versionId))
      .candidate;
    expect(await (await call("correct", fields(correction))).json()).toMatchObject({
      publication: { outcome: "published" },
    });
    expect(
      await env.DB.prepare("SELECT title FROM events WHERE id=?").bind(eventId).first("title"),
    ).toBe("名称更正");
    const associated = (await makeCandidate(reviewProposal({ title: "补充公告" }))).candidate;
    expect(
      await (await call("associate", { ...fields(associated), target_event_id: eventId })).json(),
    ).toMatchObject({ publication: { outcome: "published" } });
    const retractedProposal = reviewProposal({ status: "retracted" });
    const retractArticle = await seedReviewArticle(article.articleId, 3);
    const retract = (await makeCandidate(retractedProposal, retractArticle.versionId)).candidate;
    expect(await (await call("retract", fields(retract))).json()).toMatchObject({
      publication: { outcome: "published" },
    });
    expect(
      await env.DB.prepare("SELECT status FROM events WHERE id=?").bind(eventId).first("status"),
    ).toBe("retracted");
    expect((await audits(retract.candidateId)).map((row) => row.action)).toEqual([
      "candidate_create",
      "candidate_retract",
    ]);
  });
  it("发布 SQL 失败整批回滚事实，响应明确已批准未发布；重试不重复事实", async () => {
    const { candidate } = await makeCandidate();
    const before = await facts();
    await env.DB.exec(
      "CREATE TRIGGER reject_admin_publish BEFORE INSERT ON event_revisions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    let response: Response;
    try {
      response = await call("approve", fields(candidate));
    } finally {
      await env.DB.exec("DROP TRIGGER reject_admin_publish;");
    }
    expect(await response.json()).toMatchObject({
      review_status: "approved",
      publication: { outcome: "temporarily_unavailable" },
    });
    expect(await facts()).toEqual(before);
    const current = await findCandidateById(env.DB, candidate.candidateId);
    expect(current.review_status).toBe("approved");
    expect((await audits(candidate.candidateId)).length).toBe(2);
    expect(
      await (
        await call("approve", { ...fields(candidate), expected_updated_at: current.updated_at })
      ).json(),
    ).toMatchObject({ publication: { outcome: "published" } });
    const published = await facts();
    expect(
      await (
        await call("approve", { ...fields(candidate), expected_updated_at: current.updated_at })
      ).json(),
    ).toMatchObject({ publication: { outcome: "unchanged" } });
    expect(await facts()).toEqual(published);
  });
  it("审计写失败不能留下新候选或裁定", async () => {
    const { candidate } = await makeCandidate();
    const article = await seedReviewArticle();
    const before = await env.DB.prepare("SELECT count(*) AS n FROM candidates").first("n");
    await env.DB.exec(
      "CREATE TRIGGER reject_admin_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    try {
      expect(
        (
          await call("create", {
            article_version_id: article.versionId,
            proposal_json: JSON.stringify(reviewProposal()),
            reason: "synthetic",
          })
        ).status,
      ).toBe(503);
      expect((await call("reject", fields(candidate))).status).toBe(503);
    } finally {
      await env.DB.exec("DROP TRIGGER reject_admin_audit;");
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM candidates").first("n")).toBe(before);
    expect((await findCandidateById(env.DB, candidate.candidateId)).review_status).toBe("pending");
  });
  it("同一已读版本并发驳回/修正只有一个成功，失败方无审计或证据副作用", async () => {
    const { candidate } = await makeCandidate();
    const responses = await Promise.all([
      call("reject", fields(candidate)),
      call("revise", {
        ...fields(candidate),
        proposal_json: JSON.stringify(reviewProposal({ title: "另一审核者修正" })),
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await audits(candidate.candidateId)).length).toBe(2);
  });
  it("待审队列 MATCH_PAGE 分页不遗漏，详情与队列都不能由匿名读取", async () => {
    const article = await seedReviewArticle();
    for (let i = 0; i < MATCH_PAGE + 1; i++)
      await createManualCandidate(env.DB, article.versionId, reviewProposal(), ++now);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await call(`queue${cursor ? `?cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        candidates: { id: string }[];
        next_cursor: string | null;
      };
      expect(page.candidates.length).toBeLessThanOrEqual(MATCH_PAGE);
      for (const c of page.candidates) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(
      Number(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM candidates WHERE review_status='pending'",
        ).first("n"),
      ),
    );
    expect(
      (
        await shell.fetch(
          new Request(`${site}/api/v2/admin/review/queue`),
          env,
          fakeExecutionContext,
        )
      ).status,
    ).toBe(401);
  });
  it("最大允许文本经过实际公共快照构建仍低于 nodeBytes", async () => {
    const { candidate } = await makeCandidate(
      reviewProposal({
        title: "界".repeat(Math.floor((PUBLIC_READ_LIMITS.nodeBytes / 32 - 2) / 3)),
      }),
    );
    expect(await (await call("approve", fields(candidate))).json()).toMatchObject({
      publication: { outcome: "published" },
    });
    await buildPublicSnapshot(env.DB, ++now);
    const maximum = Number(
      await env.DB.prepare(
        "SELECT max(length(CAST(node_json AS BLOB))) AS n FROM public_snapshot_nodes",
      ).first("n"),
    );
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(PUBLIC_READ_LIMITS.nodeBytes);
  });
});

it("A-P3-ADMIN 已批准候选发布时审计失败，事实与 outbox 不得落库", async () => {
  const { candidate } = await makeCandidate();
  // 首次发布故障保留审核结论；第二次只走已批准候选的发布重试。
  await env.DB.exec(
    "CREATE TRIGGER defer_publish BEFORE INSERT ON event_revisions BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
  );
  try {
    await call("approve", fields(candidate));
  } finally {
    await env.DB.exec("DROP TRIGGER defer_publish;");
  }
  const approved = await findCandidateById(env.DB, candidate.candidateId);
  const before = await facts();
  await env.DB.exec(
    "CREATE TRIGGER reject_publish_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
  );
  try {
    expect(
      (await call("approve", { ...fields(candidate), expected_updated_at: approved.updated_at }))
        .status,
    ).toBe(503);
  } finally {
    await env.DB.exec("DROP TRIGGER reject_publish_audit;");
  }
  expect(await facts()).toEqual(before);
});

async function reviewState() {
  return {
    facts: await facts(),
    review: await Promise.all(
      ["candidates", "evidence", "audit_log"].map(
        async (table) =>
          (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
      ),
    ),
  };
}

it("A-P3-ADMIN 新建候选的文章版本不存在返回字段级 400，不写候选或审计", async () => {
  const before = await reviewState();
  const response = await call("create", {
    article_version_id: "missing-article-version",
    proposal_json: JSON.stringify(reviewProposal()),
    reason: "synthetic",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: "validation",
      details: {
        code: "validation",
        fields: [{ path: "article_version_id", reason: "not_found" }],
      },
    },
  });
  expect(await reviewState()).toEqual(before);
});

it("A-P3-ADMIN 详情及其他审核端点缺失文章版本同样返回 400，存储故障仍返回 503", async () => {
  const { candidate } = await makeCandidate();
  const before = await reviewState();
  // 模拟候选已读到，但关联文章版本读取缺失；其余查询仍使用真实 D1。
  const articleRead = vi.fn(async () => null);
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (!sql.includes("FROM article_versions av")) return target.prepare(sql);
          return { bind: () => ({ first: articleRead }) } as unknown as D1PreparedStatement;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const requests: Array<[string, unknown?]> = [
    [`candidates/${candidate.candidateId}`],
    ["revise", { ...fields(candidate), proposal_json: JSON.stringify(reviewProposal()) }],
    ["reject", fields(candidate)],
    ["approve", fields(candidate)],
    ["correct", fields(candidate)],
    ["associate", { ...fields(candidate), target_event_id: "synthetic-event" }],
    ["retract", fields(candidate)],
  ];
  for (const [path, body] of requests) {
    const response = await call(path, body, db);
    expect(response.status, path).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation",
        details: {
          code: "validation",
          fields: [{ path: "article_version_id", reason: "not_found" }],
        },
      },
    });
  }
  articleRead.mockRejectedValueOnce(new Error("synthetic storage failure"));
  expect((await call(`candidates/${candidate.candidateId}`, undefined, db)).status).toBe(503);
  expect(await reviewState()).toEqual(before);
});

it("A-P3-ADMIN 正文不完整时批准被拒，不写裁定、不写审计", async () => {
  for (const completeness of ARTICLE_COMPLETENESS_STATES.filter((value) => value !== "complete")) {
    const article = await seedReviewArticle(undefined, undefined, completeness);
    const { candidate } = await makeCandidate(reviewProposal(), article.versionId);
    const before = await reviewState();
    const response = await call("approve", fields(candidate));
    expect(response.status, completeness).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation",
        details: {
          code: "validation",
          fields: [{ path: "candidate_id", reason: "candidate_validation_failed" }],
        },
      },
    });
    expect(await reviewState()).toEqual(before);
    expect((await findCandidateById(env.DB, candidate.candidateId)).review_status).toBe("pending");
  }
});

it("A-P3-ADMIN 直接发布的 expectedUpdatedAt 不符返回 condition_missed，什么都不写", async () => {
  const { candidate } = await makeCandidate();
  const approved = await decideCandidate(
    env.DB,
    candidate.candidateId,
    "approved",
    "owner",
    "synthetic",
    ++now,
  );
  const before = await reviewState();
  const prepareEffects = vi.fn(async () => []);
  const outcome = await publishApprovedCandidate(env.DB, candidate.candidateId, ++now, false, {
    expectedUpdatedAt: approved.updatedAtMs - 1,
    prepareEffects,
  });
  expect(outcome).toEqual({ outcome: "condition_missed" });
  expect(prepareEffects).not.toHaveBeenCalled();
  expect(await reviewState()).toEqual(before);
});
