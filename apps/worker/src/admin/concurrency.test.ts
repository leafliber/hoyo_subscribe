import "./test-support";
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createManualCandidate, decideCandidate, reviseCandidate } from "../extraction/service";
import { getSourceEntry } from "../sources/registry";

it("A-P3-ADMIN 并发回归：修正 CAS 输给驳回后，证据必须保持原样", async () => {
  const source = getSourceEntry("hsr-ann");
  await env.DB.prepare(
    `INSERT INTO sources (source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,0)`,
  )
    .bind(
      source.sourceId,
      source.game,
      source.region,
      source.adapterId,
      JSON.stringify(source.approvedHosts),
      JSON.stringify(source.verifiedPublishers),
      "{}",
      "{}",
      source.verificationState,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO articles (id,source_id,external_id,official_url,first_seen_at,last_checked_at,created_at,updated_at) VALUES ('a',?,'synthetic','https://example.test/',0,0,0,0)`,
  )
    .bind(source.sourceId)
    .run();
  await env.DB.prepare(
    `INSERT INTO article_versions (id,article_id,version_no,content_hash,body_blocks_json,media_refs_json,completeness,fetched_at,created_at) VALUES ('v','a',1,'synthetic','[{"kind":"text","text":"synthetic"}]','[]','complete',0,0)`,
  ).run();
  const proposal = { classification: "no_event", events: [], ambiguities: [] };
  const candidate = await createManualCandidate(env.DB, "v", proposal, 1);
  const before = (
    await env.DB.prepare("SELECT * FROM evidence WHERE candidate_id = ?")
      .bind(candidate.candidateId)
      .all()
  ).results;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await decideCandidate(
            env.DB,
            candidate.candidateId,
            "rejected",
            "synthetic-reviewer",
            "synthetic-reason",
            3,
          );
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(reviseCandidate(db, candidate.candidateId, proposal, 2)).rejects.toThrow(
    "候选已并发改变",
  );
  expect(
    (
      await env.DB.prepare("SELECT * FROM evidence WHERE candidate_id = ?")
        .bind(candidate.candidateId)
        .all()
    ).results,
  ).toEqual(before);
});
