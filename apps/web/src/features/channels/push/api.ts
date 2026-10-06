// F5-01 · Push 接口（主方案 §8.2；D3 §2.8、§1.3）。视图按 contracts 的 Schema 严格解析：
// 缺字段或多字段即失败，不能把未知涂成"已开启"或"验证通过"。
import {
  type PushChannelView,
  PushChannelViewSchema,
  type PushSendOutcome,
  PushSendOutcomeSchema,
} from "@hoyo/contracts";
import { csrfToken } from "../../subscription/save/machine";
import type { BrowserSubscription } from "./browser";

export class PushRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super("push_request_failed");
  }
}

const BASE = "/api/v2/me/push-bindings";

async function call(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(method === "GET"
      ? {}
      : {
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken() ?? "" },
          body: JSON.stringify(body ?? {}),
        }),
  });
  const parsed: unknown = await response.json();
  if (!response.ok) throw new PushRequestError(response.status, parsed);
  return parsed;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("unknown_push_result");
  return value as Record<string, unknown>;
}
function outcome(value: unknown): PushSendOutcome | null {
  if (value === null || value === undefined) return null;
  return PushSendOutcomeSchema.parse(value);
}

export async function readPush(): Promise<PushChannelView> {
  return PushChannelViewSchema.parse(await call("", "GET"));
}

export interface PushCreated {
  result: "created" | "existing";
  binding_id: string;
  /** 只在这一次响应里出现；页面立即存进本机，再发激活通知。 */
  receipt_token: string;
  state: PushChannelView;
}
export async function createPush(subscription: BrowserSubscription): Promise<PushCreated> {
  const body = record(
    await call("", "POST", { endpoint: subscription.endpoint, keys: subscription.keys }),
  );
  if (
    (body.result !== "created" && body.result !== "existing") ||
    typeof body.binding_id !== "string" ||
    typeof body.receipt_token !== "string"
  )
    throw new Error("unknown_push_result");
  return {
    result: body.result,
    binding_id: body.binding_id,
    receipt_token: body.receipt_token,
    state: PushChannelViewSchema.parse(body.state),
  };
}

export interface PushActionResult {
  outcome: PushSendOutcome | null;
  state: PushChannelView;
}
async function action(path: string, method: string, body: unknown): Promise<PushActionResult> {
  const result = record(await call(path, method, body));
  if (result.result !== "completed") throw new Error("unknown_push_result");
  return { outcome: outcome(result.outcome), state: PushChannelViewSchema.parse(result.state) };
}
export const pausePush = (id: string, version: number) =>
  action(`/${id}`, "PATCH", { action: "pause", expected_version: version });
export const activatePush = (id: string, version: number) =>
  action(`/${id}`, "PATCH", { action: "activate", expected_version: version });
export const testPush = (id: string, version: number) =>
  action(`/${id}/test`, "POST", { expected_version: version });
export const renewPush = (id: string, version: number) =>
  action(`/${id}/renew`, "POST", { expected_version: version });
export const deletePush = (id: string) => action(`/${id}`, "DELETE", {});

/** 公开能力：只有 open 才显示开启入口（前端 §9.3 第一段）；读取失败按 unknown。 */
export async function pushCapability(): Promise<"open" | "closed" | "unknown"> {
  try {
    const response = await fetch("/api/v2/status", { credentials: "omit" });
    const body = (await response.json()) as { capabilities?: { push?: unknown } };
    const value = body.capabilities?.push;
    return value === "open" || value === "closed" ? value : "unknown";
  } catch {
    return "unknown";
  }
}
