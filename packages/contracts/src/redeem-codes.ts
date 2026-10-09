// ADR-0030：米游社直播兑换码的共用规则——从官方说明里认出有效期写法、判断兑换码当前是否还在「有效兑换码」条里。
//
// 官方直播页（webstatic.mihoyo.com/bbs/event/live/）的兑换码条目只有 code、title（奖励说明）、img 与
// to_get_time（发放时刻）；有效期只出现在页面模板的说明文字里（codeTipText），没有结构化字段。
// 所以这里只认"有效期至……""……前有效""……过期/失效"这类明确写法里的完整日期，认不出或有两个不同的日期
// 时返回 null，按"官方没写有效期"处理，不猜"次日中午"之类的惯例（主方案 §3.3 不猜固定时刻）。
// 认出的片段保持原文（raw_expression 与证据引用都用它），换算交给已有的时间解析与补全年份规则。
// ADR-0034：官方没写时，管理员可照官方在别处发布的说明登记截止时间（parseRedeemExpiryInput）；
// 都没有截止时间的兑换码在直播收尾后按北京时间整点核对（redeemStatusCheckAfter），官方不再列出即收回。
// 本模块是纯函数，不读库、不联网。
import { z } from "zod";
import { OperationalReasonSchema } from "./observability";
import { REDEEM_CODE_STATUS_CHECK, REDEEM_LIVE_TRACK_DAYS } from "./params/registry";

// 单位换算，非业务参数。
const SECOND = 1000;
const DAY = 86_400_000;
const UTC8 = 8 * 3_600_000;

/** 官方直播活动 ID 的形状（实测见到 ea2026…、e2024… 之类）；也是 x-rpc-act_id 请求头放行的取值。 */
export const LIVE_ACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 只认米游社官方直播页上的活动 ID（同一主机上的签到、征集等活动页不算）。 */
const LIVE_PAGE = { host: "webstatic.mihoyo.com", path: "/bbs/event/live/index.html" } as const;

/**
 * 链接里的官方直播页活动 ID；米游社应用内链接 mihoyobbs://webview?link=… 先解开一层。
 * 采集的发现入口与管理员登记共用（ADR-0030）；不是官方直播页的链接返回 null。
 */
export function liveActIdFromUrl(raw: string): string | null {
  let value = raw.trim();
  for (let depth = 0; depth < 2; depth++) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol === "mihoyobbs:") {
      const link = url.searchParams.get("link") ?? url.searchParams.get("url");
      if (link === null) return null;
      value = link;
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== LIVE_PAGE.host) return null;
    if (url.pathname !== LIVE_PAGE.path) return null;
    const actId = url.searchParams.get("act_id");
    return actId !== null && LIVE_ACT_ID_PATTERN.test(actId) ? actId : null;
  }
  return null;
}

/** 管理员登记的输入：官方直播页链接或活动 ID 本身；返回活动 ID，认不出为 null。 */
export function liveActIdFromInput(raw: string): string | null {
  const value = raw.trim();
  return LIVE_ACT_ID_PATTERN.test(value) ? value : liveActIdFromUrl(value);
}

/** POST /api/v2/admin/redeem-lives：为某个直播兑换码来源登记一个直播活动（发现入口没出现时的兜底）。 */
export const RedeemLiveRegisterSchema = z.strictObject({
  source: z.string().min(1).max(64),
  live: z.string().min(1).max(512),
  reason: OperationalReasonSchema,
});

// 三种日期写法：带年份的斜线/横线完整时刻（与公告已核验的写法同形）、"YYYY年M月D日 HH:MM"、没写年份的"M月D日( HH:MM)"。
// 日期后面紧跟着认不出的时刻（全角冒号等）时整段不认：只取日期会把"12：00"截止误当成全天有效。
const FULL_SLASH = String.raw`\d{4}(?:/\d{2}/\d{2}|-\d{2}-\d{2}) \d{2}:\d{2}(?::\d{2})?`;
const FULL_CHINESE = String.raw`\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?`;
const YEARLESS = String.raw`\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?`;
const DATE = String.raw`(?:${FULL_SLASH}|${FULL_CHINESE}|${YEARLESS})(?![\d:：]|\s+\d)`;

// "有效期(为/：)(至/截至/截止/到)<日期>"；后面紧跟一个区间时取区间的结束端。
const AFTER_VALIDITY = new RegExp(
  String.raw`有效期(?:为|是)?\s*[:：]?\s*(?:至|截至|截止至|截止到|截止|到)?\s*(?<first>${DATE})(?:\s*(?:-|~|～|—|至|到)\s*(?<second>${DATE}))?`,
  "g",
);
// "<日期>前有效/前兑换""<日期>(后)过期/失效""<日期>截止"。
const BEFORE_EXPIRY = new RegExp(
  String.raw`(?<first>${DATE})\s*(?:(?:前|之前)\s*(?:有效|兑换)|(?:后|以后|之后)?\s*(?:过期|失效)|截止)`,
  "g",
);
// "请于/请在<日期>前(兑换)"与"(兑换)截止(时间)：<日期>"。
const DEADLINE = new RegExp(
  String.raw`(?:(?:请于|请在|需在|须在)\s*(?<first>${DATE})\s*(?:前|之前))|(?:截止(?:时间|日期)?\s*(?:为|是)?\s*[:：]?\s*(?<second>${DATE}))`,
  "g",
);

