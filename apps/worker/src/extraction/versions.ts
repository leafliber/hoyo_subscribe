// P3-19（ADR-0011）· 版本时间表：AI 建议入库、读取确认值，以及对草稿与人工候选的确定性推导和一致性核对。
// 推导规则只有 @hoyo/contracts 的 deriveVersionTime 一处定义；这里只负责取数和套用。
import {
  browseDate,
  browseTimestamp,
  type ConfirmedVersionWindow,
  deriveVersionTime,
  parseVersionAnchor,
  type TimeValue,
} from "@hoyo/contracts";
import type { StoredArticleVersion } from "./article";
import type { DraftVersionWindow } from "./model/build";
import type { CandidateProposal } from "./schema";
import { ANNOUNCEMENT_TIMEZONE } from "./time";

export interface StoredVersionWindow extends ConfirmedVersionWindow {
  readonly updatedAt: number;
}

/** 版本公告的草稿带出逐字核对通过的版本时间时记一条建议；同一文章版本同一版本号只记一次。 */
export async function recordVersionSuggestion(
  db: D1Database,
  article: StoredArticleVersion,
  window: DraftVersionWindow,
  nowMs: number,
): Promise<void> {
  if (window.updateStart === null && window.versionEnd === null) return;
  const evidence = (part: { blockRef: string; quote: string } | null) =>
    part === null ? null : JSON.stringify({ block_ref: part.blockRef, quote: part.quote });
  await db
    .prepare(
      `INSERT INTO game_version_suggestions (id, game, region, version, article_version_id,
         update_start_ms, update_start_json, update_duration_json, version_end_ms, version_end_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(article_version_id, version) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      article.game,
      article.region,
      window.version,
      article.articleVersionId,
      window.updateStart?.utcMs ?? null,
      evidence(window.updateStart),
      evidence(window.updateDuration),
      window.versionEnd?.utcMs ?? null,
      evidence(window.versionEnd),
      nowMs,
    )
    .run();
}

/** 候选里是否有原文整体为版本锚点的节点；没有时不必读版本时间表。 */
export function hasVersionAnchor(proposal: CandidateProposal): boolean {
  return proposal.events.some((event) =>
    event.milestones.some(
      (milestone) => parseVersionAnchor(milestone.time.raw_expression) !== null,
    ),
  );
}

export async function loadConfirmedVersions(
  db: D1Database,
  game: string,
  region: string,
): Promise<Map<string, StoredVersionWindow>> {
  const rows = (
    await db
      .prepare(
        `SELECT version, update_start_ms, version_end_ms, updated_at FROM game_versions
          WHERE game = ? AND region = ?`,
      )
      .bind(game, region)
      .all<{
        version: string;
        update_start_ms: number | null;
        version_end_ms: number | null;
        updated_at: number;
      }>()
  ).results;
  return new Map(
    rows.map((row) => [
      row.version,
      {
        version: row.version,
        updateStartMs: row.update_start_ms,
        versionEndMs: row.version_end_ms,
        updatedAt: row.updated_at,
      },
    ]),
  );
}

/** 只在候选含版本锚点时读取版本时间表：少一次查询，也让与版本无关的审核不依赖这张表。 */
export async function loadVersionsFor(
  db: D1Database,
  game: string,
  region: string,
  proposal: CandidateProposal,
): Promise<Map<string, StoredVersionWindow>> {
  return hasVersionAnchor(proposal) ? loadConfirmedVersions(db, game, region) : new Map();
}

export interface VersionDerivation {
  readonly proposal: CandidateProposal;
  readonly notes: readonly string[];
  /** 用到的版本行及其版本号；版本时间被改过时与审核员看到的不同，采用时据此 409。 */
  readonly key: string;
  readonly derived: number;
}

/**
 * 只改"未定时刻"、依据为 unresolved、且原文整体是版本锚点的节点；其余节点原样保留。
 * 官方写"预计"的锚点（official_estimate）不推导：推成确定时刻会让预计时间进入提醒（主方案 §3.3）。
 */
export function applyVersionDerivations(
  proposal: CandidateProposal,
  versions: ReadonlyMap<string, StoredVersionWindow>,
): VersionDerivation {
  const used = new Map<string, number>();
  const notes = new Set<string>();
  let derived = 0;
  const events = proposal.events.map((event) => ({
    ...event,
    milestones: event.milestones.map((milestone) => {
      if (milestone.time.precision !== "unknown") return milestone;
      const raw = milestone.time.raw_expression;
      const anchor = parseVersionAnchor(raw);
      if (anchor === null) return milestone;
      if (milestone.time.time_basis === "official_estimate") {
        notes.add(`「${raw}」官方写的是预计时间，不做版本推导，保持未定时刻。`);
        return milestone;
      }
      if (milestone.time.time_basis !== "unresolved") return milestone;
      const window = versions.get(anchor.version);
      used.set(anchor.version, window?.updatedAt ?? 0);
      const time = deriveVersionTime(raw, window, ANNOUNCEMENT_TIMEZONE);
      if (time === null) {
        notes.add(
          `「${raw}」：${anchor.version} 版本的${anchor.kind === "update" ? "更新开始" : "结束"}时间尚未确认，暂为未定时刻；在「版本时间表」确认后自动推导。`,
        );
        return milestone;
      }
      derived++;
      notes.add(
        anchor.kind === "update" && window?.updateStartMs != null
          ? `「${raw}」按 ${anchor.version} 版本更新开始 ${browseTimestamp(window.updateStartMs)}（北京时间）推导为 ${browseDate(window.updateStartMs)}（仅日期，不推出几点）。`
          : `「${raw}」按确认的 ${anchor.version} 版本结束时间推导为 ${time.precision === "datetime" ? browseTimestamp(time.utc_ms) : ""}（北京时间）。`,
      );
      return { ...milestone, time };
    }),
  }));
  return {
    proposal: { ...proposal, events },
    notes: [...notes],
    key: JSON.stringify([...used.entries()].sort(([a], [b]) => a.localeCompare(b))),
    derived,
  };
}

const sameTime = (a: TimeValue, b: TimeValue) =>
  a.precision === b.precision &&
  a.time_basis === b.time_basis &&
  a.source_timezone === b.source_timezone &&
  a.raw_expression === b.raw_expression &&
  (a.precision !== "datetime" || (b.precision === "datetime" && a.utc_ms === b.utc_ms)) &&
  (a.precision !== "date" || (b.precision === "date" && a.date === b.date));

/** 人工写入的候选：版本锚点节点要么保持未定，要么与确认的版本时间推导一致，不能手填一个时刻冒充推导。 */
export function versionDerivationIssues(
  proposal: CandidateProposal,
  versions: ReadonlyMap<string, StoredVersionWindow>,
): string[] {
  const issues: string[] = [];
  proposal.events.forEach((event, eventIndex) => {
    event.milestones.forEach((milestone, milestoneIndex) => {
      if (milestone.time.precision === "unknown") return;
      const anchor = parseVersionAnchor(milestone.time.raw_expression);
      if (anchor === null) return;
      const expected = deriveVersionTime(
        milestone.time.raw_expression,
        versions.get(anchor.version),
        ANNOUNCEMENT_TIMEZONE,
      );
      if (expected === null || !sameTime(expected, milestone.time))
        issues.push(`$.events[${eventIndex}].milestones[${milestoneIndex}].time`);
    });
  });
  return issues;
}

/** 管线重试发布已批准的人工候选前核对：版本时间表在批准后被改过或清除时，推导值已过期，不能发布。 */
export async function staleVersionDerivation(
  db: D1Database,
  candidate: {
    readonly proposal: CandidateProposal;
    readonly game: string;
    readonly region: string;
  },
): Promise<boolean> {
  if (!hasVersionAnchor(candidate.proposal)) return false;
  const versions = await loadConfirmedVersions(db, candidate.game, candidate.region);
  return versionDerivationIssues(candidate.proposal, versions).length > 0;
}
