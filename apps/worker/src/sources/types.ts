// 来源适配器接口（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 合同依据：主方案 §3.1——适配器提供 list(cursor, limit) → items/next_cursor/complete
// 与 fetchArticle(stub)；complete 表示**扫描范围真的完成**，HTTP 成功不等于正文完整；
// 上游 ID 存字符串；生产只访问经审核的官方地址。
//
// 两类采集模型并存（P0-02 实测推翻了统一的分页假设，证据
// docs/evidence/p0/source-params.md §2/§3）：
//   - announcement（三公告 API）：每请求全量快照，服务端忽略分页参数；
//     "重叠窗口"体现为每次与上次 ann_id 集合整体差分（§3.2 不按最大 ID 推进水位）。
//   - miyoushe-news：last-id-offset 偏移量游标（非帖子 id），响应带 is_last；
//     正文通道 getPostFull 被 403 访问控制拦截，按 maintenance-required-list-only 登记，
//     适配器只贡献标题/图片级信息，fetchArticle 不发任何请求（AGENTS.md 规则 6：不绕过）。

/** 来源的游标模型（registry.draft.json sources[].cursor.model 的类型化投影）。 */
export type CursorModel = "full-snapshot-per-request" | "last-id-offset";

/** 米游社列表三类型（线上 bundle 枚举 I={DEFAULT:"1",EVENT:"2",NEWS:"3"}，P0-02 登记）；各自独立游标。 */
export type MiyousheNewsType = "1" | "2" | "3";

export const MIYOUSHE_NEWS_TYPES: readonly MiyousheNewsType[] = ["1", "2", "3"];

/** 全量快照型游标：单请求即全集，无续扫位置。 */
export interface FullSnapshotCursor {
  readonly model: "full-snapshot-per-request";
}

/** 米游社偏移量游标：last_id 是偏移量（page_size=20 时 20/40/60 递进），不是帖子 id。 */
export interface LastIdOffsetCursor {
  readonly model: "last-id-offset";
  readonly newsType: MiyousheNewsType;
  readonly lastId: string;
}

export type SourceCursor = FullSnapshotCursor | LastIdOffsetCursor;

/**
 * 列表条目（标题级）。字段保真、不在此层去噪：
 * zzz 的 title 含 HTML（P0-02 发现 5），剥离与规范化属 P3-02；
 * 列表 start_time/end_time 是**展示时间**（UTC+8），不是活动时间（§3.1 红线）。
 */
export interface SourceItemStub {
  readonly sourceId: string;
  /** 上游 ID，一律字符串（§3.1）。公告 API 的 ann_id 是 JSON number，入口处立即 String()。 */
  readonly externalId: string;
  /** 标题原文（zzz 含 HTML 标签；P3-02 负责去噪）。 */
  readonly title: string;
  readonly subtitle: string | null;
  /** 公告栏目 type_label；米游社无此概念。 */
  readonly typeLabel: string | null;
  readonly tagLabel: string | null;
  /** 列表展示时间原文（UTC+8）。仅用于复查窗口筛选，不得当活动时间（§3.1）。 */
  readonly listStartTime: string | null;
  readonly listEndTime: string | null;
  readonly bannerUrl: string | null;
  readonly coverUrl: string | null;
  readonly imageUrls: readonly string[];
  /**
   * 发布者 UID 或 null。公告 API 条目无发布者字段；米游社列表条目 uid="0"
   * 不携带身份（P0-02 §3）——verified_publishers 为空是实测结论，不得"补全"。
   */
  readonly publisherUid: string | null;
  /** 公告列表 has_content（列表声称是否有正文）；米游社正文通道维护态 → null，不声称。 */
  readonly hasContent: boolean | null;
  /** 米游社 created_at（Epoch 秒 ×1000）；公告无此字段 → null。 */
  readonly publishedAtMs: number | null;
}

/** 业务信封信息（公告/米游社响应顶层 retcode/message + data 元信息）。 */
export interface ListEnvelopeInfo {
  readonly retcode: number;
  readonly message: string | null;
  /** 公告 API 实测 = 8：列表 start_time/end_time 为 UTC+8 本地时间（P0-02 §2.4）。 */
  readonly timezone: number | null;
  readonly total: number | null;
  /** 公告列表按 type 分组的栏目标签（随运营配置变化，仅观测）。 */
  readonly typeLabels: readonly string[];
}

