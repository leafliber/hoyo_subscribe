// P6 · 向推送服务发出一条 Web Push（主方案 §7.8；RFC 8030、RFC 8291、RFC 8292；ADR-0025）。
//
// 接口不得成为任意 Webhook/SSRF 入口：端点在登记时校验一次，外发前对解密出的端点**再校验一次**
// （只认登记的推送服务主机）；不跟随重定向；有超时；不读响应正文，不回显任何推送服务返回的内容。
import { checkPushEndpoint, classifyPushResponse, type PushSendOutcome } from "@hoyo/contracts";
import type { PushConfig } from "./config";
import { vapidAuthorization } from "./crypto";

/** 可注入的外发函数（测试用替身；生产即全局 fetch）。 */
export type PushTransport = (input: string, init: RequestInit) => Promise<Response>;

export interface PushRequest {
  readonly endpoint: string;
  readonly body: Uint8Array;
  /** 推送服务保存消息的秒数（到消息自身失效为止）。 */
  readonly ttlSeconds: number;
  readonly urgency: "high" | "normal";
}

export type PushResult =
  | {
      readonly outcome: Exclude<PushSendOutcome, "unknown">;
      readonly status: number;
      readonly retryAfterMs: number | null;
    }
  | { readonly outcome: "unknown"; readonly status: null; readonly retryAfterMs: null };

/** Retry-After：秒数或 HTTP 日期；不可解析时为空。 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * 发出一次请求。超时、网络异常与被拒的重定向以外的一切结果都按状态码分类；
 * 超时与异常是"结果不明"：推送服务可能已经接受，调用方不得盲目重发（§7.4 同一原则）。
 */
export async function postPush(
  transport: PushTransport,
  config: PushConfig,
  request: PushRequest,
  now: number,
  timeoutMs: number,
): Promise<PushResult> {
  const checked = checkPushEndpoint(request.endpoint);
  if (!checked.ok) return { outcome: "rejected", status: 0, retryAfterMs: null };
  const body = new ArrayBuffer(request.body.byteLength);
  new Uint8Array(body).set(request.body);
  let response: Response;
  try {
    response = await transport(request.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: await vapidAuthorization(config.vapid, checked.origin, config.subject, now),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(request.ttlSeconds),
        urgency: request.urgency,
      },
      body,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch {
    return { outcome: "unknown", status: null, retryAfterMs: null };
  }
  // 正文可能很大或含推送服务的诊断串：不读、不落盘，直接释放。
  try {
    await response.body?.cancel();
  } catch {
    /* 已关闭 */
  }
  return {
    outcome: classifyPushResponse(response.status),
    status: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now),
  };
}
