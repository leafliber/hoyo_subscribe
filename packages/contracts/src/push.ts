// P6 · 可选 Web Push 的共享语义（主方案 §7.8、§8.2、§9.4、附录 A.4；前端 §9.3；D3 §2.8；ADR-0025）。
//
// 本文件是 Push 业务规则的唯一定义源，Worker 与 Web 共同消费（AGENTS.md 规则 3）：
// - 推送服务域名登记与端点校验（§7.8"验证精确 HTTPS 推送服务域名、端点与加密密钥"；
//   接口不得成为任意 Webhook/SSRF 入口）；
// - 绑定状态、视图与请求 Schema（D3 §2.8：只给事实，不给动作表）；
// - 浏览器推导置灰的纯函数（D3 §1.2）；
// - 预算、租期、激活期限、合并写入间隔与退避（附录 A.4，数值只取注册表）；
// - 推送服务响应分类（§7.8：404/410 停用端点；401/403 先查 VAPID/配置，不批量删除用户）。
// 纯函数、无数据库或浏览器依赖。
import { z } from "zod";
import { ACTION_BLOCK_REASONS } from "./account-lifecycle";
import { SubscriptionStateSchema } from "./enums";
import { buildApiErrorBody } from "./errors/codes";
import {
  PUSH_ACTIVATION_ATTEMPTS,
  PUSH_ACTIVATION_TTL,
  PUSH_ACTIVE_MAX,
  PUSH_CRITICAL_RESERVED_DAY,
  PUSH_LEASE,
  PUSH_NEW_DAY,
  PUSH_PENDING_MAX,
  PUSH_RECEIPT_WRITE_INTERVAL,
  PUSH_SEND_DAY,
  PUSH_STALE_GRACE,
  PUSH_TEST_COOLDOWN,
  PUSH_TEST_DAY,
  PUSH_TOTAL_MAX,
  PUSH_USER_MAX,
  SECRET_BITS,
  WATCHDOG_INTERVAL,
} from "./params/registry";

const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

// ---------------------------------------------------------------------------
// 推送服务登记与端点校验（§7.8；ADR-0025 §1）
// ---------------------------------------------------------------------------

/** 已登记的推送服务。新增服务须先改本表并经 ADR；不接受任何未登记主机。 */
export const PUSH_SERVICES = ["fcm", "mozilla", "apple", "wns"] as const;
export type PushService = (typeof PUSH_SERVICES)[number];
export const PushServiceSchema = z.enum(PUSH_SERVICES);

/**
 * 推送服务主机登记。除 WNS 外都是精确主机名；WNS 按区域分配主机，
 * 只接受"一个 DNS 标签 + notify.windows.com"，不接受更深的子域或其他后缀。
 */
export const PUSH_SERVICE_HOSTS: readonly {
  readonly service: PushService;
  readonly host: string;
  readonly singleLabelSubdomain?: true;
}[] = [
  { service: "fcm", host: "fcm.googleapis.com" },
  { service: "mozilla", host: "updates.push.services.mozilla.com" },
  { service: "apple", host: "web.push.apple.com" },
  { service: "wns", host: "notify.windows.com", singleLabelSubdomain: true },
];

/** 界面显示名：只说明推送服务，不解析 UA（UA 不是授权，也不收集）。 */
export const PUSH_SERVICE_LABELS: Readonly<Record<PushService, string>> = {
  fcm: "Chrome 等浏览器（Google 推送服务）",
  mozilla: "Firefox（Mozilla 推送服务）",
  apple: "Safari / iPhone 主屏幕应用（Apple 推送服务）",
  wns: "Edge（Windows 推送服务）",
};

export type PushEndpointRejection =
  | "not_url"
  | "not_canonical"
  | "scheme_not_https"
  | "userinfo_not_allowed"
  | "port_not_allowed"
  | "fragment_not_allowed"
  | "path_required"
  | "host_not_allowed";

export type PushEndpointCheck =
  | { readonly ok: true; readonly service: PushService; readonly origin: string }
  | { readonly ok: false; readonly reason: PushEndpointRejection };

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 端点校验：必须是规范化后与原文逐字相同的 https URL，无用户信息、无端口、无片段、有路径，
 * 主机属于登记表。只返回服务与 origin（VAPID aud 用），不回显输入。
 */
