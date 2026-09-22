// 文章身份、版本入账与保存（任务卡 P3-02，验收 ID A-P3-ARTICLE）。
//
// 合同依据：主方案 §3.2 后半、§8.1「来源与正文」组——(source_id, external_id) 标识文章、
// 语义内容变化新增**不可变** ArticleVersion（正文块、内容 hash、官方 URL、发布时间、
// 抓取时间、媒体引用、completeness）；表结构由 P1-04 迁移 0001 建立，
// 版本不可变由 trg_article_versions_immutable 触发器保证——本模块只 INSERT，不 UPDATE 版本行。
//
// 红线落点：
//   - **抓取失败不落任何行**：fetchArticle=failed 是"不知道"——不写文章行、不写版本，
//     更不存在任何取消语义；下一批成功再建（列表存在性证据在 P3-01 快照水位里，不在本表）。
//   - **空列表零写入**：没有条目就没有任何 SQL 效果；本模块不提供任何删除/取消类写操作，
//     事件取消只能来自官方取消证据（P3-04 的职责）。
//   - 内容 hash 是版本是否新增的唯一判据：抓取时间等易变噪声不触发新版本。
//   - official_published_at 只接受来源载荷中的真实发布时间（米游社 post.created_at）；
//     公告列表 start_time/end_time 是**展示窗口时间**（§3.1 红线），不写入本字段。
//
// 并发口径：生产写入方是单例 PipelineDO（§2.1 两个固定 DO），顺序执行本函数；
// 若出现并发重放，UNIQUE (article_id, content_hash) 会让后到者整批报错回滚——宁可响亮失败，
// 不静默双版本。

import { buildSourceUrl } from "../adapters/shared";
import type { SourceRegistryEntry } from "../registry";
import { sha256Hex } from "../snapshot-diff";
import type { ArticleFetchResult, SourceItemStub } from "../types";
import {
  type ArticleBodyBlock,
  type ArticleMediaRef,
  articleContentHash,
  bodyHasVisibleText,
  denoiseTitle,
  extractImageRefsFromHtml,
  mergeMediaRefs,
  splitBodyBlocks,
} from "./blocks";
import { type ArticleCompleteness, determineCompleteness } from "./completeness";

/** 一个待保存的文章版本（已判完整性、已算内容 hash）。 */
export interface ArticleVersionPlan {
  readonly sourceId: string;
  readonly externalId: string;
  /** 官方取材端点 URL（由来源注册表派生；无已核验的单篇官方页 URL 模式，不虚构）。 */
  readonly officialUrl: string;
  readonly blocks: readonly ArticleBodyBlock[];
  readonly mediaRefs: readonly ArticleMediaRef[];
  readonly contentHash: string;
  readonly completeness: ArticleCompleteness;
  /** 来源载荷中的真实发布时间（毫秒）或 null（公告 API 无发布时间字段）。 */
  readonly officialPublishedAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly nowMs: number;
}

/** 计划或"本批无内容可记"（抓取失败→不落任何行）。 */
export type ArticleIngestPlan =
  | { readonly kind: "version"; readonly plan: ArticleVersionPlan }
  | { readonly kind: "no-write" };

/** 确定性文章主键：sha256(source_id, external_id)——同一 (source_id, external_id) 恒得同一 id。 */
export async function articleRowId(sourceId: string, externalId: string): Promise<string> {
  return sha256Hex(`${sourceId}\n${externalId}`);
}

/**
 * 官方取材端点 URL：公告源 = 全量正文端点（getAnnContent，该文章正文的实际取得处）；
 * 米游社 = 官方资讯列表端点。单篇官方页 URL 模式未核验（见交付报告已知问题），不虚构。
 */
function officialUrlForEntry(entry: SourceRegistryEntry): string {
  if (entry.adapterKind === "announcement-webview") {
    return buildSourceUrl(
      entry.approvedHosts[0],
      entry.request.contentPath,
      entry.request.listParams,
    );
  }
  return buildSourceUrl(entry.approvedHosts[0], entry.request.listPath, entry.request.listParams);
}

