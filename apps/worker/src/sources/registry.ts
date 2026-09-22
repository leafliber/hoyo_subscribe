// 来源注册项（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 合同依据：主方案 §3.1——来源注册项包含 source_id、game、region、adapter、approved_hosts、
// verified_publishers、cursor、poll_policy、last_success_at、verification_state；上游 ID 存字符串；
// 生产只访问经审核的官方地址。
//
// 单一来源链（AGENTS.md 硬规则 2）：
//   - 轮询/复查间隔：@hoyo/contracts 参数注册表（SOURCE_POLL/SOURCE_HOT_POLL/
//     SOURCE_RECHECK_WINDOW/SOURCE_RECHECK_INTERVAL），本文件不写第二份数值。
//   - 来源事实与请求限制：fixtures/sources/registry.draft.json（P0-02 登记草案）与
//     scripts/probes/source-samples/sources.verified.json（已核验请求参数集）。
//     生产代码不 import 探针目录，故在此转录为类型化常量；registry.test.ts 导入两份
//     原始 JSON 做逐字段漂移校验——转录与登记不一致即测试失败（沿 P1-04 expected-schema 同步约定）。
//   - 公告 API 的内容门控参数（level + 登出态哑 uid=100000000）已由所有者批准（ADR-0001），
//     沿用登记参数集，不自行调整。
//
// verified_publishers 为空数组是 P0-02 实测结论（公告条目无发布者 UID 字段；米游社列表
// uid="0" 不携带身份），来源身份由官方域名承载——照搬，不"补全"。

import type { GameId } from "@hoyo/contracts";
import {
  SOURCE_HOT_POLL,
  SOURCE_POLL,
  SOURCE_RECHECK_INTERVAL,
  SOURCE_RECHECK_WINDOW,
} from "@hoyo/contracts";
import type { MiyousheNewsType } from "./types";

/** 每来源请求限制：数值逐项来自 registry.draft.json 的 limit_profile_measured（漂移测试锁定）。 */
export interface SourceRequestLimits {
  /** request_timeout_recommend_ms（四来源实测一致 10,000 ms）。 */
  readonly timeoutMs: number;
  /**
   * 响应体上限 = 该来源实测最大响应：公告源取 max_observed_content_bytes；
   * 米游社正文通道被停用，取列表实测上界 list_response_bytes_observed_range 的最大值。
   * 超限不是错误放宽的理由，而是重新实测并更新登记的信号。
   */
  readonly maxResponseBytes: number;
  /** 单请求批量上限：米游社 page_size 实测回落值 20；公告源无按页截断 → null。 */
  readonly listPageSizeCap: number | null;
}

/** 公告 API 请求形状（sources.verified.json sources[].list/content，参数集不自行调整）。 */
export interface AnnouncementRequestProfile {
  readonly listPath: string;
  readonly listParams: Readonly<Record<string, string>>;
  /** 与 P0-02 已核验请求形状一致的分页参数（服务端忽略；登记见 index.json list_observation）。 */
  readonly paginationParams: Readonly<Record<string, string>>;
  /**
   * 正文端点路径。getAnnContent 忽略 announcement_id、单次返回全部正文（P0-02 §2.2），
   * 因此请求**不带**单篇参数——不存在单篇通道，复查即全量重拉。
   */
  readonly contentPath: string;
}

/** 米游社请求形状（gids=2 原神；type/last_id/page_size 由适配器按游标与上限拼装）。 */
export interface MiyousheRequestProfile {
  readonly listPath: string;
  readonly listParams: Readonly<Record<string, string>>;
}

interface SourceRegistryEntryBase {
  readonly sourceId: string;
  readonly game: GameId;
  readonly region: "cn";
  /** registry.draft.json adapter 字段的前缀（实现名）。 */
  readonly adapterId: string;
  readonly approvedHosts: readonly string[];
  /** 实测为空（见文件头）；类型保持 string[] 以承载未来真实核验的发布者。 */
  readonly verifiedPublishers: readonly string[];
  readonly pollPolicy: {
    readonly pollIntervalS: number;
    readonly hotPollIntervalS: number;
    /** 近期公告复查窗口/间隔（SOURCE_RECHECK_WINDOW / SOURCE_RECHECK_INTERVAL）。米游社未登记复查 → null。 */
    readonly recheckWindowDays: number | null;
    readonly recheckIntervalS: number | null;
  };
  readonly verificationState: "verified-working" | "maintenance-required-list-only";
  /** 正文通道被访问控制停用（verification_state 推导，米游社 403 后为 true）。 */
  readonly contentChannelDisabled: boolean;
  readonly lastSuccessAtUtc: string;
  readonly requestLimits: SourceRequestLimits;
}

export interface AnnouncementSourceEntry extends SourceRegistryEntryBase {
  readonly adapterKind: "announcement-webview";
  readonly cursorModel: "full-snapshot-per-request";
  readonly externalIdField: "ann_id";
  readonly request: AnnouncementRequestProfile;
}

export interface MiyousheNewsSourceEntry extends SourceRegistryEntryBase {
  readonly adapterKind: "miyoushe-painter-news";
  readonly cursorModel: "last-id-offset";
  readonly externalIdField: "post_id";
  readonly request: MiyousheRequestProfile;
  /** 列表三类型各自独立游标（registry.draft.json poll_policy.basis）。 */
  readonly newsTypes: readonly MiyousheNewsType[];
}

export type SourceRegistryEntry = AnnouncementSourceEntry | MiyousheNewsSourceEntry;

const ANNOUNCEMENT_POLL_POLICY = {
  pollIntervalS: SOURCE_POLL,
  hotPollIntervalS: SOURCE_HOT_POLL,
  recheckWindowDays: SOURCE_RECHECK_WINDOW,
  recheckIntervalS: SOURCE_RECHECK_INTERVAL,
} as const;

