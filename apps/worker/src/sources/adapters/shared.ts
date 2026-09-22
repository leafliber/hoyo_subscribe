// 适配器共用：URL 构造、受限 fetch 的失败映射、信封解析（任务卡 P3-01，A-P3-FETCH）。
// 解析逻辑参照 P0-02 采集核心（scripts/probes/source-samples/collect-core.mjs，两类信封
// 形状的实测结论），按生产要求以 TypeScript 重写；不 import 探针代码。

import type { GuardedFetchOutcome } from "../guarded-fetch";
import { guardedSourceFetch } from "../guarded-fetch";
import type { SourceRegistryEntry } from "../registry";
import type { SourceFetchFailure } from "../types";

/** 键序稳定的 query 编码（便于测试断言请求形状）。 */
export function encodeQuery(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function buildSourceUrl(
  host: string,
  path: string,
  params: Readonly<Record<string, string>>,
): string {
  return `https://${host}${path}?${encodeQuery(params)}`;
}

/** guardedSourceFetch 结果 → 统一失败分类。restricted/rate-limited 原样透出（调用方停用/退避）。 */
export function outcomeToFailure(outcome: GuardedFetchOutcome): SourceFetchFailure | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "restricted":
      return { kind: "restricted", status: outcome.status, signals: outcome.signals };
    case "rate-limited":
      return { kind: "rate-limited", status: outcome.status };
    case "redirect-not-followed":
      return {
        kind: "redirect-not-followed",
        status: outcome.status,
        location: outcome.location,
      };
    case "timeout":
      return { kind: "timeout" };
    case "response-too-large":
      return { kind: "response-too-large", bytes: outcome.bytes, cap: outcome.cap };
    case "bad-content-type":
      return { kind: "bad-content-type", contentType: outcome.contentType };
    case "network-error":
      return { kind: "network-error", name: outcome.name };
    case "guard-rejected":
      return { kind: "guard-rejected", code: outcome.code, detail: outcome.detail };
  }
}

export interface FetchedBody {
  bodyText: string;
  bytes: number;
  bodyTruncated: boolean;
}

/** 受限拉取 JSON 文本：任何非 ok 结果都映射为失败，绝不重试。 */
export async function fetchJsonBody(
  entry: SourceRegistryEntry,
  url: string,
  fetchFn: typeof fetch,
): Promise<{ body: FetchedBody } | { failure: SourceFetchFailure }> {
  const outcome = await guardedSourceFetch(
    url,
    { ...entry.requestLimits, allowedHosts: entry.approvedHosts },
    fetchFn,
  );
  if (outcome.kind !== "ok") {
    const failure = outcomeToFailure(outcome);
    if (failure === null) {
      // 所有非 ok 分支在 outcomeToFailure 都有映射；走到这里是映射缺口，按缺陷暴露。
      throw new Error(`未映射的受限 fetch 结果：${outcome.kind}`);
    }
    return { failure };
  }
  return { body: { bodyText: outcome.bodyText, bytes: outcome.bytes, bodyTruncated: false } };
}

/** 官方响应顶层信封：retcode/message/data。解析失败或形状不对 → malformed（complete 必须 false）。 */
export function parseEnvelope(
  bodyText: string,
):
  | { ok: true; retcode: number; message: string | null; data: Record<string, unknown> }
  | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  const envelope = parsed as { retcode?: unknown; message?: unknown; data?: unknown };
  if (typeof envelope.retcode !== "number") {
    return { ok: false };
  }
  return {
    ok: true,
    retcode: envelope.retcode,
    message: typeof envelope.message === "string" ? envelope.message : null,
    data:
      envelope.data !== null && typeof envelope.data === "object" && !Array.isArray(envelope.data)
        ? (envelope.data as Record<string, unknown>)
        : {},
  };
}

/** 数值或字符串 ID → 字符串（上游 ID 存字符串，§3.1；number 立即 String 化防精度歧义）。 */
export function asExternalId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