// 年份前不能紧挨着数字，避免从长数字串里截出日期（同 year-completion 的 EXPLICIT_DATE）。
function startsCleanly(text: string, index: number): boolean {
  return index === 0 || !/\d/.test(text[index - 1] ?? "");
}

/**
 * 从官方说明文字里取出兑换码有效期的日期片段（原文原样）；没有、或写了两个以上不同的日期时返回 null。
 * 只认上面三种完整日期写法：只写时刻、写"次日中午"、写相对时间的都不算。
 */
export function redeemExpiryExpression(text: string): string | null {
  const found = new Set<string>();
  for (const pattern of [AFTER_VALIDITY, BEFORE_EXPIRY, DEADLINE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups ?? {};
      const value = groups.second ?? groups.first;
      if (value === undefined) continue;
      const offset = (match.index ?? 0) + match[0].indexOf(value);
      if (!startsCleanly(text, offset)) continue;
      found.add(value.trim());
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** 「有效兑换码」条里一条兑换码的显示所需事实（发放时刻、截止时间、官方是否还列出它）。 */
export interface RedeemCodeWindow {
  /** 官方发放时刻（to_get_time，UTC 毫秒）。 */
  readonly revealedAt: number;
  /**
   * 截止时间（UTC 毫秒）：管理员照官方说明登记的优先，其次官方兑换码说明里认出的有效期；
   * 只写了日期的取该日北京时间结束；都没有为 null。
   */
  readonly expiresAt: number | null;
  /** 本站观察到官方返回"活动已结束"的时刻；仍在进行为 null。 */
  readonly liveClosedAt: number | null;
  /** ADR-0034：本站核对时发现官方兑换码列表里不再有这个兑换码的时刻；仍列出为 null。 */
  readonly goneAt: number | null;
}

/**
 * 当前是否显示在「有效兑换码」条里（ADR-0034 修订 ADR-0030 第 4 条）：已经发放；
 * 有截止时间的到截止时间为止（之后不再核对官方状态）；没有截止时间的，官方仍列出它（没有消失、
 * 活动也没结束）就一直显示，最长到直播的跟踪期（REDEEM_LIVE_TRACK_DAYS）满。
 */
export function redeemCodeVisible(code: RedeemCodeWindow, now: number): boolean {
  if (code.revealedAt > now) return false;
  if (code.expiresAt !== null) return now < code.expiresAt;
  return code.liveClosedAt === null && code.goneAt === null && now < redeemCodeHiddenAt(code);
}

/** 条目最晚从条里消失的时刻（页面据此到点隐藏）：截止时间，没有截止时间时是跟踪期满。 */
export function redeemCodeHiddenAt(code: RedeemCodeWindow): number {
  return code.expiresAt ?? code.revealedAt + REDEEM_LIVE_TRACK_DAYS * DAY;
}

/**
 * ADR-0034：上次核对之后的下一个核对时刻——北京时间 0 点起每 REDEEM_CODE_STATUS_CHECK 秒一个整点
 * （默认 0、3、6……21 点），严格晚于给定时刻。
 */
export function redeemStatusCheckAfter(ms: number): number {
  const period = REDEEM_CODE_STATUS_CHECK * SECOND;
  return Math.floor((ms + UTC8) / period) * period - UTC8 + period;
}

/** 每天的核对时刻（北京时间的整点小时），由 REDEEM_CODE_STATUS_CHECK 推出，供页面说明（默认 0、3……21）。 */
export const REDEEM_STATUS_CHECK_HOURS: readonly number[] = Array.from(
  { length: DAY / (REDEEM_CODE_STATUS_CHECK * SECOND) },
  (_, index) => (index * REDEEM_CODE_STATUS_CHECK * SECOND) / (DAY / 24),
);

/** 管理员登记截止时间的输入：北京时间"YYYY-MM-DDTHH:MM(:SS)"（datetime-local），也认空格与斜线写法。 */
const EXPIRY_INPUT = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * ADR-0034：管理员照官方说明登记的截止时间 → UTC 毫秒与写进正文的写法"YYYY/MM/DD HH:MM(:SS)"
 * （与公告已核验的斜线写法同形，没输入秒就不写秒）。不存在的日子、形状不符返回 null。
 */
export function parseRedeemExpiryInput(raw: string): { utcMs: number; expression: string } | null {
  const match = EXPIRY_INPUT.exec(raw.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const full = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}`;
  const utcMs = Date.parse(`${full}+08:00`);
  if (!Number.isSafeInteger(utcMs)) return null;
  // Date.parse 可能把不存在的日子顺延；往返校验阻止这种"修复"。
  if (new Date(utcMs + UTC8).toISOString().slice(0, 19) !== full) return null;
  const clock = second === undefined ? `${hour}:${minute}` : `${hour}:${minute}:${second}`;
  return { utcMs, expression: `${year}/${month}/${day} ${clock}` };
}

/**
 * POST /api/v2/admin/redeem-expiry（ADR-0034）：为正在跟踪的一场直播登记兑换码截止时间。
 * expected_updated_at 是页面上看到的登记版本（还没有登记时为 0），并发修改时后到的一次返回冲突。
 */
export const RedeemExpirySetSchema = z.strictObject({
  source: z.string().min(1).max(64),
  act_id: z.string().regex(LIVE_ACT_ID_PATTERN),
  expires_at: z.string().min(1).max(32),
  reason: OperationalReasonSchema,
  expected_updated_at: z.int().min(0),
});
