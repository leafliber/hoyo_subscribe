// P3-17 测试专用：真实公告样本入库、规则路径建 uncertain 候选、固定响应的模型替身。
// 不访问官方网络，也不发任何真实推理请求（ENGINEERING.md §4.1 规则 3）。
import { env } from "cloudflare:test";
import { RegionIdSchema } from "@hoyo/contracts";
import { extractArticleVersion } from "../../executors/pipeline/extract";
import {
  denoiseTitle,
  extractImageRefsFromHtml,
  splitBodyBlocks,
} from "../../sources/articles/blocks";
import type { ArticleCompleteness } from "../../sources/articles/completeness";
import { getSourceEntry } from "../../sources/registry";
import { loadStoredArticleVersion, type StoredArticleVersion } from "../article";
import type { DraftModel } from "./draft";
import { readableBlockText } from "./readable";

export const DRAFT_T0 = 1_800_000_000_000;

interface FixtureEntry {
  ann_id: number;
  title: string;
  content: string;
}
export interface FixtureBody {
  body: { data: { list: FixtureEntry[]; pic_list?: FixtureEntry[] } };
}

export function fixtureEntry(fixture: FixtureBody, annId: number): FixtureEntry {
  const entry = [...fixture.body.data.list, ...(fixture.body.data.pic_list ?? [])].find(
    (item) => item.ann_id === annId,
  );
  if (entry === undefined) throw new Error(`fixture 缺 ann_id ${annId}`);
  return entry;
}

/** 内存里的已保存版本，供纯构建测试使用；与入库路径共用分块与标题去噪。 */
export function storedFromFixture(
  sourceId: string,
  entry: FixtureEntry,
  overrides: Partial<StoredArticleVersion> = {},
): StoredArticleVersion {
  const source = getSourceEntry(sourceId);
  return {
    articleVersionId: "synthetic-version",
    articleId: "synthetic-article",
    sourceId,
    externalId: String(entry.ann_id),
    officialUrl: `https://${source.approvedHosts[0]}/`,
    game: source.game,
    region: RegionIdSchema.parse(source.region.toUpperCase()),
    verificationState: source.verificationState,
    completeness: "complete",
    blocks: [{ kind: "title", text: denoiseTitle(entry.title) }, ...splitBodyBlocks(entry.content)],
    mediaRefs: extractImageRefsFromHtml(entry.content).map((url) => ({ url, origin: "body" })),
    ...overrides,
  };
}

async function seedSource(sourceId: string): Promise<void> {
  const entry = getSourceEntry(sourceId);
  await env.DB.prepare(
    `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json, verified_publishers_json,
                          cursor_json, poll_policy_json, verification_state, last_success_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL, ?, ?) ON CONFLICT(source_id) DO NOTHING`,
  )
    .bind(
      entry.sourceId,
      entry.game,
      entry.region,
      entry.adapterId,
      JSON.stringify(entry.approvedHosts),
      JSON.stringify(entry.verifiedPublishers),
      JSON.stringify(entry.pollPolicy),
      entry.verificationState,
      DRAFT_T0,
      DRAFT_T0,
    )
    .run();
}

