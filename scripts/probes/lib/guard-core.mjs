// P0-01 探针共用：受限 fetch 与"鉴权/验证码/访问限制"信号识别（纯逻辑，无 Node 专有 API）。
// 本文件同时被两类消费方使用：Node 本地 runner 直接 import；Worker 探针经 wrangler(esbuild) 打包。
// 依据：任务卡 P0-01 关键约束与主方案 §3.1——
//   只发只读 GET；域名白名单；不跟随重定向；超时；响应大小与类型限制；诚实 UA；不携带凭据；不重试；
//   出现鉴权/验证码/访问限制时记录并退出，不实施绕过、不伪装 UA、不使用第三方聚合后端。
//
// 注意：本文件里的超时/大小等数值是"探针自身的操作性限制"，
// 不是业务参数；业务侧来源限制属 SOURCE_LIMIT_PROFILE（附录 A.1，P0-02 实测登记）。

export const PROBE_USER_AGENT =
  "hoyo-subscribe-p0-probe/1.0 (read-only reachability probe; no credentials; no retries)";

// 探针操作性限制（非业务参数，见文件头说明）
export const PROBE_FETCH_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 1_048_576, // 1 MiB
};

export class GuardError extends Error {
  /**
   * @param {string} code 机器可读的守卫拒绝码
   * @param {string} detail 人类可读说明（不得包含任何凭据）
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "GuardError";
    this.code = code;
  }
}

/** 用 WebCrypto（Node ≥18 与 Workers 均内置）计算 SHA-256 十六进制。 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const RESTRICTED_STATUS = new Set([401, 403, 407, 429]);

// 启发式标记。只用于"提示人工复核"，命中不代表最终结论，未命中也不代表可以绕过。
// ASCII 标记做大小写不敏感匹配；中文标记原样子串匹配。
const RESTRICTION_MARKERS = [
  "geetest",
  "captcha",
  "verify",
  "unauthorized",
  "forbidden",
  "access denied",
  "not logged in",
  "login required",
  "请登录",
  "未登录",
  "登录后重试",
  "验证码",
  "访问受限",
  "风控",
  "频繁",
];

/**
 * 断言 URL 合法：仅 https（测试可显式放行 http）、无 userinfo、主机在白名单内。
 * @param {string} rawUrl
 * @param {string[]} allowedHosts 精确主机名白名单（来自仓库内的固定线索文件，不来自用户输入）
 * @param {{ allowInsecureHttp?: boolean }} [options]
 * @returns {URL}
 */
export function assertAllowedUrl(rawUrl, allowedHosts, options = {}) {
  const { allowInsecureHttp = false } = options;
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new GuardError("scheme_not_allowed", `仅允许 https，当前 ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new GuardError("userinfo_not_allowed", "URL 不得携带 userinfo");
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new GuardError(
      "host_not_in_allowlist",
      `主机 ${url.hostname} 不在白名单 ${allowedHosts.join(", ")} 内`,
    );
  }
  return url;
}

/**
 * 按上限读取响应体流。
 * @param {ReadableStream<Uint8Array> | null} bodyStream
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Uint8Array, truncated: boolean }>}
 */
export async function readBodyCapped(bodyStream, maxBytes) {
  if (!bodyStream) return { buffer: new Uint8Array(0), truncated: false };
  const reader = bodyStream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const buffer = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = buffer.byteLength - offset;
    if (remaining <= 0) break;
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    buffer.set(slice, offset);
    offset += slice.byteLength;
  }
  return { buffer, truncated };
}

/** 在文本中匹配启发式标记（ASCII 标记大小写不敏感），返回命中的标记列表。 */
export function matchMarkers(text, markers = RESTRICTION_MARKERS) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lower = text.toLowerCase();
  return markers.filter((m) => (m === m.toLowerCase() ? lower.includes(m) : text.includes(m)));
}

/**
 * 解析 JSON 顶层"信封"字段（深度 ≤ 1 的字符串/数值/布尔），用于检测错误包裹层。
 * 刻意不进入 data/list 等内容数组：公告标题里出现"登录"之类字样不代表访问受限。
 * @param {string} bodyText
 * @returns {{ ok: boolean, entries: Array<[string, string | number | boolean]> }}
 */
export function shallowJsonEnvelope(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true, entries: [] };
    }
    const entries = Object.entries(parsed).filter(
      ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

/**
 * 识别鉴权/验证码/访问限制信号（启发式，供人工复核）。
 * @param {{ status?: number, headers?: Record<string, string | null>, bodyText?: string, contentType?: string | null }} obs
 * @returns {{ restricted: boolean, signals: Array<{ kind: string, detail?: string }> }}
 */
export function analyzeRestrictionSignals(obs) {
  const status = obs.status ?? 0;
  const headers = obs.headers ?? {};
  const signals = [];

  if (RESTRICTED_STATUS.has(status)) {
    signals.push({ kind: "http_status", detail: `HTTP ${status}` });
  }
  if (headers.www_authenticate) {
    signals.push({
      kind: "www_authenticate",
      detail: String(headers.www_authenticate).slice(0, 120),
    });
  }
  if (headers.cf_mitigated) {
    signals.push({ kind: "cf_mitigated", detail: String(headers.cf_mitigated).slice(0, 120) });
  }
  if (status === 429 && headers.retry_after) {
    signals.push({
      kind: "rate_limited_retry_after",
      detail: String(headers.retry_after).slice(0, 60),
    });
  }

  const bodyText = obs.bodyText ?? "";
  if (bodyText) {
    const isJson = (obs.contentType ?? "").includes("json");
    if (isJson) {
      const { ok, entries } = shallowJsonEnvelope(bodyText);
      if (ok) {
        for (const [key, value] of entries) {
          if (typeof value !== "string" || value.length > 200) continue;
          const matched = matchMarkers(value);
          if (matched.length > 0) {
            signals.push({
              kind: "body_envelope_marker",
              detail: `$.${key} 命中 ${matched.join("/")}`,
            });
          }
        }
      }
    } else {
      const matched = matchMarkers(bodyText.slice(0, 2048));
      if (matched.length > 0) {
        signals.push({ kind: "body_prefix_marker", detail: matched.join("/") });
      }
    }
  }

  return { restricted: signals.length > 0, signals };
}

/** 提取用于证据记录的响应头子集（不含任何凭敏头）。 */
export function pickResponseHeaders(headers) {
  const get = (name) => headers.get(name);
  return {
    content_type: get("content-type"),
    content_length: get("content-length"),
    location: get("location"),
    www_authenticate: get("www-authenticate"),
    cf_mitigated: get("cf-mitigated"),
    cf_ray: get("cf-ray"),
    server: get("server"),
    retry_after: get("retry-after"),
  };
}

/**
 * 受限 fetch：断言 URL → GET（redirect: manual）→ 超时中止 → 限量读体。
 * 任何失败都以记录形式返回，绝不重试、绝不换 UA、绝不跟随重定向。
 * @param {string} rawUrl
 * @param {{ allowedHosts: string[], timeoutMs?: number, maxBytes?: number, allowInsecureHttp?: boolean }} options
 * @returns {Promise<Record<string, unknown>>} 观测记录
 */
export async function guardedFetch(rawUrl, options) {
  const {
    allowedHosts,
    timeoutMs = PROBE_FETCH_DEFAULTS.timeoutMs,
    maxBytes = PROBE_FETCH_DEFAULTS.maxBytes,
    allowInsecureHttp = false,
  } = options;
  const startedAtMs = Date.now();
  const base = {
    url: rawUrl,
    started_at_utc: new Date(startedAtMs).toISOString(),
    guard: {
      method: "GET",
      redirect: "manual",
      timeout_ms: timeoutMs,
      max_bytes: maxBytes,
      retries: 0,
    },
  };
  let url;
  try {
    url = assertAllowedUrl(rawUrl, allowedHosts, { allowInsecureHttp });
  } catch (e) {
    if (e instanceof GuardError) {
      return { ...base, elapsed_ms: 0, error: { kind: "guard", code: e.code, message: e.message } };
    }
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": PROBE_USER_AGENT, accept: "application/json, text/plain;q=0.1" },
    });
    const headers = pickResponseHeaders(res.headers);
    const { buffer, truncated } = await readBodyCapped(res.body, maxBytes);
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return {
      ...base,
      elapsed_ms: Date.now() - startedAtMs,
      error: null,
      http: {
        status: res.status,
        status_text: res.statusText,
        headers,
        redirect_status: res.status >= 301 && res.status <= 308 ? res.status : null,
        followed_redirect: false,
      },
      body: {
        bytes_read: buffer.byteLength,
        truncated,
        text: bodyText,
      },
    };
  } catch (e) {
    const aborted = controller.signal.aborted;
    return {
      ...base,
      elapsed_ms: Date.now() - startedAtMs,
      error: {
        kind: aborted ? "timeout" : "network",
        code: aborted ? "abort_timeout" : String(e?.name ?? "network_error"),
        message: String(e?.message ?? e).slice(0, 300),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