export function checkPushEndpoint(raw: string): PushEndpointCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_url" };
  }
  // 逐字一致排除大小写、反斜杠、点段、空白等解析歧义；端点由浏览器原样给出，本就是规范形式。
  if (url.href !== raw) return { ok: false, reason: "not_canonical" };
  if (url.protocol !== "https:") return { ok: false, reason: "scheme_not_https" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "userinfo_not_allowed" };
  if (url.port !== "") return { ok: false, reason: "port_not_allowed" };
  if (url.hash !== "") return { ok: false, reason: "fragment_not_allowed" };
  if (url.pathname === "/" || url.pathname === "") return { ok: false, reason: "path_required" };
  const host = url.hostname;
  for (const entry of PUSH_SERVICE_HOSTS) {
    if (host === entry.host && entry.singleLabelSubdomain !== true)
      return { ok: true, service: entry.service, origin: url.origin };
    if (entry.singleLabelSubdomain === true && host.endsWith(`.${entry.host}`)) {
      const label = host.slice(0, -(entry.host.length + 1));
      if (DNS_LABEL.test(label)) return { ok: true, service: entry.service, origin: url.origin };
    }
  }
  return { ok: false, reason: "host_not_allowed" };
}

/** base64url（无填充；兼容末尾 '=' 填充）解码后的字节长度；非法返回 null。 */
export function base64UrlByteLength(value: string): number | null {
  const trimmed = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(trimmed) || trimmed.length % 4 === 1) return null;
  return Math.floor((trimmed.length * 3) / 4);
}

/** p256dh 为未压缩 P-256 点（65 字节，0x04 开头）；auth 为 16 字节（RFC 8291 §3）。 */
export const PUSH_P256DH_BYTES = 65;
export const PUSH_AUTH_SECRET_BYTES = 16;

export type PushKeyRejection = "p256dh_invalid" | "auth_invalid";
/** 只检查形状；点是否在曲线上由 Worker 用 WebCrypto 导入时再验。 */
export function checkPushKeys(keys: { p256dh: string; auth: string }): PushKeyRejection | null {
  if (
    base64UrlByteLength(keys.p256dh) !== PUSH_P256DH_BYTES ||
    !/^B[A-Za-z0-9_-]/.test(keys.p256dh)
  )
    return "p256dh_invalid";
  if (base64UrlByteLength(keys.auth) !== PUSH_AUTH_SECRET_BYTES) return "auth_invalid";
  return null;
}

// ---------------------------------------------------------------------------
// 状态、视图与请求（D3 §2.8；§8.2）
// ---------------------------------------------------------------------------

/** 绑定状态：等待激活 / 已激活 / 已暂停 / 失效（推送服务明确 404/410）。 */
export const PUSH_BINDING_STATES = ["pending", "active", "paused", "gone"] as const;
export type PushBindingState = (typeof PUSH_BINDING_STATES)[number];
export const PushBindingStateSchema = z.enum(PUSH_BINDING_STATES);

/** 暂停原因：用户 / 安全暂停（紧急停用、恢复登录、删除账号）/ 租期到期 / 灾难恢复。 */
export const PUSH_PAUSE_REASONS = ["user", "safety", "lease_expired", "restore"] as const;
export type PushPauseReason = (typeof PUSH_PAUSE_REASONS)[number];

/** conflict 的 Push 细分原因：端点已归属其他账号 / 绑定版本或状态已变化。 */
export const PUSH_CONFLICT_REASONS = [
  "push_endpoint_owned_elsewhere",
  "push_binding_changed",
] as const;
export type PushConflictReason = (typeof PUSH_CONFLICT_REASONS)[number];

/** 一次外发的结果（平台接受 ≠ 客户端显示，§7.8）。 */
export const PUSH_SEND_OUTCOMES = [
  "accepted",
  "gone",
  "auth_rejected",
  "retry_later",
  "rejected",
  "unknown",
] as const;
export type PushSendOutcome = (typeof PUSH_SEND_OUTCOMES)[number];
export const PushSendOutcomeSchema = z.enum(PUSH_SEND_OUTCOMES);

/** 实际外发记录（push_messages）的用途与状态；迁移 0029 的 CHECK 与此逐值对账。 */
export const PUSH_MESSAGE_PURPOSES = ["activation", "test", "business"] as const;
export type PushMessagePurpose = (typeof PUSH_MESSAGE_PURPOSES)[number];
export const PUSH_MESSAGE_STATUSES = [
  "pending",
  "calling_provider",
  "accepted",
  "retry_wait",
  "unknown",
  "failed",
  "skipped",
  "superseded",
  "expired",
] as const;
export type PushMessageStatus = (typeof PUSH_MESSAGE_STATUSES)[number];

