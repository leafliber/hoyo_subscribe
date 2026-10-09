// ADR-0030 · 米游社直播兑换码来源适配器：发现直播活动、读取活动信息与兑换码，整理成可核对的正文。
//
// 接口与字段取自米游社官方直播页前端（webstatic.mihoyo.com/bbs/event/live/，2026-10-07 读取其公开脚本，
// 只用于定位接口；数据全部直连官方端点，见 docs/evidence/p3/miyolive-redeem-codes.md）：
//   - 发现：米游社首页接口 data.lives / data.navigator / data.carousels 里指向官方直播页的链接带活动 ID；
//   - 活动：GET api-takumi.mihoyo.com/event/miyolive/index，请求头 x-rpc-act_id。data.live 有 title、
//     code_ver；data.template 是 JSON 字符串，codeTipText 是兑换码说明（有效期只在这里）；
//   - 兑换码：GET api-takumi-static.mihoyo.com/event/miyolive/refreshCode?version=<code_ver>&time=<秒>，
//     time 与官方页面一样按 20 秒取整。data.code_list[] 有 code（未到发放时刻为空）、title（奖励说明 HTML）、
//     to_get_time（发放时刻，秒）；
//   - 活动不存在或已结束：两接口都回 retcode -500012"活动已结束"（2026-10-07 实测信封）。
// 诚实 UA、不跟随重定向、不重试；遇到鉴权/验证码/访问限制按 restricted 交给调用方停用并标维护（规则 6）。
// 2026-10-07 没有进行中的直播，活动与兑换码字段的形状来自官方页面脚本，尚无真实样本：
// 字段缺失或类型不符时按"格式不符"失败，不猜。
import { LIVE_ACT_ID_PATTERN, liveActIdFromUrl } from "@hoyo/contracts";
import { parseAnnouncementExactTime } from "../../extraction/time";
import { decodeHtmlEntities, denoiseTitle, stripHtmlTags } from "../articles/blocks";
import { classifyRestriction } from "../guarded-fetch";
import type { MiyoliveSourceEntry } from "../registry";
import type { SourceFetchFailure } from "../types";
import { buildSourceUrl, fetchJsonBody, parseEnvelope } from "./shared";

/** 官方"活动已结束"（不存在的活动也是这个信封）。 */
export const LIVE_CLOSED_RETCODE = -500012;
/** 兑换码本身：官方是字母数字；其他形状的不当作兑换码。 */
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
/** 首页 JSON 里逐层找链接时的深度与条目上限：只看三个已知字段，防止异常大响应拖慢。 */
const DISCOVERY_SCAN_LIMIT = { depth: 6, strings: 2_000 } as const;
/** 文本单位换算，非业务参数。 */
const SECOND = 1000;

export interface LiveCodeEntry {
  /** 尚未发放时为 null。 */
  readonly code: string | null;
  /** 奖励说明（官方 HTML 整理成的纯文本）。 */
  readonly reward: string;
  /** 官方发放时刻 to_get_time（UTC 毫秒）。 */
  readonly revealAtMs: number;
}

/** 活动信息里与直播是否收尾有关的官方字段（ADR-0034）。 */
export interface LiveSchedule {
  /** 官方 live.end（北京时间"YYYY-MM-DD HH:MM:SS"）换算的 UTC 毫秒；没给或认不出为 null。 */
  readonly endAtMs: number | null;
  /** 官方 live.is_end。 */
  readonly ended: boolean;
}

export type LiveSnapshot =
  | ({
      readonly actId: string;
      readonly status: "open";
      readonly title: string;
      readonly codes: readonly LiveCodeEntry[];
      /** 页面模板里的兑换码说明（纯文本）；没有为 null。 */
      readonly tip: string | null;
    } & LiveSchedule)
  | { readonly actId: string; readonly status: "closed" };

function readableText(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, "\n")))
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 首页 data 里的直播活动 ID：data.lives 的直播卡片（链接或 act_id 字段）、data.navigator 与 data.carousels
 * 里指向官方直播页的链接。只扫这三处，按出现顺序去重。
 */
