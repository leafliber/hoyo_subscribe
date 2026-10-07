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
// verified_publishers 为空数组是 P0-02 实测结论（公告条目无发布者 UID 字段），
// 来源身份由官方域名承载——照搬，不"补全"。
//
// ADR-0016：米游社官方资讯（miyoushe-news）已下线——正文接口受访问控制、只有列表，
// 版本公告与活动正文由游戏内公告覆盖。P0-02 登记与样本作为历史证据保留，不再注册。
// ADR-0030：另登记三个直播兑换码来源（米游社首页发现直播活动 + 官方直播页的兑换码接口），
// 事实与样本在 fixtures/sources/miyolive/；它们只产出兑换码，不是日程公告。

import type { GameId } from "@hoyo/contracts";
import {
  SOURCE_HOT_POLL,
  SOURCE_LIMIT_PROFILE,
  SOURCE_POLL,
  SOURCE_RECHECK_INTERVAL,
  SOURCE_RECHECK_WINDOW,
} from "@hoyo/contracts";

/** 来源请求限制：实测项来自 P0-02 登记；生产上限来自 SOURCE_LIMIT_PROFILE。 */
export interface SourceRequestLimits {
  readonly onTruncated?: (host: string) => Promise<void>;
  /** request_timeout_recommend_ms（各来源实测一致 10,000 ms）。 */
  readonly timeoutMs: number;
  /**
   * 生产响应上限取 SOURCE_LIMIT_PROFILE.responseCapsBytes，区别于观测峰值。
   * 公告源：观测全集 + 20 条（已核验 page_size 的一批）的观测平均体积 + 一条最大观测
   * 正文的体积，最后进位到 64 KiB。最大单条按原始响应/样本 JSON 比例折算，覆盖新批中
   * 一条较大的公告；超过一批或更大单条由截断缺口+告警处理，不自动抬限。
   * 观测体积是整份响应（含 data.pic_list），读取 pic_list 不改变上限（ADR-0016）。
   * 一律不得超过 SOURCE_LIMIT_PROFILE.responseCapCeilingBytes（512 KiB）。
   * 这只提高一次既有请求的读体界，不增加请求次数或引入新计量项。
   */
  readonly maxResponseBytes: number;
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

export interface AnnouncementSourceEntry {
  readonly sourceId: string;
  readonly game: GameId;
  readonly region: "cn";
  /** registry.draft.json adapter 字段的前缀（实现名）。 */
  readonly adapterId: string;
  readonly adapterKind: "announcement-webview";
  readonly approvedHosts: readonly string[];
  /** 实测为空（见文件头）；类型保持 string[] 以承载未来真实核验的发布者。 */
  readonly verifiedPublishers: readonly string[];
  readonly cursorModel: "full-snapshot-per-request";
  readonly externalIdField: "ann_id";
  readonly pollPolicy: {
    readonly pollIntervalS: number;
    readonly hotPollIntervalS: number;
    /** 近期公告复查窗口/间隔（SOURCE_RECHECK_WINDOW / SOURCE_RECHECK_INTERVAL）。 */
    readonly recheckWindowDays: number;
    readonly recheckIntervalS: number;
  };
  readonly verificationState: "verified-working";
  readonly lastSuccessAtUtc: string;
  readonly requestLimits: SourceRequestLimits;
  readonly request: AnnouncementRequestProfile;
}

/**
 * ADR-0030 米游社直播兑换码来源的请求形状。接口取自米游社官方直播页前端（定位用），数据全部直连官方端点：
 * - 发现：米游社首页接口（直播卡片、导航与轮播里的官方直播页链接带活动 ID）；
 * - 活动：直播页的 index 接口（请求头 x-rpc-act_id）给出直播标题、code_ver 与页面模板（有效期说明在模板里）；
 * - 兑换码：CDN 上的 refreshCode（参数 version=code_ver、time=按 20 秒取整的秒数，同官方页面）。
 * 官方直播页只作展示链接，本站不请求它。
 */
export interface MiyoliveRequestProfile {
  readonly discovery: {
    readonly host: string;
    readonly path: string;
    readonly params: Readonly<Record<string, string>>;
  };
  readonly index: { readonly host: string; readonly path: string };
  readonly codes: { readonly host: string; readonly path: string };
  readonly livePage: string;
}

export interface MiyoliveSourceEntry {
  readonly sourceId: string;
  readonly game: GameId;
  readonly region: "cn";
  readonly adapterId: string;
  readonly adapterKind: "miyolive";
  readonly approvedHosts: readonly string[];
  readonly verifiedPublishers: readonly string[];
  readonly cursorModel: "full-snapshot-per-request";
  readonly externalIdField: "act_id";
  readonly pollPolicy: AnnouncementSourceEntry["pollPolicy"];
  readonly verificationState: "verified-working";
  readonly lastSuccessAtUtc: string;
  readonly requestLimits: SourceRequestLimits;
  readonly request: MiyoliveRequestProfile;
  /** ADR-0030：不是个人日历的所需来源（contracts requiredCalendarSources）。 */
  readonly freshnessExempt: true;
}

/** 游戏内公告源（ADR-0016）与直播兑换码来源（ADR-0030）。 */
export type SourceRegistryEntry = AnnouncementSourceEntry | MiyoliveSourceEntry;

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
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: {
    timeoutMs: 10_000,
    maxResponseBytes: SOURCE_LIMIT_PROFILE.responseCapsBytes["genshin-ann"],
  },
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
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: {
    timeoutMs: 10_000,
    maxResponseBytes: SOURCE_LIMIT_PROFILE.responseCapsBytes["hsr-ann"],
  },
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
  lastSuccessAtUtc: "2026-09-21T17:41:54Z",
  requestLimits: {
    timeoutMs: 10_000,
    maxResponseBytes: SOURCE_LIMIT_PROFILE.responseCapsBytes["zzz-ann"],
  },
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

const LIVE_HOSTS = [
  "bbs-api.miyoushe.com",
  "api-takumi.mihoyo.com",
  "api-takumi-static.mihoyo.com",
];

/** ADR-0030：三个游戏的直播兑换码来源；事实登记见 fixtures/sources/miyolive/registry.json。 */
function liveEntry(
  sourceId: "genshin-live" | "hsr-live" | "zzz-live",
  game: GameId,
  gids: string,
  lastSuccessAtUtc: string,
): MiyoliveSourceEntry {
  return {
    sourceId,
    game,
    region: "cn",
    adapterId: "miyolive-redeem-codes",
    adapterKind: "miyolive",
    approvedHosts: LIVE_HOSTS,
    verifiedPublishers: [],
    cursorModel: "full-snapshot-per-request",
    externalIdField: "act_id",
    pollPolicy: ANNOUNCEMENT_POLL_POLICY,
    verificationState: "verified-working",
    lastSuccessAtUtc,
    requestLimits: {
      timeoutMs: 10_000,
      maxResponseBytes: SOURCE_LIMIT_PROFILE.responseCapsBytes[sourceId],
    },
    request: {
      discovery: { host: "bbs-api.miyoushe.com", path: "/apihub/api/home/new", params: { gids } },
      index: { host: "api-takumi.mihoyo.com", path: "/event/miyolive/index" },
      codes: { host: "api-takumi-static.mihoyo.com", path: "/event/miyolive/refreshCode" },
      livePage: "https://webstatic.mihoyo.com/bbs/event/live/index.html",
    },
    freshnessExempt: true,
  };
}

/** 正式来源注册表：三个游戏内公告源（P0-02 登记）与三个直播兑换码来源（ADR-0030 登记）。 */
export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  GENSHIN_ANN,
  HSR_ANN,
  ZZZ_ANN,
  liveEntry("genshin-live", "genshin", "2", "2026-10-07T10:02:13.586Z"),
  liveEntry("hsr-live", "hsr", "6", "2026-10-07T10:02:14.824Z"),
  liveEntry("zzz-live", "zzz", "8", "2026-10-07T10:02:15.963Z"),
];

