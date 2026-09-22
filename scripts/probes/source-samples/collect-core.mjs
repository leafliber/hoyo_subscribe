// P0-02 采集核心（纯逻辑，无 Node 专有 API；runner 与测试共用）。
// 职责：从 sources.verified.json 的定义构造请求 URL；解析两类列表信封；
// 剥离凭敏字段；组装 synthetic:false 的样本记录。网络访问一律经 lib/guard-core.mjs
// 的 guardedFetch（域名白名单、不跟随重定向、超时、限量读体、诚实 UA、不重试）。
// 注意：本文件里的 findDateRanges 只服务"列表展示时间 ≠ 活动时间"的证据生成，
// 不是主方案 §3.4 的抽取实现（抽取不在本卡范围）。

/** 把 params 对象编码为 query string（键序稳定，便于复现与断言）。 */
export function encodeParams(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

const UTF8_ENCODER = new TextEncoder();

/** UTF-8 字节数（Node 与 Workers 通用的写法）。 */
export function utf8ByteLength(text) {
  return UTF8_ENCODER.encode(text).byteLength;
}

/** 公告类列表 URL。 */
export function buildAnnListUrl(source, { page, pageSize }) {
  const params = { ...source.list.params, page: String(page), page_size: String(pageSize) };
  return `https://${source.approved_hosts[0]}${source.list.path}?${encodeParams(params)}`;
}

/** 公告类正文 URL。 */
export function buildAnnContentUrl(source, annId) {
  const params = { ...source.list.params, [source.content.params_key]: String(annId) };
  return `https://${source.approved_hosts[0]}${source.content.path}?${encodeParams(params)}`;
}

/** 米游社资讯列表 URL。 */
export function buildNewsListUrl(source, { type, lastId = "", pageSize }) {
  const params = {
    ...source.list.params,
    type: String(type),
    last_id: lastId === null ? "" : String(lastId),
    page_size: String(pageSize),
  };
  return `https://${source.approved_hosts[0]}${source.list.path}?${encodeParams(params)}`;
}

/** 米游社正文 URL（当前被 403 访问控制挡住，仅用于取证记录）。 */
export function buildNewsContentUrl(source, postId) {
  const params = { post_id: String(postId) };
  return `https://${source.approved_hosts[0]}${source.content.path}?${encodeParams(params)}`;
}

/**
 * 解析公告类信封。getAnnList 的 data.list 是"按 type 分组"的二维结构；
 * getAnnContent 的 data.list 是扁平条目数组。两种形状都识别。
 * @returns {{ ok: boolean, retcode?: number, message?: string, total?: number, timezone?: unknown,
 *             groups: Array<{ type_label: unknown, items: unknown[] }>, flatItems: unknown[] }}
 */
export function parseAnnList(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, groups: [], flatItems: [] };
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.retcode !== "number") {
    return { ok: false, groups: [], flatItems: [] };
  }
  const data = parsed.data ?? {};
  const rawList = Array.isArray(data.list) ? data.list : [];
  const isGrouped =
    rawList.length > 0 &&
    rawList.every((g) => g !== null && typeof g === "object" && Array.isArray(g.list));
  const groups = isGrouped
    ? rawList.map((g) => ({ type_label: g?.type_label, items: g.list }))
    : [
        {
          type_label: undefined,
          items: rawList.filter((i) => i !== null && typeof i === "object"),
        },
      ];
  return {
    ok: true,
    retcode: parsed.retcode,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
    total: typeof data.total === "number" ? data.total : undefined,
    timezone: data.timezone,
    t: data.t,
    alert: data.alert,
    alert_id: data.alert_id,
    groups,
    flatItems: groups.flatMap((g) => g.items),
  };
}

/**
 * 解析米游社资讯列表信封。
 * @returns {{ ok: boolean, retcode?: number, message?: string, items: unknown[],
 *             lastId?: string, isLast?: boolean }}
 */
export function parseNewsList(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, items: [] };
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.retcode !== "number") {
    return { ok: false, items: [] };
  }
  const data = parsed.data ?? {};
  return {
    ok: true,
    retcode: parsed.retcode,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
    items: Array.isArray(data.list) ? data.list : [],
    lastId: data.last_id === undefined || data.last_id === null ? undefined : String(data.last_id),
    isLast: data.is_last === true,
  };
}

// ---------- 凭敏剥离 ----------