export function extractLiveActIds(data: Record<string, unknown>): string[] {
  const found: string[] = [];
  let strings = 0;
  const add = (actId: string | null) => {
    if (actId !== null && !found.includes(actId)) found.push(actId);
  };
  const walk = (value: unknown, depth: number, liveCard: boolean) => {
    if (depth > DISCOVERY_SCAN_LIMIT.depth || strings > DISCOVERY_SCAN_LIMIT.strings) return;
    if (typeof value === "string") {
      strings++;
      add(liveActIdFromUrl(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, liveCard);
      return;
    }
    const record = asRecord(value);
    if (record === null) return;
    for (const [key, item] of Object.entries(record)) {
      // 直播卡片本身就是直播：它的 act_id 字段直接算数（链接字段照常解析）。
      if (
        liveCard &&
        key === "act_id" &&
        typeof item === "string" &&
        LIVE_ACT_ID_PATTERN.test(item)
      )
        add(item);
      walk(item, depth + 1, liveCard);
    }
  };
  walk(data.lives, 0, true);
  walk(data.navigator, 0, false);
  walk(asRecord(data.carousels)?.data ?? data.carousels, 0, false);
  return found;
}

/** 首页一次：返回直播活动 ID；失败按受限 fetch 的分类返回。 */
export async function discoverLiveActIds(
  entry: MiyoliveSourceEntry,
  fetchFn: typeof fetch,
): Promise<{ actIds: string[] } | { failure: SourceFetchFailure }> {
  const { host, path, params } = entry.request.discovery;
  const fetched = await fetchJsonBody(entry, buildSourceUrl(host, path, params), fetchFn);
  if ("failure" in fetched) return fetched;
  const envelope = parseEnvelope(fetched.body.bodyText);
  if (!envelope.ok) return { failure: { kind: "malformed-body", detail: "discovery_envelope" } };
  const restricted = classifyRestriction(200, envelope.message);
  if (restricted.length > 0)
    return { failure: { kind: "restricted", status: 200, signals: restricted } };
  if (envelope.retcode !== 0)
    return {
      failure: { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
    };
  return { actIds: extractLiveActIds(envelope.data) };
}

/** 官方页面模板（JSON 字符串）里的兑换码说明。 */
function tipFromTemplate(template: unknown): string | null {
  if (typeof template !== "string" || template.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    return null;
  }
  const tip = asRecord(parsed)?.codeTipText;
  if (typeof tip !== "string") return null;
  const text = readableText(tip);
  return text === "" ? null : text;
}

/** 活动信息：retcode 0 → 标题、code_ver、说明、结束时刻；-500012 → closed。其余 → 失败。纯函数。 */
export function parseLiveIndex(
  bodyText: string,
):
  | ({ status: "open"; title: string; codeVer: string | null; tip: string | null } & LiveSchedule)
  | { status: "closed" }
  | { failure: SourceFetchFailure } {
  const envelope = parseEnvelope(bodyText);
  if (!envelope.ok) return { failure: { kind: "malformed-body", detail: "index_envelope" } };
  const restricted = classifyRestriction(200, envelope.message);
  if (restricted.length > 0)
    return { failure: { kind: "restricted", status: 200, signals: restricted } };
  if (envelope.retcode === LIVE_CLOSED_RETCODE) return { status: "closed" };
  if (envelope.retcode !== 0)
    return {
      failure: { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
    };
  const live = asRecord(envelope.data.live);
  const title = typeof live?.title === "string" ? denoiseTitle(readableText(live.title)) : "";
  if (live === null || title === "")
    return { failure: { kind: "malformed-body", detail: "index_live_missing" } };
  const codeVer =
    typeof live.code_ver === "string" && live.code_ver !== ""
      ? live.code_ver
      : typeof live.code_ver === "number"
        ? String(live.code_ver)
        : null;
  // ADR-0034：官方给的直播结束时刻与 is_end（2026-10-09 实测样本有这两个字段）；判断直播是否收尾。
  const endAtMs =
    typeof live.end === "string" ? (parseAnnouncementExactTime(live.end)?.utc_ms ?? null) : null;
  return {
    status: "open",
    title,
    codeVer,
    tip: tipFromTemplate(envelope.data.template),
    endAtMs,
    ended: live.is_end === true,
  };
}

/** 兑换码列表：retcode 0 → 条目；-500012 → closed。条目形状不符整份按失败处理。纯函数。 */
export function parseCodeList(
  bodyText: string,
):
  | { status: "open"; codes: LiveCodeEntry[] }
  | { status: "closed" }
  | { failure: SourceFetchFailure } {
  const envelope = parseEnvelope(bodyText);
  if (!envelope.ok) return { failure: { kind: "malformed-body", detail: "code_envelope" } };
  const restricted = classifyRestriction(200, envelope.message);
  if (restricted.length > 0)
    return { failure: { kind: "restricted", status: 200, signals: restricted } };
  if (envelope.retcode === LIVE_CLOSED_RETCODE) return { status: "closed" };
  if (envelope.retcode !== 0)
    return {
      failure: { kind: "business-rejected", retcode: envelope.retcode, message: envelope.message },
    };
  const list = envelope.data.code_list ?? [];
  if (!Array.isArray(list)) return { failure: { kind: "malformed-body", detail: "code_list" } };
  const codes: LiveCodeEntry[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    const seconds = Number(item?.to_get_time);
    if (item === null || !Number.isSafeInteger(seconds) || seconds <= 0)
      return { failure: { kind: "malformed-body", detail: "code_item" } };
    const code = typeof item.code === "string" ? item.code.trim() : "";
    if (code !== "" && !CODE.test(code))
      return { failure: { kind: "malformed-body", detail: "code_value" } };
    codes.push({
      code: code === "" ? null : code,
      reward: typeof item.title === "string" ? readableText(item.title) : "",
      revealAtMs: seconds * SECOND,
    });
  }
  codes.sort((a, b) => a.revealAtMs - b.revealAtMs || (a.code ?? "").localeCompare(b.code ?? ""));
  return { status: "open", codes };
}

/** 与官方页面相同的缓存键：当前秒数按 20 秒取整。 */
function codeTimeParam(nowMs: number): string {
  const seconds = Math.ceil(nowMs / SECOND);
  return String(seconds - (seconds % 20));
}

/** 一个直播活动：活动信息 + 兑换码，两次请求。 */
export async function fetchLiveSnapshot(
  entry: MiyoliveSourceEntry,
  actId: string,
  nowMs: number,
  fetchFn: typeof fetch,
): Promise<{ live: LiveSnapshot } | { failure: SourceFetchFailure }> {
  const headers = { "x-rpc-act_id": actId };
  const indexUrl = `https://${entry.request.index.host}${entry.request.index.path}`;
  const index = await fetchJsonBody(entry, indexUrl, fetchFn, headers);
  if ("failure" in index) return index;
  const info = parseLiveIndex(index.body.bodyText);
  if ("failure" in info) return info;
  if (info.status === "closed") return { live: { actId, status: "closed" } };
  const schedule = { endAtMs: info.endAtMs, ended: info.ended };
  if (info.codeVer === null)
    return {
      live: { actId, status: "open", title: info.title, codes: [], tip: info.tip, ...schedule },
    };
  const codesUrl = buildSourceUrl(entry.request.codes.host, entry.request.codes.path, {
    version: info.codeVer,
    time: codeTimeParam(nowMs),
  });
  const codes = await fetchJsonBody(entry, codesUrl, fetchFn, headers);
  if ("failure" in codes) return codes;
  const list = parseCodeList(codes.body.bodyText);
  if ("failure" in list) return list;
  if (list.status === "closed") return { live: { actId, status: "closed" } };
  return {
    live: {
      actId,
      status: "open",
      title: info.title,
      codes: list.codes,
      tip: info.tip,
      ...schedule,
    },
  };
}

/** 官方直播页（展示用链接，本站不请求它）。 */
export function liveOfficialUrl(entry: MiyoliveSourceEntry, actId: string): string {
  const url = new URL(entry.request.livePage);
  url.searchParams.set("act_id", actId);
  return url.toString();
}