/** 推送服务 HTTP 状态分类（§7.8 第三段）。重定向不跟随，按拒绝处理。 */
export function classifyPushResponse(status: number): Exclude<PushSendOutcome, "unknown"> {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 408 || status === 429 || status >= 500) return "retry_later";
  return "rejected";
}

const Time = z.int().nonnegative();
const Remaining = z.union([z.int().nonnegative(), z.literal("unknown")]);

export const PushBindingViewSchema = z.strictObject({
  id: z.uuid(),
  state: PushBindingStateSchema,
  service: PushServiceSchema,
  binding_version: z.int().nonnegative(),
  created_at: Time,
  activated_at: Time.nullable(),
  activation: z
    .strictObject({
      deadline: Time,
      attempts: z.int().nonnegative(),
      last_sent_at: Time.nullable(),
      last_outcome: PushSendOutcomeSchema.nullable(),
    })
    .nullable(),
  lease_expires_at: Time.nullable(),
  last_processed_at: Time.nullable(),
  last_test: z
    .strictObject({
      sent_at: Time,
      outcome: PushSendOutcomeSchema.nullable(),
      received_at: Time.nullable(),
    })
    .nullable(),
  paused_reason: z.enum(PUSH_PAUSE_REASONS).nullable(),
  gone_at: Time.nullable(),
});
export type PushBindingView = z.infer<typeof PushBindingViewSchema>;

/** `GET /api/v2/me/push-bindings`：本人事实 + server_time；不含端点、密钥或 receipt 凭证。 */
export const PushChannelViewSchema = z.strictObject({
  server_time: Time,
  /** 部署配置（VAPID、站点源、字段密钥）是否齐备；不齐时无法创建绑定。 */
  configured: z.boolean(),
  /** VAPID 公钥（base64url 未压缩点），供浏览器订阅；未配置时为 null。不是秘密。 */
  application_server_key: z.string().nullable(),
  /** Push 能力：运行开关 × 外发总闸 × 部署配置 × 非只读，与公开状态同一推导。 */
  service: z.enum(["open", "closed", "unknown"]),
  session_state: z.enum(["active", "pending"]),
  recovery_code_required: z.boolean(),
  recovery_code_saved: z.boolean(),
  subscription_state: SubscriptionStateSchema,
  remaining: z.strictObject({
    user: z.int().nonnegative(),
    pending: Remaining,
    active: Remaining,
    total: Remaining,
    new_today: Remaining,
    test_today: Remaining,
    send_today: Remaining,
  }),
  bindings: z.array(PushBindingViewSchema).max(PUSH_USER_MAX),
});
export type PushChannelView = z.infer<typeof PushChannelViewSchema>;

