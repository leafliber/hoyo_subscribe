// 仅本地 D1 合成证据，不请求官方来源或真实账号。
import { env } from "cloudflare:test";
import { type PublicSnapshotNode, TimeValueSchema } from "@hoyo/contracts";
import { splitSqlStatements } from "../storage/split-sql";

const migrations = import.meta.glob("../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
export const NOW = Date.parse("2026-09-30T12:00:00+08:00");
export async function migratePublicTest() {
  for (const name of Object.keys(migrations).sort()) {
    for (const sql of splitSqlStatements(migrations[name] ?? "")) await env.DB.prepare(sql).run();
  }
}
export async function resetPublicTest() {
  for (const table of [
    "public_snapshot_nodes",
    "public_snapshots",
    "calendar_projections",
    "calendar_patches",
    "event_revisions",
    "evidence",
    "candidates",
    "extraction_runs",
    "article_versions",
    "articles",
    "sources",
    "milestones",
    "events",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
}
export type Mutable<T> = T extends string | number | boolean | null
  ? T
  : { -readonly [P in keyof T]: Mutable<T[P]> };
export function makeNode(id = "node", eventId = "event"): Mutable<PublicSnapshotNode> {
  return {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    patch: null,
    source_projection_json: null,
    tombstone: false,
    projection: {
      event_id: eventId,
      milestone_id: id,
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "合成公开活动",
        summary: null,
        official_url: "https://example.invalid/official",
        human_locked: false,
      },
      milestone: {
        milestone_key: id,
        node_type: "end",
        title: "玩法结束",
        human_locked: false,
        time: TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: NOW + 3600000,
          source_timezone: "UTC+8",
          raw_expression: "合成公告：13时结束",
          time_basis: "official_explicit",
        }),
      },
    },
  };
}
export async function seedNodes(nodes: PublicSnapshotNode[], generation = 1, publishedAt = NOW) {
  const sid = `snapshot-${generation}`;
  await env.DB.prepare(
    "UPDATE public_snapshots SET state = 'superseded' WHERE state = 'current'",
  ).run();
  await env.DB.prepare(
    "INSERT INTO public_snapshots(id,generation,state,built_at,published_at,created_at) VALUES (?,?,'current',?,?,?)",
  )
    .bind(sid, generation, publishedAt, publishedAt, publishedAt)
    .run();
  for (const n of nodes) {
    const p = n.projection;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO events(id,game,region,event_type,status,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(
        p.event_id,
        n.game,
        n.region,
        p.event.event_type,
        p.event.status,
        p.event.title,
        NOW,
        NOW,
      )
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'unresolved','unknown',?,?)",
    )
      .bind(
        p.milestone_id,
        p.event_id,
        p.milestone.milestone_key,
        p.milestone.node_type,
        p.milestone.title,
        "UTC+8",
        "合成存储占位",
        NOW,
        NOW,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO public_snapshot_nodes(snapshot_id,milestone_id,node_json) VALUES (?,?,?)",
    )
      .bind(sid, p.milestone_id, JSON.stringify(n))
      .run();
  }
}