export function isAnnouncementEntry(entry: SourceRegistryEntry): entry is AnnouncementSourceEntry {
  return entry.adapterKind === "announcement-webview";
}

export function isLiveEntry(entry: SourceRegistryEntry): entry is MiyoliveSourceEntry {
  return entry.adapterKind === "miyolive";
}

/** ADR-0030：是否为直播兑换码来源（不在注册表的 ID 返回 false）。 */
export function isLiveSource(sourceId: string): boolean {
  return SOURCE_REGISTRY.some((entry) => entry.sourceId === sourceId && isLiveEntry(entry));
}

/**
 * 已下线来源（ADR-0016）。库里可能留有它们的来源行、文章与轮询待办：
 * 待办直接结束、不再轮询；公开状态只列注册来源；历史文章不能再用于抽取或发布。
 * 不在此名单、也不在注册表的来源 ID 仍按数据错误处理。
 */
export const RETIRED_SOURCE_IDS: readonly string[] = ["miyoushe-news"];

export function isRetiredSource(sourceId: string): boolean {
  return RETIRED_SOURCE_IDS.includes(sourceId);
}

for (const entry of SOURCE_REGISTRY) {
  if (entry.requestLimits.maxResponseBytes > SOURCE_LIMIT_PROFILE.responseCapCeilingBytes) {
    throw new Error(`来源 ${entry.sourceId} 的响应上限超过 SOURCE_LIMIT_PROFILE 安全上界`);
  }
}

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