/** SECRET_BITS 随机秘密的 base64url 无填充长度（receipt token、激活挑战）。 */
export const PUSH_SECRET_TEXT_LENGTH = Math.ceil(SECRET_BITS / 6);
const SecretText = z
  .string()
  .length(PUSH_SECRET_TEXT_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PushCreateRequestSchema = z.strictObject({
  endpoint: z.string().min(1),
  keys: z.strictObject({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushCreateRequest = z.infer<typeof PushCreateRequestSchema>;

/** PATCH：暂停，或（重新）发送可见激活通知——已暂停的绑定恢复前必须重新验证接收。 */
export const PUSH_PATCH_ACTIONS = ["pause", "activate"] as const;
export const PushPatchRequestSchema = z.strictObject({
  action: z.enum(PUSH_PATCH_ACTIONS),
  expected_version: z.int().nonnegative(),
});
export const PushVersionRequestSchema = z.strictObject({
  expected_version: z.int().nonnegative(),
});

/** receipt 窄能力：只确认本浏览器接收，不能取邮箱、改账号或管理其他设备（§7.8）。 */
export const PushActivateRequestSchema = z.strictObject({
  receipt_token: SecretText,
  challenge: SecretText,
});
export const PushProcessedRequestSchema = z.strictObject({
  receipt_token: SecretText,
  message_id: z.uuid(),
});

// ---------------------------------------------------------------------------
// 加密载荷（服务器 → Service Worker；只经 RFC 8291 端到端加密传输）
// ---------------------------------------------------------------------------

const PayloadText = z.string().min(1);
/** 站内相对路径：以单个 "/" 开头，不能跳到其他源。 */
const SitePath = z.string().regex(/^\/(?!\/)[^\s\\]*$/);
const PayloadBase = {
  v: z.literal(1),
  binding_id: z.uuid(),
  title: PayloadText,
  body: PayloadText,
  url: SitePath,
  tag: PayloadText,
};
export const PushPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...PayloadBase, kind: z.literal("activation"), challenge: SecretText }),
  z.strictObject({ ...PayloadBase, kind: z.literal("test"), message_id: z.uuid() }),
  z.strictObject({ ...PayloadBase, kind: z.literal("notification"), message_id: z.uuid() }),
]);
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/**
 * RFC 8291 单记录上限：推送服务至少接受 4096 字节密文（RFC 8030 §7.2）；
 * 头部 86 字节（salt 16 + rs 4 + idlen 1 + keyid 65）、GCM 标签 16 字节、分隔符 1 字节。
 * 协议常量，不是业务参数。
 */
export const PUSH_MAX_PLAINTEXT_BYTES = 4096 - 86 - 16 - 1;

// ---------------------------------------------------------------------------
// 预算、租期、期限与退避（附录 A.4；数值只取注册表）
// ---------------------------------------------------------------------------

/** 取消/撤回、重要更正、晚发现为关键通知，可使用 PUSH_CRITICAL_RESERVED_DAY 预留。 */
export const PUSH_CRITICAL_KINDS = [
  "cancelled_or_retracted",
  "important_change",
  "late_discovery",
] as const;
export function isCriticalPushKind(deliveryKind: string): boolean {
  return (PUSH_CRITICAL_KINDS as readonly string[]).includes(deliveryKind);
}

/** 当日外发上限：普通外发（常规提醒、新活动、激活、测试）不能动用关键预留。 */
export function pushSendDayLimit(critical: boolean): number {
  return critical ? PUSH_SEND_DAY : PUSH_SEND_DAY - PUSH_CRITICAL_RESERVED_DAY;
}

/** capacity_state 日计数键（键含 UTC 日：新的一天就是新键，不跨日结转）。 */
export function pushCounterKeys(utcDayKey: string): {
  send: string;
  test: string;
  created: string;
} {
  return {
    send: `push:send:${utcDayKey}`,
    test: `push:test:${utcDayKey}`,
    created: `push:new:${utcDayKey}`,
  };
}

export function pushLeaseExpiresAt(start: number): number {
  return start + PUSH_LEASE * DAY_MS;
}
export function pushActivationDeadline(start: number): number {
  return start + PUSH_ACTIVATION_TTL * SECOND_MS;
}
/** 失效宽限终点：暂停或失效后超过它才清理（§9.4"过期暂停，宽限后清理"）。 */
export function pushStaleCleanupBefore(now: number): number {
  return now - PUSH_STALE_GRACE * DAY_MS;
}
/** 真实业务确认的合并写入：距上次写入满 PUSH_RECEIPT_WRITE_INTERVAL 才写；激活独立处理。 */
export function pushReceiptWriteDue(lastProcessedAt: number | null, now: number): boolean {
  return lastProcessedAt === null || now - lastProcessedAt >= PUSH_RECEIPT_WRITE_INTERVAL * DAY_MS;
}
export function pushTestReadyAt(lastTestAt: number | null): number {
  return lastTestAt === null ? 0 : lastTestAt + PUSH_TEST_COOLDOWN * SECOND_MS;
}
/** 同一绑定的激活通知与测试通知同属用户触发的可见通知，共用 PUSH_TEST_COOLDOWN（ADR-0025）。 */
export function pushActivationResendReadyAt(lastSentAt: number | null): number {
  return pushTestReadyAt(lastSentAt);
}

/**
 * 临时错误退避：沿用 watchdog 周期按次数翻倍，不另设参数；推送服务给出更长的
 * Retry-After 时取其较大者。重试仍计入预算，到期（expires_at）后不再尝试。
 */
export function pushRetryDelayMs(attempts: number, retryAfterMs: number | null = null): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 16);
  return Math.max(WATCHDOG_INTERVAL * SECOND_MS * 2 ** exponent, retryAfterMs ?? 0);
}

/** 推送服务 TTL 头（秒）：到消息自身失效为止，不让推送服务替我们保存过期提醒。 */
export function pushTtlSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor((expiresAt - now) / SECOND_MS));
}

// ---------------------------------------------------------------------------
// 浏览器推导置灰（D3 §1.2）：动作码与受阻原因的闭合枚举
// ---------------------------------------------------------------------------

