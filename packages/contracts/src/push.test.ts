// A-P6-BIND / A-P6-SEND · Push 共享语义的纯函数（主方案 §7.8、附录 A.4；D3 §1.2、§2.8；ADR-0025）。
import { describe, expect, it } from "vitest";
import { API_ERROR_STATUS } from "./errors/codes";
import {
  PUSH_ACTIVATION_ATTEMPTS,
  PUSH_ACTIVATION_TTL,
  PUSH_CRITICAL_RESERVED_DAY,
  PUSH_LEASE,
  PUSH_RECEIPT_WRITE_INTERVAL,
  PUSH_SEND_DAY,
  PUSH_STALE_GRACE,
  PUSH_TEST_COOLDOWN,
  PUSH_USER_MAX,
  SECRET_BITS,
  WATCHDOG_INTERVAL,
} from "./params/registry";
import {
  base64UrlByteLength,
  checkPushEndpoint,
  checkPushKeys,
  classifyPushResponse,
  derivePushActions,
  isCriticalPushKind,
  isPushBindingReplaceable,
  PUSH_MAX_PLAINTEXT_BYTES,
  PUSH_SECRET_TEXT_LENGTH,
  type PushBindingView,
  type PushChannelView,
  PushChannelViewSchema,
  PushPayloadSchema,
  pushActivationDeadline,
  pushCounterKeys,
  pushLeaseExpiresAt,
  pushOwnedElsewhereRefusal,
  pushReceiptWriteDue,
  pushRefusal,
  pushRetryDelayMs,
  pushSendDayLimit,
  pushStaleCleanupBefore,
  pushSummaryState,
  pushTestReadyAt,
  pushTtlSeconds,
} from "./push";

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const id = "00000000-0000-4000-8000-000000000001";
const secret = "A".repeat(PUSH_SECRET_TEXT_LENGTH);

function view(overrides: Partial<PushChannelView> = {}): PushChannelView {
  return {
    server_time: now,
    configured: true,
    application_server_key: "BP".padEnd(87, "A"),
    service: "open",
    session_state: "active",
    recovery_code_required: false,
    subscription_state: "initialized",
    remaining: {
      user: PUSH_USER_MAX,
      pending: 10,
      active: 10,
      total: 10,
      new_today: 10,
      test_today: 10,
      send_today: 10,
    },
    bindings: [],
    ...overrides,
  };
}
function binding(overrides: Partial<PushBindingView> = {}): PushBindingView {
  return {
    id,
    state: "active",
    service: "fcm",
    binding_version: 3,
    created_at: now - DAY,
    activated_at: now - DAY,
    activation: null,
    lease_expires_at: now + DAY,
    last_processed_at: null,
    last_test: null,
    paused_reason: null,
    gone_at: null,
    ...overrides,
  };
}