// 命中即删除的键（大小写不敏感子串）。样本来自官方公告接口，理论上不应出现这些键；
// 出现说明上游结构变化，宁可删掉也要保证"秘密不进仓库"（AGENTS.md 规则 7）。
const CREDENTIAL_KEY_MARKERS = [
  "cookie",
  "token",
  "authkey",
  "auth_key",
  "authkey_ver",
  "stoken",
  "ltoken",
  "ltuid",
  "login_uid",
  "sessionkey",
  "device_id",
  "deviceid",
  "password",
  "secret",
];

// 完整邮箱 / 手机号样式（用户可识别信息；官方公告不应包含，出现即剥离并记录）。
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?<!\d)(?:\+?86)?1[3-9]\d{9}(?!\d)/;

/**
 * 深度剥离凭敏键与用户可识别信息。
 * @param {unknown} value
 * @param {string[]} redactions 收集的剥离记录
 * @param {string} path 当前路径
 * @returns {unknown} 清洗后的值
 */
export function scrubValue(value, redactions, path = "$") {
  if (Array.isArray(value)) {
    return value.map((v, i) => scrubValue(v, redactions, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY_MARKERS.some((m) => k.toLowerCase().includes(m))) {
        redactions.push(`${path}.${k}（凭敏键，整键删除）`);
        continue;
      }
      out[k] = scrubValue(v, redactions, `${path}.${k}`);
    }
    return out;
  }
  if (typeof value === "string" && value.length <= 500) {
    if (EMAIL_RE.test(value)) {
      redactions.push(`${path}（含邮箱样式文本，替换为 [redacted-email]）`);
      return value.replace(EMAIL_RE, "[redacted-email]");
    }
    if (PHONE_RE.test(value)) {
      redactions.push(`${path}（含手机号样式文本，替换为 [redacted-phone]）`);
      return value.replace(PHONE_RE, "[redacted-phone]");
    }
  }
  return value;
}

/**
 * 组装样本记录（synthetic:false 的硬约束在这里保证）。
 * @param {{ sourceId: string, kind: string, purpose: string, url: string,
 *           http: { status: number, headers: Record<string, unknown> },
 *           bodyText: string, bodySha256: string, capturedAtUtc: string,
 *           extra?: Record<string, unknown> }} input
 */
export function makeSampleRecord(input) {
  let body;
  const redactions = [];
  try {
    body = scrubValue(JSON.parse(input.bodyText), redactions);
  } catch {
    body = { raw_text: input.bodyText };
  }
  return {
    schema_version: 1,
    synthetic: false,
    source_id: input.sourceId,
    kind: input.kind,
    purpose: input.purpose,
    captured_at_utc: input.capturedAtUtc,
    url: input.url,
    http: { status: input.http.status, headers: input.http.headers },
    body_bytes: utf8ByteLength(input.bodyText),
    body_sha256: input.bodySha256,
    redactions,
    ...(input.extra && Object.keys(input.extra).length > 0 ? { extra: input.extra } : {}),
    body,
  };
}

// ---------- 分析辅助（证据工具，非抽取实现） ----------

// 日期/时间与分隔符之间允许夹空白、HTML 标签、实体或无数字的短注记
// （实测 ZZZ 在时间后注「（服务器时间）」再接分隔符）
const BETWEEN = String.raw`(?:\s|<[^>]+>|&\w+;|[^\d~～至—–-])*?`;

const DATE_RANGE_RES = [
  // 2026/09/18 12:00 ~ 2026/10/06 17:59 及其变体（~、～、至、—、–、- 分隔）
  new RegExp(
    `(\\d{4}[/年.\\-]\\s?\\d{1,2}[/月.\\-]\\s?\\d{1,2}日?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)${BETWEEN}(?:~|～|至|—|–|-)${BETWEEN}(\\d{4}[/年.\\-]\\s?\\d{1,2}[/月.\\-]\\s?\\d{1,2}日?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)`,
    "g",
  ),
  // 9月18日 12:00 ~ 10月6日 17:59（无年份）
  new RegExp(
    `(\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)${BETWEEN}(?:~|～|至|—|–|-)${BETWEEN}(\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)`,
    "g",
  ),
  // 9月18日12:00 ～ 10月6日（结束无时间）
  new RegExp(
    `(\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2})${BETWEEN}(?:~|～|至|—|–|-)${BETWEEN}(\\d{1,2}月\\d{1,2}日)(?!\\s*\\d{1,2}:)`,
    "g",
  ),
];