export const PUSH_ACTIONS = ["enable", "activate", "test", "renew", "pause", "delete"] as const;
export type PushAction = (typeof PUSH_ACTIONS)[number];

export const PUSH_BLOCK_REASONS = [
  ...ACTION_BLOCK_REASONS,
  "state_mismatch",
  "activation_expired",
  "attempts_exhausted",
  "cooldown",
] as const;
export type PushBlockReason = (typeof PUSH_BLOCK_REASONS)[number];
export type PushActionAvailability =
  | { allowed: true }
  | { allowed: false; reason: PushBlockReason; retry_at?: number };

const allowed: PushActionAvailability = { allowed: true };
const blocked = (reason: PushBlockReason, retry_at?: number): PushActionAvailability =>
  retry_at === undefined ? { allowed: false, reason } : { allowed: false, reason, retry_at };

/** 会话前置：待激活会话与恢复受限会话都不能写（外壳同样拒绝）。 */
function sessionGate(view: PushChannelView): PushActionAvailability {
  if (view.session_state === "pending") return blocked("pending_activation");
  if (view.recovery_code_required) return blocked("recovery_code_unconfirmed");
  return allowed;
}
/** 开启前置（与写入守卫同一顺序）：会话、恢复码、订阅、能力。 */
function channelGate(view: PushChannelView): PushActionAvailability {
  const session = sessionGate(view);
  if (!session.allowed) return session;
  if (!view.recovery_code_saved) return blocked("recovery_code_not_saved");
  if (view.subscription_state !== "initialized") return blocked("subscription_uninitialized");
  if (view.service !== "open" || !view.configured) return blocked("feature_closed");
  return allowed;
}
function counted(remaining: number | "unknown"): boolean {
  return remaining !== "unknown" && remaining > 0;
}
/** 激活期限已过的 pending 绑定已经失败：同一端点重新开启时在同一事务内替换它。 */
export function isPushActivationExpired(binding: PushBindingView, now: number): boolean {
  return (
    binding.state === "pending" &&
    (binding.activation === null || binding.activation.deadline <= now)
  );
}
/** 本浏览器的旧绑定已失效（端点 404/410）或激活已过期：可以用同一端点重新开启。 */
export function isPushBindingReplaceable(binding: PushBindingView, now: number): boolean {
  return binding.state === "gone" || isPushActivationExpired(binding, now);
}

/**
 * 新建绑定（或在同一事务内替换本浏览器已失效的旧绑定）的前置。
 * 替换时旧行同批删除，不额外占本人或全站存量名额。
 */
export function pushEnableAvailability(
  view: PushChannelView,
  replacing: boolean,
): PushActionAvailability {
  const gate = channelGate(view);
  if (!gate.allowed) return gate;
  if (!replacing && view.remaining.user <= 0) return blocked("capacity_full");
  if (view.remaining.total === "unknown" || view.remaining.pending === "unknown")
    return blocked("feature_closed");
  if ((!replacing && view.remaining.total <= 0) || view.remaining.pending <= 0)
    return blocked("capacity_full");
  if (!counted(view.remaining.new_today) || !counted(view.remaining.send_today))
    return blocked("quota_paused");
  return allowed;
}

/**
 * 只是展示提示；写接口在条件提交里实时复核，被拒时返回同一原因。
 * `binding` 是本浏览器持有的绑定（按本机保存的绑定 ID 找到，不按 endpoint 认领）；
 * 为空时只有 enable 有意义。
 */