describe("A-P6-BIND 推送服务端点：精确 HTTPS 域名，拒绝任意 Webhook/SSRF", () => {
  it("四个登记服务的真实端点形状被接受，并给出 VAPID aud 用的 origin", () => {
    const cases = [
      ["https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y", "fcm"],
      ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk", "mozilla"],
      ["https://web.push.apple.com/QGuQyavXutnMK8aJ", "apple"],
      ["https://wns2-sg2p.notify.windows.com/w/?token=BQYAAAB%2bx", "wns"],
    ] as const;
    for (const [endpoint, service] of cases) {
      const result = checkPushEndpoint(endpoint);
      expect(result).toEqual({ ok: true, service, origin: new URL(endpoint).origin });
    }
  });

  it("拒绝非 https、用户信息、端口、片段、无路径与非规范写法", () => {
    expect(checkPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toEqual({
      ok: false,
      reason: "scheme_not_https",
    });
    expect(checkPushEndpoint("https://a:b@fcm.googleapis.com/fcm/send/x")).toEqual({
      ok: false,
      reason: "userinfo_not_allowed",
    });
    expect(checkPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/x")).toEqual({
      ok: false,
      reason: "port_not_allowed",
    });
    expect(checkPushEndpoint("https://fcm.googleapis.com/fcm/send/x#frag")).toEqual({
      ok: false,
      reason: "fragment_not_allowed",
    });
    expect(checkPushEndpoint("https://fcm.googleapis.com/")).toEqual({
      ok: false,
      reason: "path_required",
    });
    for (const raw of [
      "https://FCM.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com/fcm/../send/x",
      "https://fcm.googleapis.com\\fcm/send/x",
      " https://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ])
      expect(checkPushEndpoint(raw)).toEqual({ ok: false, reason: "not_canonical" });
    expect(checkPushEndpoint("not a url")).toEqual({ ok: false, reason: "not_url" });
  });

  it("未登记主机、后缀伪装、多级 WNS 子域、IP 与内网地址全部拒绝", () => {
    for (const raw of [
      "https://example.com/push",
      "https://fcm.googleapis.com.evil.test/fcm/send/x",
      "https://evilfcm.googleapis.com/fcm/send/x",
      "https://notify.windows.com/w/?token=x",
      "https://a.b.notify.windows.com/w/?token=x",
      "https://-bad.notify.windows.com/w/?token=x",
      "https://127.0.0.1/push",
      "https://[::1]/push",
      "https://localhost/push",
      "https://169.254.169.254/latest/meta-data",
    ])
      expect(checkPushEndpoint(raw)).toEqual({ ok: false, reason: "host_not_allowed" });
  });

  it("p256dh 必须是 65 字节未压缩点，auth 必须是 16 字节", () => {
    const p256dh = `B${"A".repeat(86)}`;
    const auth = "A".repeat(22);
    expect(base64UrlByteLength(p256dh)).toBe(65);
    expect(base64UrlByteLength(auth)).toBe(16);
    expect(base64UrlByteLength(`${auth}==`)).toBe(16);
    expect(base64UrlByteLength("a+b/")).toBeNull();
    expect(checkPushKeys({ p256dh, auth })).toBeNull();
    expect(checkPushKeys({ p256dh: `C${"A".repeat(86)}`, auth })).toBe("p256dh_invalid");
    expect(checkPushKeys({ p256dh: p256dh.slice(1), auth })).toBe("p256dh_invalid");
    expect(checkPushKeys({ p256dh, auth: "A".repeat(23) })).toBe("auth_invalid");
  });
});

describe("A-P6-SEND 推送服务响应分类：404/410 停用，401/403 只查配置，临时错误退避", () => {
  it("逐码分类", () => {
    expect([201, 202, 200].map(classifyPushResponse)).toEqual(["accepted", "accepted", "accepted"]);
    expect([404, 410].map(classifyPushResponse)).toEqual(["gone", "gone"]);
    expect([401, 403].map(classifyPushResponse)).toEqual(["auth_rejected", "auth_rejected"]);
    expect([408, 429, 500, 503].map(classifyPushResponse)).toEqual([
      "retry_later",
      "retry_later",
      "retry_later",
      "retry_later",
    ]);
    expect([301, 302, 400, 413].map(classifyPushResponse)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });

  it("退避沿用 watchdog 周期按次数翻倍，Retry-After 更长时取其较大者", () => {
    const base = WATCHDOG_INTERVAL * 1000;
    expect(pushRetryDelayMs(1)).toBe(base);
    expect(pushRetryDelayMs(2)).toBe(base * 2);
    expect(pushRetryDelayMs(3)).toBe(base * 4);
    expect(pushRetryDelayMs(1, base * 3)).toBe(base * 3);
    expect(pushRetryDelayMs(1, 5_000)).toBe(base);
    expect(Number.isSafeInteger(pushRetryDelayMs(999))).toBe(true);
  });

  it("关键预留：普通外发上限扣除 PUSH_CRITICAL_RESERVED_DAY，关键通知可用到 PUSH_SEND_DAY", () => {
    expect(pushSendDayLimit(true)).toBe(PUSH_SEND_DAY);
    expect(pushSendDayLimit(false)).toBe(PUSH_SEND_DAY - PUSH_CRITICAL_RESERVED_DAY);
    for (const kind of ["cancelled_or_retracted", "important_change", "late_discovery"])
      expect(isCriticalPushKind(kind)).toBe(true);
    for (const kind of ["rule", "new_event", "activation", "test"])
      expect(isCriticalPushKind(kind)).toBe(false);
  });

  it("日计数键含 UTC 日；期限、租期、宽限与合并写入只取注册表", () => {
    expect(pushCounterKeys("2026-10-06")).toEqual({
      send: "push:send:2026-10-06",
      test: "push:test:2026-10-06",
      created: "push:new:2026-10-06",
    });
    expect(pushLeaseExpiresAt(now)).toBe(now + PUSH_LEASE * DAY);
    expect(pushActivationDeadline(now)).toBe(now + PUSH_ACTIVATION_TTL * 1000);
    expect(pushStaleCleanupBefore(now)).toBe(now - PUSH_STALE_GRACE * DAY);
    expect(pushReceiptWriteDue(null, now)).toBe(true);
    expect(pushReceiptWriteDue(now - PUSH_RECEIPT_WRITE_INTERVAL * DAY + 1, now)).toBe(false);
    expect(pushReceiptWriteDue(now - PUSH_RECEIPT_WRITE_INTERVAL * DAY, now)).toBe(true);
    expect(pushTestReadyAt(now)).toBe(now + PUSH_TEST_COOLDOWN * 1000);
    expect(pushTtlSeconds(now + 90_500, now)).toBe(90);
    expect(pushTtlSeconds(now - 1, now)).toBe(0);
  });

  it("单记录明文上限 = 4096 − 头部 86 − 标签 16 − 分隔符 1", () => {
    expect(PUSH_MAX_PLAINTEXT_BYTES).toBe(3993);
    expect(PUSH_SECRET_TEXT_LENGTH).toBe(Math.ceil(SECRET_BITS / 6));
  });
});

describe("A-P6-BIND 浏览器推导置灰（D3 §1.2）与写入拒绝同一原因", () => {
  it("开启前置按会话、恢复受限、订阅、能力顺序；恢复码可选（ADR-0026）", () => {
    expect(derivePushActions(view({ session_state: "pending" }), null, now).enable).toEqual({
      allowed: false,
      reason: "pending_activation",
    });
    expect(
      derivePushActions(view({ recovery_code_required: true }), null, now).enable,
    ).toMatchObject({ reason: "recovery_code_unconfirmed" });
    expect(
      derivePushActions(view({ subscription_state: "uninitialized" }), null, now).enable,
    ).toMatchObject({ reason: "subscription_uninitialized" });
    expect(derivePushActions(view({ service: "unknown" }), null, now).enable).toMatchObject({
      reason: "feature_closed",
    });
    expect(derivePushActions(view({ configured: false }), null, now).enable).toMatchObject({
      reason: "feature_closed",
    });
    expect(derivePushActions(view(), null, now).enable).toEqual({ allowed: true });
  });

  it("名额与日额度：本人上限、全站容量、未知容量、当日新绑定与外发预算", () => {
    const remaining = view().remaining;
    expect(
      derivePushActions(view({ remaining: { ...remaining, user: 0 } }), null, now).enable,
    ).toMatchObject({ reason: "capacity_full" });
    expect(
      derivePushActions(view({ remaining: { ...remaining, pending: 0 } }), null, now).enable,
    ).toMatchObject({ reason: "capacity_full" });
    expect(
      derivePushActions(view({ remaining: { ...remaining, total: "unknown" } }), null, now).enable,
    ).toMatchObject({ reason: "feature_closed" });
    expect(
      derivePushActions(view({ remaining: { ...remaining, new_today: 0 } }), null, now).enable,
    ).toMatchObject({ reason: "quota_paused" });
    expect(
      derivePushActions(view({ remaining: { ...remaining, send_today: 0 } }), null, now).enable,
    ).toMatchObject({ reason: "quota_paused" });
  });

  it("本浏览器已有有效绑定时不再开启；失效或激活过期的旧绑定可在原名额内替换", () => {
    const full = view({ remaining: { ...view().remaining, user: 0, total: 0 } });
    expect(derivePushActions(full, binding(), now).enable).toMatchObject({
      reason: "state_mismatch",
    });
    const gone = binding({ state: "gone", gone_at: now - 1 });
    expect(isPushBindingReplaceable(gone, now)).toBe(true);
    expect(derivePushActions(full, gone, now).enable).toEqual({ allowed: true });
    const expired = binding({
      state: "pending",
      activated_at: null,
      lease_expires_at: null,
      activation: { deadline: now, attempts: 1, last_sent_at: now - 1, last_outcome: "accepted" },
    });
    expect(derivePushActions(full, expired, now).enable).toEqual({ allowed: true });
  });

  it("激活重发：期限、次数上限与同绑定冷却（带可重试时间）", () => {
    const pending = (attempts: number, lastSent: number, deadline = now + 1) =>
      binding({
        state: "pending",
        activated_at: null,
        lease_expires_at: null,
        activation: { deadline, attempts, last_sent_at: lastSent, last_outcome: "accepted" },
      });
    expect(derivePushActions(view(), pending(1, now - 1, now), now).activate).toMatchObject({
      reason: "activation_expired",
    });
    expect(
      derivePushActions(view(), pending(PUSH_ACTIVATION_ATTEMPTS, 0), now).activate,
    ).toMatchObject({ reason: "attempts_exhausted" });
    expect(derivePushActions(view(), pending(1, now - 1), now).activate).toEqual({
      allowed: false,
      reason: "cooldown",
      retry_at: now - 1 + PUSH_TEST_COOLDOWN * 1000,
    });
    expect(
      derivePushActions(view(), pending(1, now - PUSH_TEST_COOLDOWN * 1000), now).activate,
    ).toEqual({ allowed: true });
    const paused = binding({ state: "paused", paused_reason: "user" });
    expect(derivePushActions(view(), paused, now).activate).toEqual({ allowed: true });
    expect(
      derivePushActions(view({ remaining: { ...view().remaining, pending: 0 } }), paused, now)
        .activate,
    ).toMatchObject({ reason: "capacity_full" });
    expect(derivePushActions(view(), binding(), now).activate).toMatchObject({
      reason: "state_mismatch",
    });
  });

  it("测试只对已激活绑定，受冷却、测试日量与外发预算约束", () => {
    expect(derivePushActions(view(), binding(), now).test).toEqual({ allowed: true });
    expect(
      derivePushActions(
        view(),
        binding({ last_test: { sent_at: now - 1, outcome: "accepted", received_at: null } }),
        now,
      ).test,
    ).toMatchObject({ reason: "cooldown" });
    expect(
      derivePushActions(view({ remaining: { ...view().remaining, test_today: 0 } }), binding(), now)
        .test,
    ).toMatchObject({ reason: "quota_paused" });
    expect(
      derivePushActions(view(), binding({ state: "paused", paused_reason: "user" }), now).test,
    ).toMatchObject({ reason: "state_mismatch" });
  });

  it("暂停与删除是终止路径：能力关闭、订阅未保存、名额满时照样可用", () => {
    const closed = view({
      service: "closed",
      subscription_state: "uninitialized",
      remaining: { ...view().remaining, send_today: 0, user: 0 },
    });
    const actions = derivePushActions(closed, binding(), now);
    expect(actions.pause).toEqual({ allowed: true });
    expect(actions.delete).toEqual({ allowed: true });
    expect(actions.renew).toMatchObject({ reason: "subscription_uninitialized" });
    expect(
      derivePushActions(closed, binding({ state: "gone", gone_at: now }), now).pause,
    ).toMatchObject({ reason: "state_mismatch" });
    expect(
      derivePushActions(view({ session_state: "pending" }), binding(), now).delete,
    ).toMatchObject({ reason: "pending_activation" });
  });

  it("写入拒绝映射到七类错误并携带同一 blocked_reason", () => {
    expect(pushRefusal("capacity_full").error.code).toBe("capacity_reached");
    expect(pushRefusal("quota_paused").error.code).toBe("quota_paused");
    expect(pushRefusal("feature_closed").error.code).toBe("temporarily_unavailable");
    expect(pushRefusal("recovery_code_unconfirmed")).toMatchObject({
      error: { code: "unauthorized", details: { reason: "recovery_code_unconfirmed" } },
      blocked_reason: "recovery_code_unconfirmed",
    });
    expect(pushRefusal("cooldown", now + 5_000, now)).toMatchObject({
      error: { code: "rate_limited", details: { retry_after_ms: 5_000 } },
    });
    expect(pushRefusal("state_mismatch").error.details).toEqual({
      code: "conflict",
      reason: "push_binding_changed",
    });
    expect(pushRefusal("activation_expired").error.code).toBe("validation");
    const elsewhere = pushOwnedElsewhereRefusal();
    expect(elsewhere.error.details).toEqual({
      code: "conflict",
      reason: "push_endpoint_owned_elsewhere",
    });
    expect(API_ERROR_STATUS[elsewhere.error.code]).toBe(409);
  });
});

describe("A-P6-BIND 视图与载荷 Schema", () => {
  it("视图缺字段或多字段即失败，不能把未知涂成成功", () => {
    expect(PushChannelViewSchema.safeParse(view()).success).toBe(true);
    const { configured: _omit, ...missing } = view();
    expect(PushChannelViewSchema.safeParse(missing).success).toBe(false);
    expect(PushChannelViewSchema.safeParse({ ...view(), endpoint: "x" }).success).toBe(false);
    expect(
      PushChannelViewSchema.safeParse({ ...view(), bindings: [{ ...binding(), endpoint: "x" }] })
        .success,
    ).toBe(false);
  });

  it("载荷只允许站内路径，三种 kind 各有自己的凭据字段", () => {
    const base = { v: 1, binding_id: id, title: "t", body: "b", url: "/events/x", tag: "t" };
    expect(
      PushPayloadSchema.safeParse({ ...base, kind: "activation", challenge: secret }).success,
    ).toBe(true);
    expect(
      PushPayloadSchema.safeParse({ ...base, kind: "notification", message_id: id }).success,
    ).toBe(true);
    for (const url of ["https://evil.test/", "//evil.test/x", "javascript:alert(1)", "/a b"])
      expect(
        PushPayloadSchema.safeParse({ ...base, url, kind: "test", message_id: id }).success,
      ).toBe(false);
    expect(
      PushPayloadSchema.safeParse({ ...base, kind: "activation", message_id: id }).success,
    ).toBe(false);
  });

  it("账号摘要一行：有已激活即 active，全空为 none，其余 inactive", () => {
    expect(pushSummaryState({ pending: 0, active: 0, paused: 0, gone: 0 })).toBe("none");
    expect(pushSummaryState({ pending: 1, active: 1, paused: 0, gone: 0 })).toBe("active");
    expect(pushSummaryState({ pending: 1, active: 0, paused: 0, gone: 0 })).toBe("inactive");
  });
});
