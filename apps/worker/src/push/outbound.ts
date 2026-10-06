// P6-02 · 一条 Push 的外发与结果落库（主方案 §7.8、§7.4；ADR-0025）。激活、测试（请求内）与业务通知
// （DeliveryDO 后台）共用这一条路径，不存在第二套外发入口。
//
// 结果处理（§7.8 第三段）：
// - 2xx：平台已接受。只表示推送服务收下了，不是客户端存活或已显示的证明。
// - 404/410：端点明确失效，绑定转 gone，不再外发；不影响该账号的其他绑定。
// - 401/403：先查 VAPID/配置——自动关闭 push_enabled 运行开关并写系统审计，**不删除、不改动任何绑定**；
//   维护者核对配置后在运行开关页重新打开。业务消息转 retry_wait，开关恢复且未过期时再试。
// - 408/429/5xx：临时错误退避（WATCHDOG_INTERVAL 按次数翻倍，Retry-After 更长时取其较大者）；仍计预算。
// - 超时或异常：结果不明（unknown），不盲目重发；Service Worker 的处理回执可以把它确认为已接受。
import {
  EXECUTOR_BATCH_WALL_LIMIT,
  PUSH_MAX_PLAINTEXT_BYTES,
  type PushPayload,
  PushPayloadSchema,
  type PushSendOutcome,
  pushRetryDelayMs,
  pushTtlSeconds,
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SYSTEM_AUDIT_TTL,
} from "@hoyo/contracts";
import { logEvent } from "../shell/logger";
import { recordMetric } from "../shell/observability/metrics";
import { utf8Encode } from "../storage/crypto/bytes";
import { type PushResult, type PushTransport, postPush } from "./client";
import type { PushConfig } from "./config";
import { encryptPushPayload, PushPayloadTooLargeError } from "./crypto";
import type { SubscriptionKeys } from "./store";

export interface OutboundDeps {
  readonly db: D1Database;
  readonly config: PushConfig;
  readonly transport: PushTransport;
}
export interface OutboundMessage {
  readonly messageId: string;
  readonly bindingId: string;
  readonly purpose: "activation" | "test" | "business";
  readonly endpoint: string;
  readonly keys: SubscriptionKeys;
  readonly payload: PushPayload;
  readonly expiresAt: number;
  readonly urgency: "high" | "normal";
  /** push_messages 当前租约版本：结果写回以它为条件，旧执行不能覆盖新状态。 */
  readonly leaseVersion: number;
  /** 本条已计入的尝试次数（含本次），用于退避。 */
  readonly attempts: number;
  readonly deliveryId: string | null;
}

const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function activationPayload(bindingId: string, challenge: string): PushPayload {
  return PushPayloadSchema.parse({
    v: 1,
    kind: "activation",
    binding_id: bindingId,
    challenge,
    title: "HoYo日历 · 浏览器通知验证",
    body: "收到这条通知，说明本浏览器可以接收 HoYo日历 的提醒。",
    url: "/subscription#push-channel",
    tag: `activation:${bindingId}`,
  });
}
export function testPayload(bindingId: string, messageId: string): PushPayload {
  return PushPayloadSchema.parse({
    v: 1,
    kind: "test",
    binding_id: bindingId,
    message_id: messageId,
    title: "HoYo日历 · 测试通知",
    body: "这是一条测试通知：本浏览器此刻可以接收提醒，但不代表以后每条都必达。",
    url: "/account#account-push",
    tag: `test:${bindingId}`,
  });
}

export interface BusinessNode {
  readonly event_title: string;
  readonly node_title: string;
  readonly node_type: string;
  readonly delivery_kind: string;
  readonly milestone_id: string;
  readonly time_exact_ms: number | null;
  readonly time_date: string | null;
  readonly time_precision: string;
  readonly detail_path: string | null;
}

const KIND_COPY: Readonly<Record<string, string>> = {
  rule: "提前提醒",
  ...Object.fromEntries(SUBSCRIPTION_CHANGE_COPY.map((item) => [item.key, item.label])),
};

/** 业务通知：标题为事件名，正文给节点、北京时间与通知类型；链接指向本站最新详情（不是旧通知副本）。 */
export function businessPayload(
  bindingId: string,
  messageId: string,
  node: BusinessNode,
): PushPayload {
  const time =
    node.time_precision === "datetime" && node.time_exact_ms !== null
      ? `${beijing.format(node.time_exact_ms)}（北京时间）`
      : (node.time_date ?? "时间待官方确认");
  const label = Object.hasOwn(SUBSCRIPTION_NODE_TYPE_LABELS, node.node_type)
    ? SUBSCRIPTION_NODE_TYPE_LABELS[node.node_type as keyof typeof SUBSCRIPTION_NODE_TYPE_LABELS]
    : "日程节点";
  const kind = KIND_COPY[node.delivery_kind] ?? "日程更新";
  const url =
    node.detail_path !== null && /^\/(?!\/)[^\s\\]*$/.test(node.detail_path)
      ? node.detail_path
      : "/";
  let title = node.event_title.trim() || "HoYo日历";
  let body = `${kind}：${node.node_title}（${label}）· ${time}`;
  // 单记录明文上限：先截正文，再截标题；只截显示文字，不截凭据与链接。
  const build = () =>
    PushPayloadSchema.parse({
      v: 1,
      kind: "notification",
      binding_id: bindingId,
      message_id: messageId,
      title,
      body,
      url,
      tag: `node:${node.milestone_id}`,
    });
  for (let payload = build(); ; payload = build()) {
    if (utf8Encode(JSON.stringify(payload)).byteLength <= PUSH_MAX_PLAINTEXT_BYTES) return payload;
    if (body.length > 8) body = `${body.slice(0, Math.floor(body.length / 2))}…`;
    else if (title.length > 8) title = `${title.slice(0, Math.floor(title.length / 2))}…`;
    else throw new PushPayloadTooLargeError();
  }
}

