// P3-03 · 从不可变 ArticleVersion 绑定官方来源身份，并对候选证据作纯函数校验。
import { type GameId, GameIdSchema, type RegionId, RegionIdSchema } from "@hoyo/contracts";
import {
  type ArticleBodyBlock,
  type ArticleMediaRef,
  decodeHtmlEntities,
} from "../sources/articles/blocks";
import {
  ARTICLE_COMPLETENESS_STATES,
  type ArticleCompleteness,
} from "../sources/articles/completeness";
import { getSourceEntry } from "../sources/registry";
import {
  type CandidateIssue,
  type CandidateParseResult,
  type CandidateProposal,
  type EvidenceQuote,
  parseCandidateProposal,
} from "./schema";
import { ANNOUNCEMENT_TIMEZONE, parseAnnouncementExactTime } from "./time";

/** 这些字段全部由服务器从存储关联获取；候选输入没有 source_id / article_version。 */
export interface StoredArticleVersion {
  readonly articleVersionId: string;
  readonly articleId: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly officialUrl: string;
  readonly game: GameId;
  readonly region: RegionId;
  readonly verificationState: string;
  readonly completeness: ArticleCompleteness;
  readonly blocks: readonly ArticleBodyBlock[];
  readonly mediaRefs: readonly ArticleMediaRef[];
  /** 来源载荷里的真实发布时间（目前只有米游社有）；ADR-0013 补年份的最后一级参照。 */
  readonly officialPublishedAtMs?: number | null;
}

interface ArticleRow {
  version_id: string;
  article_id: string;
  source_id: string;
  external_id: string;
  official_url: string;
  game: string;
  region: string;
  verification_state: string;
  completeness: string;
  body_blocks_json: string;
  media_refs_json: string;
  official_published_at: number | null;
}

function parseBlocks(json: string): readonly ArticleBodyBlock[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("ArticleVersion 正文块无效");
  for (const block of raw) {
    if (block === null || typeof block !== "object") throw new Error("ArticleVersion 正文块无效");
    if (block.kind === "html") {
      if (typeof block.html !== "string") throw new Error("ArticleVersion HTML 块无效");
    } else if (
      (block.kind === "title" || block.kind === "text") &&
      typeof block.text === "string"
    ) {
      // 合法的保真文本块。
    } else {
      throw new Error("ArticleVersion 正文块类型无效");
    }
  }
  return raw as ArticleBodyBlock[];
}

function parseMediaRefs(json: string): readonly ArticleMediaRef[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("ArticleVersion 媒体引用无效");
  for (const ref of raw) {
    if (
      ref === null ||
      typeof ref !== "object" ||
      typeof ref.url !== "string" ||
      (ref.origin !== "body" && ref.origin !== "cover" && ref.origin !== "list")
    )
      throw new Error("ArticleVersion 媒体引用无效");
  }
  return raw as ArticleMediaRef[];
}

export async function loadStoredArticleVersion(
  db: D1Database,
  articleVersionId: string,
): Promise<StoredArticleVersion> {
  const row = await db
    .prepare(
      `SELECT av.id AS version_id, a.id AS article_id, a.source_id, a.external_id,
              a.official_url, s.game, s.region, s.verification_state,
              av.completeness, av.body_blocks_json, av.media_refs_json, av.official_published_at
         FROM article_versions av
         JOIN articles a ON a.id = av.article_id
         JOIN sources s ON s.source_id = a.source_id
        WHERE av.id = ?`,
    )
    .bind(articleVersionId)
    .first<ArticleRow>();
  if (row === null) throw new Error("ArticleVersion 不存在");
  const registered = getSourceEntry(row.source_id);
  const game = GameIdSchema.parse(row.game);
  const region = RegionIdSchema.parse(row.region.toUpperCase());
  if (game !== registered.game || row.region !== registered.region)
    throw new Error("来源存储与已核验注册项不一致");
  if (!ARTICLE_COMPLETENESS_STATES.includes(row.completeness as ArticleCompleteness)) {
    throw new Error("ArticleVersion 完整性状态无效");
  }
  return {
    articleVersionId: row.version_id,
    articleId: row.article_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    officialUrl: row.official_url,
    game,
    region,
    verificationState: row.verification_state,
    completeness: row.completeness as ArticleCompleteness,
    blocks: parseBlocks(row.body_blocks_json),
    mediaRefs: parseMediaRefs(row.media_refs_json),
    officialPublishedAtMs: row.official_published_at,
  };
}

