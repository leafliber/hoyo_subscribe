// P3-19（ADR-0011）· 版本时间表：AI 建议入库、读取确认值，以及对草稿与人工候选的确定性推导和一致性核对。
// P3-21（ADR-0013）· 同一推导再补全没写年份的日期：参照日期取正文里最早的四位年份日期 >
// 所属版本已确认的更新开始 > 公告发布日期。
// 推导规则只有 @hoyo/contracts 的 deriveVersionTime / completeYear 定义；这里只负责取数和套用。
import {
  browseDate,
  browseTimestamp,
  type ConfirmedVersionWindow,
  completeYear,
  deriveVersionTime,
  earliestExplicitDate,
  parseVersionAnchor,
  parseYearlessDate,
  type TimeValue,
  type YearReference,
} from "@hoyo/contracts";
import { loadStoredArticleVersion, type StoredArticleVersion } from "./article";
import type { DraftVersionWindow } from "./model/build";
import { readableBlockText } from "./model/readable";
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

/** ADR-0013：候选里是否有原文整体是没写年份的日期的节点。 */
export function hasYearlessDate(proposal: CandidateProposal): boolean {
  return proposal.events.some((event) =>
    event.milestones.some((milestone) => parseYearlessDate(milestone.time.raw_expression) !== null),
  );
}

const VERSION_MENTION = /(\d{1,2}\.\d{1,2})[」”]?版本/g;

/** 公告标题与全文里出现的"X.Y版本"；版本时间摘录（ADR-0011）与补年份的所属版本（ADR-0013）共用。 */
export function versionMentions(article: StoredArticleVersion): {
  readonly title: readonly string[];
  readonly body: readonly string[];
} {
  const mentions = (raw: string) => [...raw.matchAll(VERSION_MENTION)].map((match) => match[1]);
  const first = article.blocks[0];
  return {
    title: first?.kind === "title" ? mentions(first.text) : [],
    body: article.blocks.flatMap((block) =>
      mentions(block.kind === "html" ? block.html : block.text),
    ),
  };
}

/** 公告所属的版本：标题只提到一个版本号时取它；标题没写时，全文只提到一个才取；有歧义不取。 */
export function articleVersion(article: StoredArticleVersion): string | null {
  const { title, body } = versionMentions(article);
  const distinct = [...new Set(title.length > 0 ? title : body)];
  return distinct.length === 1 ? distinct[0] : null;
}