/**
 * 把一次 (列表条目 × 正文抓取) 组装成版本计划（纯函数 + hash 计算，无 DB）。
 * fetched：标题块 + 正文块（保真）+ 正文图片引用；
 * missing-from-content-set：标题块，completeness=gap-content-missing（列表声称有正文但集合缺条）；
 * channel-unavailable：标题块 + 列表图片级引用（封面 + image_list），拿不到 ≠ 空；
 * failed：no-write。
 */
export async function buildArticleIngestPlan(
  entry: SourceRegistryEntry,
  stub: SourceItemStub,
  fetchResult: ArticleFetchResult,
  nowMs: number,
): Promise<ArticleIngestPlan> {
  if (stub.sourceId !== fetchResult.sourceId || stub.externalId !== fetchResult.externalId) {
    throw new Error(
      `条目与抓取结果不匹配：stub(${stub.sourceId}/${stub.externalId}) vs fetch(${fetchResult.sourceId}/${fetchResult.externalId})`,
    );
  }
  if (fetchResult.status === "failed") {
    // 抓取失败 = "不知道"：不落任何行（不建文章行、不产空版本伪装成"官方正文为空"）。
    return { kind: "no-write" };
  }

  const title = denoiseTitle(
    fetchResult.status === "fetched" && fetchResult.title !== "" ? fetchResult.title : stub.title,
  );
  const titleBlock: ArticleBodyBlock = { kind: "title", text: title };

  let blocks: ArticleBodyBlock[];
  let mediaRefs: ArticleMediaRef[];
  let completenessInput: Parameters<typeof determineCompleteness>[0];

  if (fetchResult.status === "fetched") {
    const bodyBlocks = splitBodyBlocks(fetchResult.contentHtml);
    blocks = [titleBlock, ...bodyBlocks];
    mediaRefs = extractImageRefsFromHtml(fetchResult.contentHtml).map((url) => ({
      url,
      origin: "body" as const,
    }));
    completenessInput = {
      bodyAvailability: "fetched",
      bodyTruncated: fetchResult.signals.bodyTruncated,
      contentEmpty: fetchResult.signals.contentEmpty,
      bodyHasText: bodyHasVisibleText(blocks),
      mediaRefCount: mediaRefs.length,
      listClaimsContent: stub.hasContent,
    };
  } else if (fetchResult.status === "channel-unavailable") {
    // 正文通道不可用：只有标题/图片级信息。图片引用（封面 + 列表图）是人工核验的原料。
    blocks = [titleBlock];
    mediaRefs = mergeMediaRefs(
      stub.coverUrl === null ? [] : [{ url: stub.coverUrl, origin: "cover" as const }],
      stub.imageUrls.map((url) => ({ url, origin: "list" as const })),
    );
    completenessInput = {
      bodyAvailability: "channel-unavailable",
      bodyTruncated: false,
      contentEmpty: false,
      bodyHasText: false,
      mediaRefCount: mediaRefs.length,
      listClaimsContent: stub.hasContent,
    };
  } else {
    // missing-from-content-set：列表声称有正文、全量正文集合缺该条——缺口，不是失败。
    blocks = [titleBlock];
    mediaRefs = [];
    completenessInput = {
      bodyAvailability: "content-missing",
      bodyTruncated: false,
      contentEmpty: true,
      bodyHasText: false,
      mediaRefCount: 0,
      listClaimsContent: stub.hasContent,
    };
  }

  return {
    kind: "version",
    plan: {
      sourceId: stub.sourceId,
      externalId: stub.externalId,
      officialUrl: officialUrlForEntry(entry),
      blocks,
      mediaRefs,
      contentHash: await articleContentHash(blocks, mediaRefs),
      completeness: determineCompleteness(completenessInput),
      // 公告 API 条目无发布时间（列表 start_time 是展示窗口，§3.1）；米游社 post.created_at 是真实发布时间。
      officialPublishedAtMs: stub.publishedAtMs,
      fetchedAtMs: fetchResult.status === "fetched" ? fetchResult.fetchedAtMs : nowMs,
      nowMs,
    },
  };
}

