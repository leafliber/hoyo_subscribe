// 仅 admin 测试使用的合成官方材料，不进行网络请求。

import { env } from "cloudflare:test";
import { TimeValueSchema } from "@hoyo/contracts";
import type { CandidateProposal } from "../extraction/schema";
import { parseAnnouncementExactTime } from "../extraction/time";
import { getSourceEntry } from "../sources/registry";
export const REVIEW_NOW = 1_800_000_000_000;
export async function seedReviewArticle(articleId = crypto.randomUUID(), versionNo = 1) {
  const source = getSourceEntry("genshin-ann");
  await env.DB.prepare(`INSERT INTO sources (source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
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
      REVIEW_NOW,
      REVIEW_NOW,
    )
    .run();
  await env.DB.prepare(`INSERT INTO articles (id,source_id,external_id,official_url,first_seen_at,last_checked_at,created_at,updated_at)
    VALUES (?,? ,?,'https://example.invalid/synthetic',?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(articleId, source.sourceId, articleId, REVIEW_NOW, REVIEW_NOW, REVIEW_NOW, REVIEW_NOW)
    .run();
  const versionId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO article_versions (id,article_id,version_no,content_hash,body_blocks_json,media_refs_json,completeness,official_published_at,fetched_at,created_at)
    VALUES (?,?,?,?,?,'[]','complete',?,?,?)`)
    .bind(
      versionId,
      articleId,
      versionNo,
      versionId,
      JSON.stringify([
        {
          kind: "text",
          text: "限时活动，2026/10/01 12:00 开始；2026/10/03 12:00 结束。官方取消说明。",
        },
      ]),
      REVIEW_NOW,
      REVIEW_NOW,
      REVIEW_NOW,
    )
    .run();
  return { articleId, versionId };
}
export function reviewProposal(
  options: {
    title?: string;
    time?: string;
    date?: string;
    status?: "scheduled" | "cancelled" | "retracted";
    classification?: string;
  } = {},
): CandidateProposal {
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
            time: TimeValueSchema.parse(time),
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