/** 相对起点区间：起点不是绝对时间（如「7.1版本更新后」），终点是绝对时间。
 *  启发式证据提取：分隔符前抓一小段文本作为相对起点，非规范化语义。 */
const RELATIVE_START_RANGE_RE =
  /([^\s~～至—–-][^~～]{1,24}?)[~～]\s*(\d{4}[/年.-]\s?\d{1,2}[/月.-]\s?\d{1,2}日?\s*\d{1,2}:\d{2}(?::\d{2})?)(?!\s*[~～])/g;

/** 绝对时间点（日期+时刻）提取，用于"列表展示时间 ≠ 活动时间"对照。 */
const ABSOLUTE_DATETIME_RE =
  /\d{4}[/年.-]\s?\d{1,2}[/月.-]\s?\d{1,2}日?\s*\d{1,2}:\d{2}(?::\d{2})?/g;

/** 纯日期（有日期无时刻）。日号后不得紧跟数字（防吞半截）或时刻；含无年份形式。 */
const DATE_ONLY_RE =
  /\d{4}[/年.-]\s?\d{1,2}[/月.-]\s?\d{1,2}日?(?!\d)(?!\s*\d{1,2}:)|\d{1,2}月\d{1,2}日(?!\d)(?!\s*\d{1,2}:)/g;

/**
 * 在文本中找日期/时间区间（证据工具：用于"列表展示时间 ≠ 活动时间"对照）。
 * @returns {Array<{ start: string, end: string, cross_year?: boolean, end_has_time?: boolean }>}
 */
export function findDateRanges(text) {
  const found = [];
  for (const re of DATE_RANGE_RES) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      const [start, end] = [m[1], m[2]];
      const crossYear =
        extractYear(start) !== null &&
        extractYear(end) !== null &&
        extractYear(start) !== extractYear(end);
      const endHasTime = /\d{1,2}:\d{2}/.test(end);
      found.push({
        start,
        end,
        ...(crossYear ? { cross_year: true } : {}),
        end_has_time: endHasTime,
      });
      m = re.exec(text);
    }
  }
  return found;
}

/** 提取全部"绝对时间点"（日期+时刻）。 */
export function findAbsoluteDatetimes(text) {
  ABSOLUTE_DATETIME_RE.lastIndex = 0;
  return text.match(ABSOLUTE_DATETIME_RE) ?? [];
}

/** 提取全部"纯日期"（无时刻）。 */
export function findDateOnly(text) {
  DATE_ONLY_RE.lastIndex = 0;
  return text.match(DATE_ONLY_RE) ?? [];
}

/** 相对起点区间（启发式证据提取，非规范化语义）。
 *  过滤掉"起点其实也是绝对时间"的重复命中（它们已由 findDateRanges 覆盖）。 */
export function findRelativeStartRanges(text) {
  const found = [];
  RELATIVE_START_RANGE_RE.lastIndex = 0;
  let m = RELATIVE_START_RANGE_RE.exec(text);
  while (m !== null) {
    const start = m[1].trim();
    if (!/\d{4}[/年.-]/.test(start)) {
      found.push({ relative_start: start, end: m[2] });
    }
    m = RELATIVE_START_RANGE_RE.exec(text);
  }
  return found;
}

function extractYear(s) {
  const m = s.match(/(\d{4})[/年.]/);
  return m ? m[1] : null;
}

/**
 * 判断公告正文是否"日期主要承载在图片"：正文可读文本很短而图片引用很多，
 * 且文本本身不含完整日期区间。
 */
export function isDateCarriedByImage(contentText, imageCount) {
  const text = stripHtml(contentText ?? "");
  const hasFullDateRange = DATE_RANGE_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
  const hasAnyDate = /\d{1,2}月\d{1,2}日|\d{4}[/年]\d{1,2}[/月]\d{1,2}/.test(text);
  return {
    image_count: imageCount,
    text_length: text.length,
    has_full_date_range: hasFullDateRange,
    has_any_date: hasAnyDate,
    date_likely_in_image: imageCount > 0 && !hasFullDateRange && text.length < 400,
  };
}

/** 去除 HTML 标签（只做证据分析用，不做正文规范化）。
 *  官方正文把高亮时间包在转义标签里（&lt;t class="t_gl"&gt;2026/09/23 06:00&lt;/t&gt;），
 *  先反转义再剥标签，保证时间文本不被标签残迹打断。 */
export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}