/** D1 保存结果：created = 新增了不可变版本；unchanged = 语义内容未变，仅推进复查水位。 */
export type ArticleSaveOutcome = "created" | "unchanged";

/** 存储不变量被破坏（D1 行为回归或并发重放）：编程/平台错误，不是业务失败。 */
export class ArticleStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleStoreInvariantError";
  }
}

/**
 * 保存一个文章版本（单文章原子批次；整批一起生效或一起回滚）：
 *   1. 幂等建文章行（身份 (source_id, external_id)；official_url 首建固定，冲突不覆盖）；
 *   2. 推进 last_checked_at（近期公告复查的落点，§3.2）；
 *   3. 同 hash 版本已存在时不新增（内容 hash 是唯一判据——抓取时间等噪声不触发新版本）。
 * 版本行只 INSERT；任何 UPDATE 由 P1-04 触发器拒绝（不可变）。
 */
export async function saveArticleVersion(
  db: D1Database,
  plan: ArticleVersionPlan,
): Promise<ArticleSaveOutcome> {
  const articleId = await articleRowId(plan.sourceId, plan.externalId);
  const versionId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at, last_checked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO NOTHING`,
      )
      .bind(
        articleId,
        plan.sourceId,
        plan.externalId,
        plan.officialUrl,
        plan.nowMs,
        plan.nowMs,
        plan.nowMs,
        plan.nowMs,
      ),
    db
      .prepare(`UPDATE articles SET last_checked_at = ?, updated_at = ? WHERE id = ?`)
      .bind(plan.nowMs, plan.nowMs, articleId),
    db
      .prepare(
        `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json, media_refs_json, completeness, official_published_at, fetched_at, created_at)
         SELECT ?, ?, COALESCE((SELECT MAX(version_no) + 1 FROM article_versions WHERE article_id = ?), 1), ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND content_hash = ?)`,
      )
      .bind(
        versionId,
        articleId,
        articleId,
        plan.contentHash,
        JSON.stringify(plan.blocks),
        JSON.stringify(plan.mediaRefs),
        plan.completeness,
        plan.officialPublishedAtMs,
        plan.fetchedAtMs,
        plan.nowMs,
        articleId,
        plan.contentHash,
      ),
  ]);

  const ensureChanges = results[1]?.meta?.changes;
  const versionChanges = results[2]?.meta?.changes;
  if (typeof ensureChanges !== "number" || typeof versionChanges !== "number") {
    throw new ArticleStoreInvariantError("D1 未报告 meta.changes，保存判定失去依据");
  }
  if (ensureChanges !== 1) {
    throw new ArticleStoreInvariantError(
      `文章行确保语句命中 ${ensureChanges} 行（期望 1）：(source_id=${plan.sourceId}, external_id=${plan.externalId}) 身份写入失效`,
    );
  }
  return versionChanges === 1 ? "created" : "unchanged";
}

export interface ArticleBatchSaveReport {
  readonly created: number;
  readonly unchanged: number;
  /** no-write 条目数（抓取失败：不落任何行，等待下一批）。 */
  readonly skippedNoWrite: number;
}

/**
 * 顺序保存一批版本计划（单文章一批次，失败隔离：一条坏数据不拖垮整批，报错逐条上抛）。
 * 空数组 = 零 SQL 效果（空列表零写入红线）。
 */
export async function saveArticleVersions(
  db: D1Database,
  plans: readonly ArticleIngestPlan[],
): Promise<ArticleBatchSaveReport> {
  let created = 0;
  let unchanged = 0;
  let skippedNoWrite = 0;
  for (const item of plans) {
    if (item.kind === "no-write") {
      skippedNoWrite += 1;
      continue;
    }
    const outcome = await saveArticleVersion(db, item.plan);
    if (outcome === "created") {
      created += 1;
    } else {
      unchanged += 1;
    }
  }
  return { created, unchanged, skippedNoWrite };
}
