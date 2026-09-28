// P3-03 · PipelineDO 可调用的抽取入口。模型路径只定义端口；P3-09 才能实现调用与账本。
import { AI_BILLING_PROFILE_CONFIGURED } from "@hoyo/contracts";
import { loadStoredArticleVersion } from "../../extraction/article";
import { extractByRules } from "../../extraction/rules";
import { type RuleCandidateResult, storeRuleCandidate } from "../../extraction/service";
import type { ArticleBodyBlock } from "../../sources/articles/blocks";

/** P3-09 的输入边界：只有官方正文块，无用户数据、凭据、网络或写库能力。 */
export interface ModelExtractionPort {
  propose(blocks: readonly ArticleBodyBlock[]): Promise<unknown>;
}

/** 规则未命中时，在模型计费 profile 未配置的当前状态下一律进人工审核队列。 */
export async function extractArticleVersion(
  db: D1Database,
  articleVersionId: string,
  nowMs: number,
  modelPort: ModelExtractionPort | null = null,
): Promise<RuleCandidateResult> {
  const article = await loadStoredArticleVersion(db, articleVersionId);
  const rule = extractByRules(article);
  if (rule.kind === "ready_for_publication") {
    return storeRuleCandidate(db, article, rule, nowMs);
  }
  if (!AI_BILLING_PROFILE_CONFIGURED) {
    return storeRuleCandidate(db, article, rule, nowMs);
  }
  // 即使未来参数被配置，本轮也不持有预算账本，不能擅自触发调用。
  // P3-09 在此端口接入预占、重试、Schema 校验与人工锁保护。
  void modelPort;
  return storeRuleCandidate(db, article, rule, nowMs);
}