export function derivePushActions(
  view: PushChannelView,
  binding: PushBindingView | null,
  now: number,
): Record<PushAction, PushActionAvailability> {
  const gate = channelGate(view);
  const replacing = binding !== null && isPushBindingReplaceable(binding, now);
  const enable =
    gate.allowed && binding !== null && !replacing
      ? blocked("state_mismatch")
      : pushEnableAvailability(view, replacing);
  if (binding === null) {
    const none = blocked("state_mismatch");
    return { enable, activate: none, test: none, renew: none, pause: none, delete: none };
  }
  const activate = (() => {
    if (!gate.allowed) return gate;
    if (binding.state === "pending") {
      const activation = binding.activation;
      if (activation === null || activation.deadline <= now) return blocked("activation_expired");
      if (activation.attempts >= PUSH_ACTIVATION_ATTEMPTS) return blocked("attempts_exhausted");
      const ready = pushActivationResendReadyAt(activation.last_sent_at);
      if (ready > now) return blocked("cooldown", ready);
    } else if (binding.state === "paused") {
      if (!counted(view.remaining.pending))
        return view.remaining.pending === "unknown"
          ? blocked("feature_closed")
          : blocked("capacity_full");
    } else return blocked("state_mismatch");
    if (!counted(view.remaining.send_today)) return blocked("quota_paused");
    return allowed;
  })();
  const test = (() => {
    if (!gate.allowed) return gate;
    if (binding.state !== "active") return blocked("state_mismatch");
    const ready = pushTestReadyAt(binding.last_test?.sent_at ?? null);
    if (ready > now) return blocked("cooldown", ready);
    if (!counted(view.remaining.test_today) || !counted(view.remaining.send_today))
      return blocked("quota_paused");
    return allowed;
  })();
  const renew = (() => {
    if (!gate.allowed) return gate;
    return binding.state === "active" ? allowed : blocked("state_mismatch");
  })();
  // 暂停与删除是终止路径（§9.5）：不受订阅、能力开关、名额或日额度阻断；只要求可写会话。
  const terminal = sessionGate(view);
  const pause =
    terminal.allowed && binding.state !== "pending" && binding.state !== "active"
      ? blocked("state_mismatch")
      : terminal;
  return { enable, activate, test, renew, pause, delete: terminal };
}

/** 写入拒绝与推导函数共用同一闭合原因；七类错误本体仍由全站错误模型构造。 */
export function pushRefusal(reason: PushBlockReason, retryAt?: number, now?: number) {
  const body = (() => {
    switch (reason) {
      case "pending_activation":
      case "recovery_code_unconfirmed":
      case "recovery_code_not_saved":
      case "recent_auth_required":
        return buildApiErrorBody("unauthorized", { code: "unauthorized", reason });
      case "capacity_full":
        return buildApiErrorBody("capacity_reached", {
          code: "capacity_reached",
          capability: "push",
        });
      case "quota_paused":
        return buildApiErrorBody("quota_paused", { code: "quota_paused", scope: "push" });
      case "feature_closed":
        return buildApiErrorBody("temporarily_unavailable", { code: "temporarily_unavailable" });
      case "cooldown":
        return buildApiErrorBody("rate_limited", {
          code: "rate_limited",
          ...(retryAt !== undefined && now !== undefined
            ? { retry_after_ms: Math.max(0, retryAt - now) }
            : {}),
        });
      case "state_mismatch":
        return buildApiErrorBody("conflict", { code: "conflict", reason: "push_binding_changed" });
      default:
        return buildApiErrorBody("validation", {
          code: "validation",
          fields: [{ path: "", reason }],
        });
    }
  })();
  return { ...body, blocked_reason: reason };
}

/** 同 endpoint 已归属其他账号：冲突，不抢占、不认领（§7.8 第二段）。 */
export function pushOwnedElsewhereRefusal() {
  return {
    ...buildApiErrorBody("conflict", { code: "conflict", reason: "push_endpoint_owned_elsewhere" }),
    blocked_reason: "state_mismatch" as const,
  };
}

/** 参数与容量的公开说明（界面文案只引用这些值，不另写数字）。 */
export const PUSH_DISCLOSURE = {
  user_max: PUSH_USER_MAX,
  active_max: PUSH_ACTIVE_MAX,
  total_max: PUSH_TOTAL_MAX,
  pending_max: PUSH_PENDING_MAX,
  new_day: PUSH_NEW_DAY,
  test_day: PUSH_TEST_DAY,
  test_cooldown_seconds: PUSH_TEST_COOLDOWN,
  activation_ttl_seconds: PUSH_ACTIVATION_TTL,
  activation_attempts: PUSH_ACTIVATION_ATTEMPTS,
  lease_days: PUSH_LEASE,
  stale_grace_days: PUSH_STALE_GRACE,
} as const;

/** 账号摘要里的 Push 一行（D3 §2.10：有没有、什么状态）。 */
export function pushSummaryState(counts: {
  pending: number;
  active: number;
  paused: number;
  gone: number;
}): "none" | "active" | "inactive" {
  if (counts.active > 0) return "active";
  return counts.pending + counts.paused + counts.gone === 0 ? "none" : "inactive";
}

/** ACTION_BLOCK_REASONS 的子集仍沿用原含义；新增原因只属于 Push。 */
export function isPushBlockReason(value: string): value is PushBlockReason {
  return (PUSH_BLOCK_REASONS as readonly string[]).includes(value);
}
