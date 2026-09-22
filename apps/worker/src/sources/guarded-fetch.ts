// 生产版受限 fetch（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 合同依据：主方案 §3.1——请求限制域名、重定向、超时、大小和类型；不提供公开通用抓取代理；
// 生产只访问经审核的官方地址（approved_hosts）；遇到鉴权/验证码/访问控制停用来源并提示维护，
// 不实施绕过（AGENTS.md 规则 6）。行为参照 P0-01/P0-02 探针的 guard-core（域名白名单、
// 不跟随重定向、超时、限量读体、诚实 UA、不重试），按 Worker 生产要求用 TypeScript 重写；
// 探针代码不被 import（任务卡约束）。
//
// 数值全部来自 registry.draft.json 的 limit_profile_measured（经 sources/registry.ts 转录，
// 漂移测试锁定），本文件零自有阈值。

/** 诚实 UA：标识服务与只读用途，不伪装浏览器（AGENTS.md 规则 6）。 */
export const SOURCE_COLLECTOR_USER_AGENT =
  "hoyo-subscribe-source-collector/1.0 (read-only official-source polling; no credentials; no retries)";

export type GuardRejectionCode =
  | "scheme_not_allowed"
  | "userinfo_not_allowed"
  | "host_not_in_allowlist";

export interface GuardedFetchLimits {
  /** 精确主机名白名单（来自来源注册项 approved_hosts，非用户输入）。 */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type GuardedFetchOutcome =
  | {
      kind: "ok";
      status: number;
      bodyText: string;
      bytes: number;
      contentType: string | null;
      /** 响应体按上限读体是否触及上限（触及即作废，见 response-too-large）。 */
      bodyTruncated: boolean;
    }
  | { kind: "restricted"; status: number; signals: readonly string[] }
  | { kind: "rate-limited"; status: number }
  | { kind: "redirect-not-followed"; status: number; location: string | null }
  | { kind: "timeout" }
  | { kind: "response-too-large"; bytes: number; cap: number }
  | { kind: "bad-content-type"; contentType: string | null }
  | { kind: "network-error"; name: string }
  | { kind: "guard-rejected"; code: GuardRejectionCode; detail: string };

/** 鉴权/验证码/访问控制状态码：出现即停用来源并标维护（§3.1）。429 单列（退避而非停用）。 */
const RESTRICTED_STATUSES = new Set([401, 403, 407]);

/**
 * 业务消息里的访问限制标记（大小写不敏感子串；中文原样）。
 * 只作用于信封顶层 message 字段，不进入标题/正文内容（官方公告标题含"登录"不代表受限）。
 */
const RESTRICTION_MESSAGE_MARKERS = [
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
] as const;

/** 断言 URL：仅 https、无 userinfo、主机精确匹配白名单。在发请求之前拒绝。 */
export function assertAllowedSourceUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new GuardUrlError("scheme_not_allowed", `仅允许 https，当前 ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new GuardUrlError("userinfo_not_allowed", "URL 不得携带 userinfo");
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new GuardUrlError(
      "host_not_in_allowlist",
      `主机 ${url.hostname} 不在白名单 ${allowedHosts.join(", ")} 内`,
    );
  }
  return url;
}

export class GuardUrlError extends Error {
  constructor(
    readonly code: GuardRejectionCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "GuardUrlError";
  }
}

/** 401/403/407 或信封 message 命中访问限制标记 → restricted（供停用与标维护）。 */
export function classifyRestriction(status: number, message: string | null): string[] {
  const signals: string[] = [];
  if (RESTRICTED_STATUSES.has(status)) {
    signals.push(`http_status_${status}`);
  }
  if (message !== null && message.length <= 200) {
    const lower = message.toLowerCase();
    for (const marker of RESTRICTION_MESSAGE_MARKERS) {
      const hit =
        marker === marker.toLowerCase() ? lower.includes(marker) : message.includes(marker);
      if (hit) {
        signals.push(`message_marker:${marker}`);
      }
    }
  }
  return signals;
}

/**
 * 受限读体：超过上限即停止读取并作废（JSON 截断后不可解析，宁弃勿用）。
 * 上限值来自 limit_profile_measured（max_observed_content_bytes 等），超限是运营信号：
 * 需重新实测并更新登记，不在代码里放宽。
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ buffer: Uint8Array; truncated: boolean }> {
  if (body === null) return { buffer: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer, truncated };
}

/**
 * 受限 fetch：URL 守卫 → GET（redirect:manual）→ 超时中止 → 限类型 → 限量读体。
 * 绝不重试、绝不跟随重定向、绝不换 UA/换路径。fetchFn 可注入（测试替身）。
 */
export async function guardedSourceFetch(
  rawUrl: string,
  limits: GuardedFetchLimits,
  fetchFn: typeof fetch = fetch,
): Promise<GuardedFetchOutcome> {
  let url: URL;
  try {
    url = assertAllowedSourceUrl(rawUrl, limits.allowedHosts);
  } catch (error) {
    if (error instanceof GuardUrlError) {
      return { kind: "guard-rejected", code: error.code, detail: error.detail };
    }
    return { kind: "network-error", name: error instanceof Error ? error.name : "url_parse_error" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetchFn(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": SOURCE_COLLECTOR_USER_AGENT, accept: "application/json" },
    });

    if (response.status >= 301 && response.status <= 308) {
      return {
        kind: "redirect-not-followed",
        status: response.status,
        location: response.headers.get("location"),
      };
    }

    const restrictedSignals = classifyRestriction(response.status, null);
    if (restrictedSignals.length > 0) {
      return { kind: "restricted", status: response.status, signals: restrictedSignals };
    }
    if (response.status === 429) {
      return { kind: "rate-limited", status: 429 };
    }

    const contentType = response.headers.get("content-type");
    if (contentType === null || !contentType.toLowerCase().includes("json")) {
      return { kind: "bad-content-type", contentType };
    }

    const { buffer, truncated } = await readBodyCapped(response.body, limits.maxResponseBytes);
    if (truncated) {
      return { kind: "response-too-large", bytes: buffer.byteLength, cap: limits.maxResponseBytes };
    }
    return {
      kind: "ok",
      status: response.status,
      bodyText: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buffer),
      bytes: buffer.byteLength,
      contentType,
      bodyTruncated: false,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { kind: "timeout" };
    }
    return { kind: "network-error", name: error instanceof Error ? error.name : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}