/** 401/403：关闭 Push 运行开关并写系统审计；开关已关闭时不重复写。绑定一概不动。 */
export async function closePushForConfigurationCheck(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT INTO system_state(key,value_json,updated_at) VALUES ('push_enabled','false',?)
      ON CONFLICT(key) DO UPDATE SET value_json='false',updated_at=excluded.updated_at
      WHERE system_state.value_json<>'false'`)
      .bind(now),
    db
      .prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,target_id,reason,created_at,expires_at)
      SELECT ?,'system','system','control_disable','operational_control','push_enabled','incident_containment',?,?
      WHERE changes()=1`)
      .bind(crypto.randomUUID(), now, now + SYSTEM_AUDIT_TTL * 1000),
  ]);
}

interface Transition {
  status: "accepted" | "retry_wait" | "unknown" | "failed" | "expired";
  reason: string | null;
  nextAttemptAt: number | null;
}
function transitionFor(message: OutboundMessage, result: PushResult, now: number): Transition {
  const background = message.purpose === "business";
  switch (result.outcome) {
    case "accepted":
      return { status: "accepted", reason: null, nextAttemptAt: null };
    case "unknown":
      return { status: "unknown", reason: "push_result_unknown", nextAttemptAt: null };
    case "gone":
      return { status: "failed", reason: "endpoint_gone", nextAttemptAt: null };
    case "rejected":
      return { status: "failed", reason: "push_rejected", nextAttemptAt: null };
    case "auth_rejected":
    case "retry_later": {
      // 激活与测试由用户在页面上重试；只有业务通知在后台退避重试。
      if (!background)
        return {
          status: "failed",
          reason: result.outcome === "auth_rejected" ? "push_auth_rejected" : "push_retry_later",
          nextAttemptAt: null,
        };
      const next = now + pushRetryDelayMs(message.attempts, result.retryAfterMs);
      return next >= message.expiresAt
        ? { status: "expired", reason: "retry_after_expiry", nextAttemptAt: null }
        : {
            status: "retry_wait",
            reason: result.outcome === "auth_rejected" ? "push_auth_rejected" : "push_retry_later",
            nextAttemptAt: next,
          };
    }
  }
}

/**
 * 加密并外发一次，按结果落库，返回结果分类。调用方已在条件提交里把消息置为 calling_provider
 * 并计入预算；这里只做外调与写回，写回都以 (status='calling_provider', lease_version) 为条件。
 */
export async function sendPushMessage(
  deps: OutboundDeps,
  message: OutboundMessage,
  now: number,
  deadline: number = now + EXECUTOR_BATCH_WALL_LIMIT * 1000,
): Promise<PushSendOutcome> {
  const { db } = deps;
  let result: PushResult;
  try {
    const body = await encryptPushPayload({
      uaPublic: message.keys.p256dh,
      authSecret: message.keys.auth,
      plaintext: utf8Encode(JSON.stringify(PushPayloadSchema.parse(message.payload))),
    });
    result = await postPush(
      deps.transport,
      deps.config,
      {
        endpoint: message.endpoint,
        body,
        ttlSeconds: pushTtlSeconds(message.expiresAt, now),
        urgency: message.urgency,
      },
      now,
      Math.max(1, deadline - now),
    );
  } catch (error) {
    // 外调之前就失败（密钥或载荷不合法）：确定没有发出，按拒绝处理，不重试。
    logEvent("error", "push_prepare_failed", {
      reason_code: error instanceof Error ? error.name : "non_error_throw",
    });
    result = { outcome: "rejected", status: 0, retryAfterMs: null };
  }
  await recordMetric(db, "push_call", now);
  const transition = transitionFor(message, result, now);
  const writes: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE push_messages SET status=?, reason=?, next_attempt_at=?, last_http_status=?,
        accepted_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_at END, lease_expires_at=NULL, updated_at=?
      WHERE id=? AND status='calling_provider' AND lease_version=?`)
      .bind(
        transition.status,
        transition.reason,
        transition.nextAttemptAt,
        result.status,
        transition.status,
        now,
        now,
        message.messageId,
        message.leaseVersion,
      ),
  ];
  if (message.deliveryId !== null)
    writes.push(
      db
        .prepare(`UPDATE deliveries SET status=?, skip_reason=?, updated_at=?
        WHERE id=? AND status='calling_provider'`)
        .bind(transition.status, transition.reason, now, message.deliveryId),
    );
  if (result.outcome === "gone")
    writes.push(
      db
        .prepare(`UPDATE push_bindings SET state='gone', gone_at=?, activation_challenges_json=NULL,
          binding_version=binding_version+1, updated_at=?
        WHERE id=? AND state IN ('pending','active','paused')`)
        .bind(now, now, message.bindingId),
    );
  await db.batch(writes);
  switch (result.outcome) {
    case "gone":
      await recordMetric(db, "push_endpoint_gone", now);
      break;
    case "auth_rejected":
      await recordMetric(db, "push_auth_rejected", now);
      logEvent("error", "push_auth_rejected", { status: result.status, kind: message.purpose });
      await closePushForConfigurationCheck(db, now);
      break;
    case "unknown":
      await recordMetric(db, "push_unknown", now);
      break;
    case "retry_later":
    case "rejected":
      logEvent("warn", "push_not_accepted", {
        status: result.status,
        reason_code: result.outcome,
        kind: message.purpose,
      });
      break;
    default:
      break;
  }
  return result.outcome;
}
