// 来源适配器接口（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 合同依据：主方案 §3.1——适配器提供 list(cursor, limit) → items/next_cursor/complete
// 与 fetchArticle(stub)；complete 表示**扫描范围真的完成**，HTTP 成功不等于正文完整；
// 上游 ID 存字符串；生产只访问经审核的官方地址。
//
// 采集模型（P0-02 实测推翻了统一的分页假设，证据 docs/evidence/p0/source-params.md §2）：
// 三公告 API 每请求全量快照，服务端忽略分页参数；"重叠窗口"体现为每次与上次 ann_id 集合
// 整体差分（§3.2 不按最大 ID 推进水位）。米游社的偏移量游标模型随来源下线删除（ADR-0016）。

/** 来源的游标模型（registry.draft.json sources[].cursor.model 的类型化投影）。 */
export type CursorModel = "full-snapshot-per-request";

/** 全量快照型游标：单请求即全集，无续扫位置。 */
export interface FullSnapshotCursor {
  readonly model: "full-snapshot-per-request";
}

export type SourceCursor = FullSnapshotCursor;

/**
 * 列表条目（标题级）。字段保真、不在此层去噪：
 * zzz 的 title 含 HTML（P0-02 发现 5），剥离与规范化属 P3-02；
 * 列表 start_time/end_time 是**展示时间**（UTC+8），不是活动时间（§3.1 红线）。
 */
export interface SourceItemStub {
  readonly sourceId: string;
  /**
   * 上游 ID，一律字符串（§3.1）。公告 API 的 ann_id 是 JSON number，入口处立即 String()；
   * 图文资讯目录（data.pic_list）的条目加 "pic-" 前缀，与 data.list 分开编号（ADR-0016）。
   */
  readonly externalId: string;
  /** 标题原文（zzz 含 HTML 标签；P3-02 负责去噪）。 */
  readonly title: string;
  readonly subtitle: string | null;
  /** 公告栏目 type_label（如「活动公告」「资讯」）。 */
  readonly typeLabel: string | null;
  readonly tagLabel: string | null;
  /** 列表展示时间原文（UTC+8）。仅用于复查窗口筛选，不得当活动时间（§3.1）。 */
  readonly listStartTime: string | null;
  readonly listEndTime: string | null;
  readonly bannerUrl: string | null;
  readonly coverUrl: string | null;
  readonly imageUrls: readonly string[];
  /**
   * 发布者 UID 或 null。公告 API 条目无发布者字段（P0-02）——verified_publishers 为空是
   * 实测结论，不得"补全"。
   */
  readonly publisherUid: string | null;
  /** 公告列表 has_content（列表声称是否有正文）；缺字段 → null，不声称。 */
  readonly hasContent: boolean | null;
  /** 来源载荷里的真实发布时间（Epoch 毫秒）。公告 API 条目没有这个字段 → null。 */
  readonly publishedAtMs: number | null;
}

/** 业务信封信息（公告响应顶层 retcode/message + data 元信息）。 */
export interface ListEnvelopeInfo {
  readonly retcode: number;
  readonly message: string | null;
  /** 公告 API 实测 = 8：列表 start_time/end_time 为 UTC+8 本地时间（P0-02 §2.4）。 */
  readonly timezone: number | null;
  /** data.total：只计 data.list，不含图文资讯目录（data.pic_total 另计）。 */
  readonly total: number | null;
  /** 两个目录的栏目标签（data.list[].type_label 与 data.pic_list[].type_label；随运营配置变化，仅观测）。 */
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
      /** 响应超上限，JSON 不可解析；只准使用已获得的列表条目构造缺口，不能保存截断正文。 */
      status: "truncated";
      sourceId: string;
      externalId: string;
      /** 已读到的字节数下界和配置上限，只用于诊断，不包含响应体。 */
      observedAtLeastBytes: number;
      capBytes: number;
    }
  | {
      /** 列表声称有正文，但全量正文响应里找不到该条（缺口的原料，不是失败）。 */
      status: "missing-from-content-set";
      sourceId: string;
      externalId: string;
      note: string;
    }
  | { status: "failed"; sourceId: string; externalId: string; failure: SourceFetchFailure };

/** 来源适配器（§3.1）。实现不得自带重试；被限/被拒的分类经 failure 交给调用方决策。 */
export interface SourceAdapter {
  readonly sourceId: string;
  /**
   * 全量快照型：cursor 仅接受 null 或同模型标记（每请求即全集，无续扫），limit 不会
   * 截断条目——截断=丢条目=伪造"消失"；每批上限由调用方按 limit_profile 控制。
   */
  list(cursor: SourceCursor | null, limit: number): Promise<ListResult>;
  fetchArticle(ref: ArticleRef): Promise<ArticleFetchResult>;
}