/** 失败分类。restricted = 鉴权/验证码/访问控制信号 → 调用方停用来源并标维护，不重试、不换路径。 */
export type SourceFetchFailure =
  | { kind: "business-rejected"; retcode: number; message: string | null }
  | { kind: "restricted"; status: number; signals: readonly string[] }
  | { kind: "rate-limited"; status: number }
  | { kind: "redirect-not-followed"; status: number; location: string | null }
  | { kind: "timeout" }
  | { kind: "response-too-large"; bytes: number; cap: number }
  | { kind: "bad-content-type"; contentType: string | null }
  | { kind: "malformed-body"; detail: string }
  | { kind: "network-error"; name: string }
  | { kind: "guard-rejected"; code: string; detail: string };

export interface ListResult {
  readonly items: readonly SourceItemStub[];
  readonly nextCursor: SourceCursor | null;
  /** 扫描范围真的完成（≠ HTTP 成功）：信封 retcode=0 且本游标段读尽（is_last / 全量到达）。 */
  readonly complete: boolean;
  readonly envelope: ListEnvelopeInfo | null;
  readonly failure: SourceFetchFailure | null;
  /** 缺 external_id 等无法建键的条目数（不丢 silently，计数上报；不视为扫描失败）。 */
  readonly skippedItems: number;
}

/** fetchArticle 的最小定位信息。 */
export interface ArticleRef {
  readonly sourceId: string;
  readonly externalId: string;
  readonly title?: string;
}

/**
 * 完整性信号原料（缺口状态判定属 P3-02，本卡只把信号传出去）：
 * HTTP 成功 ≠ 正文完整——正文截断、图片承载关键日期、来源暂空都要能标记。
 */
export interface ArticleCompletenessSignals {
  /** 正文为空串/缺字段（"来源暂空"信号）。 */
  readonly contentEmpty: boolean;
  /** 正文 <img> 引用数（"图片承载关键日期"的原料）。 */
  readonly imageCount: number;
  /** 正文 UTF-8 字节数。 */
  readonly contentBytes: number;
  /** 响应体读取被上限截断（"正文截断"信号；JSON 未受损时才可能走到这里）。 */
  readonly bodyTruncated: boolean;
}

export type ArticleFetchResult =
  | {
      status: "fetched";
      sourceId: string;
      externalId: string;
      title: string;
      /** 正文 HTML 原文，保留官方转义标签（&lt;t class="t_gl"&gt; 时间高亮，P0-02 §2.3）。 */
      contentHtml: string;
      contentSha256: string;
      signals: ArticleCompletenessSignals;
      fetchedAtMs: number;
    }
  | {
      /** 列表声称有正文，但全量正文响应里找不到该条（缺口的原料，不是失败）。 */
      status: "missing-from-content-set";
      sourceId: string;
      externalId: string;
      note: string;
    }
  | {
      /** 正文通道被停用（米游社 getPostFull 403 访问控制，P0-02 §3）——不重试、不换路径、不发请求。 */
      status: "channel-unavailable";
      sourceId: string;
      externalId: string;
      reason: string;
    }
  | { status: "failed"; sourceId: string; externalId: string; failure: SourceFetchFailure };

/** 来源适配器（§3.1）。实现不得自带重试；被限/被拒的分类经 failure 交给调用方决策。 */
export interface SourceAdapter {
  readonly sourceId: string;
  /**
   * 全量快照型：cursor 仅接受 null 或同模型标记（每请求即全集，无续扫），limit 不会
   * 截断条目——截断=丢条目=伪造"消失"；每批上限由调用方按 limit_profile 控制。
   * 米游社：cursor=null 从头开始；limit 映射 page_size 并被限制在实测批量上限内。
   */
  list(cursor: SourceCursor | null, limit: number): Promise<ListResult>;
  fetchArticle(ref: ArticleRef): Promise<ArticleFetchResult>;
}