/** 真实样本入库后走规则路径；规则未命中的公告得到规则入队的 uncertain 待审候选。 */
export async function seedRuleCandidate(
  sourceId: string,
  entry: FixtureEntry,
  options: {
    completeness?: ArticleCompleteness;
    html?: string;
    nowMs?: number;
    /** 载荷里的发布时间；默认取 nowMs。游戏内公告的真实载荷没有发布时间，可传 null。 */
    publishedAtMs?: number | null;
  } = {},
): Promise<{ candidateId: string; versionId: string; article: StoredArticleVersion }> {
  await seedSource(sourceId);
  const source = getSourceEntry(sourceId);
  const html = options.html ?? entry.content;
  const articleId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blocks = [{ kind: "title", text: denoiseTitle(entry.title) }, ...splitBodyBlocks(html)];
  const media = extractImageRefsFromHtml(html).map((url) => ({ url, origin: "body" }));
  const nowMs = options.nowMs ?? DRAFT_T0;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, source_id, external_id, official_url, first_seen_at, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      articleId,
      sourceId,
      `${entry.ann_id}-${articleId.slice(0, 8)}`,
      `https://${source.approvedHosts[0]}/`,
      nowMs,
      nowMs,
      nowMs,
      nowMs,
    ),
    env.DB.prepare(
      `INSERT INTO article_versions (id, article_id, version_no, content_hash, body_blocks_json, media_refs_json,
                                     completeness, official_published_at, fetched_at, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      articleId,
      versionId,
      JSON.stringify(blocks),
      JSON.stringify(media),
      options.completeness ?? "complete",
      options.publishedAtMs === undefined ? nowMs : options.publishedAtMs,
      nowMs,
      nowMs,
    ),
  ]);
  const result = await extractArticleVersion(env.DB, versionId, nowMs);
  return {
    candidateId: result.candidate.candidateId,
    versionId,
    article: await loadStoredArticleVersion(env.DB, versionId),
  };
}

/** OpenAI 形状的同步响应（Workers AI 对该模型的实际返回形状，2026-10-04 实测）。 */
export function modelResponse(
  content: string,
  usage: Record<string, unknown> | null = {
    prompt_tokens: 1219,
    completion_tokens: 221,
    total_tokens: 1440,
    neurons: 12.372289657592773,
  },
  finishReason = "stop",
): unknown {
  return {
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning_content: "\n\n" },
        finish_reason: finishReason,
      },
    ],
    ...(usage === null ? {} : { usage }),
  };
}

export interface FakeAi extends DraftModel {
  readonly calls: { model: string; inputs: Record<string, unknown>; signal: boolean }[];
}

/** 依次返回给定结果；Error 实例按抛出处理。 */
export function fakeAi(...results: unknown[]): FakeAi {
  const calls: FakeAi["calls"] = [];
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs, signal: options?.signal instanceof AbortSignal });
      const next = results.length > 1 ? results.shift() : results[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** 2026-10-04 真实调用的模型输出（原神 21876 卡池公告），用作固定响应。 */
export const GACHA_21876_OUTPUT = JSON.stringify({
  classification: "events",
  ambiguities: [],
  events: [
    {
      event_type: "gacha",
      status: "scheduled",
      title: "「煦风欢舞时」祈愿",
      type_quote: { block: 0, quote: "「煦风欢舞时」祈愿：「雪宴之锋·薇斯纳(风)」概率UP！" },
      status_quote: null,
      milestones: [
        { node_type: "start", label: "", block: 4, time_text: "7.1版本更新后", estimated: false },
        { node_type: "end", label: "", block: 4, time_text: "2026/10/13 17:59", estimated: false },
      ],
    },
  ],
});

/** 2026-10-04 真实调用的模型输出（原神 21928 维护预告）：模型自行推算出原文没有的 11:00。 */
export const MAINTENANCE_21928_OUTPUT = JSON.stringify({
  classification: "events",
  ambiguities: [],
  events: [
    {
      event_type: "maintenance",
      status: "scheduled",
      title: "7.1版本更新维护",
      type_quote: { block: 0, quote: "7.1版本更新维护预告" },
      status_quote: null,
      milestones: [
        {
          node_type: "start",
          label: "",
          block: 2,
          time_text: "2026/09/23 06:00",
          estimated: false,
        },
        { node_type: "end", label: "", block: 6, time_text: "2026/09/23 11:00", estimated: true },
        {
          node_type: "reward_deadline",
          label: "",
          block: 11,
          time_text: "7.1版本结束前",
          estimated: false,
        },
      ],
    },
  ],
});

/**
 * 整篇版本公告的模型输出替身（ADR-0012）：正文里每条"活动时间：起 ~ 止"各出一个事件，
 * 块号取真实块号；版本更新说明一篇十几个活动，整份候选超过请求体上限。
 */
export function versionNoteOutput(article: StoredArticleVersion): string {
  const point = (raw: string) => /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.exec(raw)?.[0] ?? raw.trim();
  const events = article.blocks.flatMap((block, index) => {
    const match = /活动时间：(.+?) ~ (.+)$/.exec(readableBlockText(block));
    if (match === null) return [];
    return [
      {
        event_type: "limited_event",
        status: "scheduled",
        title: `合成版本活动 ${index}`,
        type_quote: null,
        status_quote: null,
        milestones: [
          {
            node_type: "start",
            label: "",
            block: index,
            time_text: point(match[1]),
            estimated: false,
          },
          {
            node_type: "end",
            label: "",
            block: index,
            time_text: point(match[2]),
            estimated: false,
          },
        ],
      },
    ];
  });
  return JSON.stringify({
    classification: "events",
    ambiguities: [],
    version_window: null,
    events,
  });
}