/** ADR-0013 参照日期：正文里最早的四位年份日期 > 所属版本已确认的更新开始 > 公告发布日期；都没有时为 null。 */
export function yearReferenceOf(
  article: StoredArticleVersion,
  versions: ReadonlyMap<string, StoredVersionWindow>,
): YearReference | null {
  const explicit = earliestExplicitDate(article.blocks.map(readableBlockText));
  if (explicit !== null) return { date: explicit, source: "article" };
  const version = articleVersion(article);
  const start = version === null ? null : (versions.get(version)?.updateStartMs ?? null);
  if (version !== null && start !== null)
    return { date: browseDate(start), source: "version", version };
  if (article.officialPublishedAtMs != null)
    return { date: browseDate(article.officialPublishedAtMs), source: "published" };
  return null;
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

/** 推导用到的外部事实：确认的版本时间（ADR-0011），与补全年份的参照日期（ADR-0013）。 */
export interface DerivationContext {
  readonly versions: ReadonlyMap<string, StoredVersionWindow>;
  readonly year: YearReference | null;
}

/**
 * 只在用得上时读取版本时间表：候选含版本锚点，或者要按所属版本的更新开始补年份。
 * 与版本、年份都无关的审核不依赖这张表，也不多一次查询。
 */
export async function loadDerivationContext(
  db: D1Database,
  article: StoredArticleVersion,
  proposal: CandidateProposal,
): Promise<DerivationContext> {
  const anchors = hasVersionAnchor(proposal);
  const yearless = hasYearlessDate(proposal);
  if (!anchors && !yearless) return { versions: new Map(), year: null };
  const byVersion =
    yearless &&
    earliestExplicitDate(article.blocks.map(readableBlockText)) === null &&
    articleVersion(article) !== null;
  const versions =
    anchors || byVersion
      ? await loadConfirmedVersions(db, article.game, article.region)
      : new Map<string, StoredVersionWindow>();
  return { versions, year: yearless ? yearReferenceOf(article, versions) : null };
}

export interface VersionDerivation {
  readonly proposal: CandidateProposal;
  readonly notes: readonly string[];
  /** 用到的版本行及其版本号；版本时间被改过时与审核员看到的不同，采用时据此 409。 */
  readonly key: string;
  readonly derived: number;
}

/** ADR-0013：说明补出的年份凭什么，写进审核说明。 */
function referenceText(reference: YearReference): string {
  if (reference.source === "article") return `公告里最早写明的日期（${reference.date}）`;
  if (reference.source === "version")
    return `已确认的 ${reference.version} 版本更新开始（${reference.date}）`;
  return `公告发布日期（${reference.date}）`;
}

/**
 * 只改"未定时刻"、依据为 unresolved 的节点：原文整体是版本锚点的按版本时间表推导（ADR-0011），
 * 原文整体是没写年份的日期的按参照日期补全年份（ADR-0013）；其余节点原样保留。
 * 官方写"预计"的（official_estimate）都不推导：推成确定时间会让预计时间进入提醒（主方案 §3.3）。
 */
export function applyVersionDerivations(
  proposal: CandidateProposal,
  context: DerivationContext,
): VersionDerivation {
  const { versions } = context;
  const used = new Map<string, number>();
  const notes = new Set<string>();
  let derived = 0;
  const events = proposal.events.map((event) => ({
    ...event,
    milestones: event.milestones.map((milestone) => {
      if (milestone.time.precision !== "unknown") return milestone;
      const raw = milestone.time.raw_expression;
      if (parseYearlessDate(raw) !== null) {
        if (milestone.time.time_basis === "official_estimate") {
          notes.add(`「${raw}」官方写的是预计时间，不补年份，保持未定时刻。`);
          return milestone;
        }
        if (milestone.time.time_basis !== "unresolved") return milestone;
        const reference = context.year;
        if (reference === null) {
          notes.add(
            `「${raw}」未写年份，公告里没有写明年份的日期，也没有已确认的所属版本更新时间，保持未定时刻。`,
          );
          return milestone;
        }
        if (reference.source === "version" && reference.version !== undefined)
          used.set(reference.version, versions.get(reference.version)?.updatedAt ?? 0);
        const time = completeYear(raw, reference.date, ANNOUNCEMENT_TIMEZONE);
        if (time === null) {
          notes.add(
            `「${raw}」未写年份，按${referenceText(reference)}推不出唯一的年份，保持未定时刻。`,
          );
          return milestone;
        }
        derived++;
        const shown =
          time.precision === "datetime"
            ? `${browseTimestamp(time.utc_ms)}（北京时间）`
            : time.precision === "date"
              ? time.date
              : raw;
        notes.add(`「${raw}」未写年份，按${referenceText(reference)}补全为 ${shown}。`);
        return { ...milestone, time };
      }
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

/**
 * 人工写入的候选：版本锚点与没写年份的日期，要么保持未定，要么与当前推导一致；
 * 不能手填一个时间（或年份）冒充推导或官方明确时间。
 */
export function versionDerivationIssues(
  proposal: CandidateProposal,
  context: DerivationContext,
): string[] {
  const issues: string[] = [];
  proposal.events.forEach((event, eventIndex) => {
    event.milestones.forEach((milestone, milestoneIndex) => {
      if (milestone.time.precision === "unknown") return;
      const raw = milestone.time.raw_expression;
      const anchor = parseVersionAnchor(raw);
      let expected: TimeValue | null;
      if (anchor !== null)
        expected = deriveVersionTime(
          raw,
          context.versions.get(anchor.version),
          ANNOUNCEMENT_TIMEZONE,
        );
      else if (parseYearlessDate(raw) !== null)
        expected =
          context.year === null
            ? null
            : completeYear(raw, context.year.date, ANNOUNCEMENT_TIMEZONE);
      else return;
      if (expected === null || !sameTime(expected, milestone.time))
        issues.push(`$.events[${eventIndex}].milestones[${milestoneIndex}].time`);
    });
  });
  return issues;
}

/** 管线重试发布已批准的人工候选前核对：版本时间表在批准后被改过或清除时，推导值已过期，不能发布。 */
export async function staleVersionDerivation(
  db: D1Database,
  candidate: { readonly proposal: CandidateProposal; readonly articleVersionId: string },
): Promise<boolean> {
  if (!hasVersionAnchor(candidate.proposal) && !hasYearlessDate(candidate.proposal)) return false;
  const article = await loadStoredArticleVersion(db, candidate.articleVersionId);
  const context = await loadDerivationContext(db, article, candidate.proposal);
  return versionDerivationIssues(candidate.proposal, context).length > 0;
}
