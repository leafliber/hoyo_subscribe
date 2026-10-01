import "./test-support";
import { env } from "cloudflare:test";
import { PUBLIC_READ_LIMITS, type PublicCalendarProjection } from "@hoyo/contracts";
import { expect, it } from "vitest";
import { buildPublicSnapshot } from "../calendar/public/snapshot";
import { createManualCandidate, decideCandidate } from "../extraction/service";
import { publishApprovedCandidate } from "../publishing/publish";
import { checkCandidateText, checkPublishedNodeBytes } from "./limits";
import { REVIEW_NOW, reviewProposal, seedReviewArticle } from "./review-fixtures";

it("A-P3-ADMIN 节点预算覆盖双份投影与继承的历史更正，而非只数新标题", async () => {
  const proposal = reviewProposal();
  checkCandidateText(proposal);
  const article = await seedReviewArticle();
  const candidate = await createManualCandidate(
    env.DB,
    article.versionId,
    proposal,
    REVIEW_NOW - 3,
  );
  await decideCandidate(
    env.DB,
    candidate.candidateId,
    "approved",
    "owner",
    "synthetic",
    REVIEW_NOW - 2,
  );
  await publishApprovedCandidate(env.DB, candidate.candidateId, REVIEW_NOW - 1);
  const projection: PublicCalendarProjection = JSON.parse(
    String(
      await env.DB.prepare("SELECT projection_json FROM calendar_projections LIMIT 1").first(
        "projection_json",
      ),
    ),
  );
  const milestone = projection.milestone;
  const scope = { game: "genshin", region: "CN" };
  await expect(
    checkPublishedNodeBytes(env.DB, [projection], REVIEW_NOW, scope),
  ).resolves.toBeUndefined();
  const hugeUrl = {
    ...projection,
    event: {
      ...projection.event,
      official_url: `https://example.invalid/${"界".repeat(PUBLIC_READ_LIMITS.nodeBytes)}`,
    },
  };
  await expect(checkPublishedNodeBytes(env.DB, [hugeUrl], REVIEW_NOW, scope)).rejects.toMatchObject(
    { code: "validation" },
  );
  const oldTime = {
    ...milestone.time,
    raw_expression: "历史表达".repeat(PUBLIC_READ_LIMITS.nodeBytes),
  };
  const old = {
    ...scope,
    projection: { ...projection, milestone: { ...projection.milestone, time: oldTime } },
    public_ical_revision: 1,
    patch: {
      kind: "rescheduled",
      fact_reason: "已公布新时间",
      extends_window: true,
      display_time: oldTime,
      old_time: oldTime,
      new_time: milestone.time,
      retain_until: REVIEW_NOW + 1,
    },
    source_projection_json: "old",
    tombstone: false,
  };
  await buildPublicSnapshot(env.DB, REVIEW_NOW - 1);
  await env.DB.prepare("UPDATE public_snapshot_nodes SET node_json = ? WHERE milestone_id = ?")
    .bind(JSON.stringify(old), projection.milestone_id)
    .run();
  await expect(
    checkPublishedNodeBytes(env.DB, [projection], REVIEW_NOW, scope),
  ).rejects.toMatchObject({ code: "validation" });
});