const GENSHIN_ANN: AnnouncementSourceEntry = {
  sourceId: "genshin-ann",
  game: "genshin",
  region: "cn",
  adapterId: "announcement-webview-hk4e",
  adapterKind: "announcement-webview",
  approvedHosts: ["hk4e-ann-api.mihoyo.com"],
  verifiedPublishers: [],
  cursorModel: "full-snapshot-per-request",
  externalIdField: "ann_id",
  pollPolicy: ANNOUNCEMENT_POLL_POLICY,
  verificationState: "verified-working",
  contentChannelDisabled: false,
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: { timeoutMs: 10_000, maxResponseBytes: 254_672, listPageSizeCap: null },
  request: {
    listPath: "/common/hk4e_cn/announcement/api/getAnnList",
    listParams: {
      game: "hk4e",
      game_biz: "hk4e_cn",
      bundle_id: "hk4e_cn",
      channel_id: "1",
      lang: "zh-cn",
      level: "60",
      platform: "pc",
      region: "cn_gf01",
      uid: "100000000",
    },
    paginationParams: { page: "1", page_size: "20" },
    contentPath: "/common/hk4e_cn/announcement/api/getAnnContent",
  },
};

const HSR_ANN: AnnouncementSourceEntry = {
  sourceId: "hsr-ann",
  game: "hsr",
  region: "cn",
  adapterId: "announcement-webview-hkrpg",
  adapterKind: "announcement-webview",
  approvedHosts: ["hkrpg-ann-api.mihoyo.com"],
  verifiedPublishers: [],
  cursorModel: "full-snapshot-per-request",
  externalIdField: "ann_id",
  pollPolicy: ANNOUNCEMENT_POLL_POLICY,
  verificationState: "verified-working",
  contentChannelDisabled: false,
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: { timeoutMs: 10_000, maxResponseBytes: 195_598, listPageSizeCap: null },
  request: {
    listPath: "/common/hkrpg_cn/announcement/api/getAnnList",
    listParams: {
      game: "hkrpg",
      game_biz: "hkrpg_cn",
      bundle_id: "hkrpg_cn",
      channel_id: "1",
      lang: "zh-cn",
      level: "70",
      platform: "pc",
      region: "prod_gf_cn",
      uid: "100000000",
    },
    paginationParams: { page: "1", page_size: "20" },
    contentPath: "/common/hkrpg_cn/announcement/api/getAnnContent",
  },
};

const ZZZ_ANN: AnnouncementSourceEntry = {
  sourceId: "zzz-ann",
  game: "zzz",
  region: "cn",
  adapterId: "announcement-webview-nap",
  adapterKind: "announcement-webview",
  approvedHosts: ["announcement-api.mihoyo.com"],
  verifiedPublishers: [],
  cursorModel: "full-snapshot-per-request",
  externalIdField: "ann_id",
  pollPolicy: ANNOUNCEMENT_POLL_POLICY,
  verificationState: "verified-working",
  contentChannelDisabled: false,
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: { timeoutMs: 10_000, maxResponseBytes: 153_329, listPageSizeCap: null },
  request: {
    listPath: "/common/nap_cn/announcement/api/getAnnList",
    listParams: {
      game: "nap",
      game_biz: "nap_cn",
      bundle_id: "nap_cn",
      channel_id: "1",
      lang: "zh-cn",
      level: "60",
      platform: "pc",
      region: "prod_gf_cn",
      uid: "100000000",
    },
    paginationParams: { page: "1", page_size: "20" },
    contentPath: "/common/nap_cn/announcement/api/getAnnContent",
  },
};

const MIYOUSHE_NEWS: MiyousheNewsSourceEntry = {
  sourceId: "miyoushe-news",
  game: "genshin",
  region: "cn",
  adapterId: "miyoushe-painter-news",
  adapterKind: "miyoushe-painter-news",
  approvedHosts: ["bbs-api-static.miyoushe.com", "bbs-api.miyoushe.com"],
  verifiedPublishers: [],
  cursorModel: "last-id-offset",
  externalIdField: "post_id",
  pollPolicy: {
    pollIntervalS: SOURCE_POLL,
    hotPollIntervalS: SOURCE_HOT_POLL,
    recheckWindowDays: null,
    recheckIntervalS: null,
  },
  verificationState: "maintenance-required-list-only",
  // getPostFull 对诚实探针 UA、无凭据、单次请求返回 403（P0-02 §3）：停用正文通道并标维护，
  // 不重试、不换路径、不伪装 UA、不用第三方聚合后端（AGENTS.md 规则 6）。
  contentChannelDisabled: true,
  lastSuccessAtUtc: "2026-09-21T17:43:50Z",
  requestLimits: { timeoutMs: 10_000, maxResponseBytes: 110_546, listPageSizeCap: 20 },
  request: { listPath: "/painter/wapi/getNewsList", listParams: { gids: "2" } },
  newsTypes: ["1", "2", "3"],
};

/** 正式来源注册表：四来源（三公告 + 米游社），事实来自 P0-02 登记。 */
export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  GENSHIN_ANN,
  HSR_ANN,
  ZZZ_ANN,
  MIYOUSHE_NEWS,
];

export function listSourceEntries(): readonly SourceRegistryEntry[] {
  return SOURCE_REGISTRY;
}

export function getSourceEntry(sourceId: string): SourceRegistryEntry {
  const entry = SOURCE_REGISTRY.find((candidate) => candidate.sourceId === sourceId);
  if (entry === undefined) {
    throw new Error(`未知来源 ${sourceId}：不在注册表内（P0-02 登记）`);
  }
  return entry;
}