function evidenceIssues(
  evidence: EvidenceQuote,
  article: StoredArticleVersion,
  path: string,
): CandidateIssue[] {
  const index = Number(evidence.block_ref.slice("blocks/".length));
  const block = article.blocks[index];
  if (block === undefined) return [{ path, message: "引用的正文块不存在" }];
  const raw = block.kind === "html" ? block.html : block.text;
  if (!raw.includes(evidence.quote)) return [{ path, message: "引文不在保存的原始正文块中" }];
  if (evidence.tag !== null) {
    if (block.kind !== "html") return [{ path, message: "时间标签只能引用 HTML 块" }];
    const decoded = decodeHtmlEntities(raw);
    const tags = [...decoded.matchAll(/<t\b[^>]*\bclass=["'](t_gl|t_lc)["'][^>]*>([^<]*)<\/t>/g)];
    if (!tags.some((match) => match[1] === evidence.tag && match[2]?.includes(evidence.quote))) {
      return [{ path, message: "引文不在指定的转义时间标签内" }];
    }
  }
  return [];
}

const OFFICIAL_CANCELLATION_WORDS = /取消|终止|停办|撤销/;

/** 与官方正文逐条核对引用；纯函数，不取模型自报置信度，不读列表展示时间。 */
export function validateCandidateAgainstArticle(
  input: unknown,
  article: StoredArticleVersion,
): CandidateParseResult {
  const parsed = parseCandidateProposal(input);
  if (!parsed.success) return parsed;
  const proposal = parsed.data;
  const issues: CandidateIssue[] = [];
  if (proposal.classification === "no_event" && article.completeness !== "complete") {
    issues.push({ path: "$.classification", message: "缺口版本不能断言无事件" });
  }
  for (const [eventIndex, event] of proposal.events.entries()) {
    const prefix = `$.events[${eventIndex}]`;
    issues.push(...evidenceIssues(event.type_evidence, article, `${prefix}.type_evidence`));
    if (event.status_evidence !== null) {
      issues.push(...evidenceIssues(event.status_evidence, article, `${prefix}.status_evidence`));
    }
    if (event.status === "cancelled") {
      if (article.completeness !== "complete") {
        issues.push({ path: `${prefix}.status`, message: "缺口版本不得产出取消" });
      }
      if (
        event.status_evidence === null ||
        !OFFICIAL_CANCELLATION_WORDS.test(event.status_evidence.quote)
      )
        issues.push({ path: `${prefix}.status_evidence`, message: "取消必须引用官方取消原文" });
    }
    for (const [milestoneIndex, milestone] of event.milestones.entries()) {
      const path = `${prefix}.milestones[${milestoneIndex}]`;
      issues.push(...evidenceIssues(milestone.time_evidence, article, `${path}.time_evidence`));
      const time = milestone.time;
      if (time.precision === "datetime") {
        if (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(time.raw_expression)) {
          issues.push({ path: `${path}.time`, message: "纯日期不得补成精确午夜" });
        }
        if (/版本更新后|更新后开放|预计\s*\d+\s*小时/.test(time.raw_expression)) {
          issues.push({ path: `${path}.time`, message: "相对或预计表达不得猜固定时刻" });
        }
        if (time.source_timezone === ANNOUNCEMENT_TIMEZONE) {
          const parsedTime = parseAnnouncementExactTime(time.raw_expression);
          if (parsedTime !== null && parsedTime.utc_ms !== time.utc_ms) {
            issues.push({ path: `${path}.time.utc_ms`, message: "UTC 毫秒与官方原文时间不一致" });
          }
        }
      }
    }
  }
  return issues.length > 0 ? { success: false, issues } : parsed;
}

export function candidateEvidenceRefs(proposal: CandidateProposal): readonly string[] {
  const refs = new Set<string>();
  for (const event of proposal.events) {
    refs.add(event.type_evidence.block_ref);
    if (event.status_evidence !== null) refs.add(event.status_evidence.block_ref);
    for (const milestone of event.milestones) refs.add(milestone.time_evidence.block_ref);
  }
  return [...refs];
}
