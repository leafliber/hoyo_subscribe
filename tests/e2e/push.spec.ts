// U23 · 本浏览器通知（F5-01；前端 §9.3、§14.1；主方案 §7.8；ADR-0025）。
// 浏览器的 Notification / Service Worker / PushManager 全部用合成替身；接口用合成事实。
// 不连接任何真实推送服务，不注册真实 Service Worker。
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  buildApiErrorBody,
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  PUSH_ACTIVATION_TTL,
  PUSH_TEST_COOLDOWN,
  PUSH_USER_MAX,
  type PushBindingView,
  type PushChannelView,
  parseSubscriptionConfig,
  pushLeaseExpiresAt,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
} from "../../packages/contracts/src";

const parsed = parseSubscriptionConfig("initialized", {
  schema_version: SUBSCRIPTION_SCHEMA_VERSION,
  revision: 1,
  scope: { games: [...DEFAULT_SCOPE_GAMES], regions: [...SUPPORTED_SCOPE_REGIONS] },
  calendar: {
    event_types: [...DEFAULT_CALENDAR_EVENT_TYPES],
    node_types: [...DEFAULT_CALENDAR_NODE_TYPES],
    alarms_enabled: CALENDAR_ALARMS_DEFAULT,
  },
  notifications: { rule_ids: [...DEFAULT_RULE_IDS], ...CHANGE_DEFAULTS },
});
if (!parsed.success) throw new Error("invalid_synthetic_subscription");
const config = parsed.data;
const NOW = Date.UTC(2026, 9, 6, 8);
const BINDING = "00000000-0000-4000-8000-0000000000b1";
const RECEIPT = "R".repeat(43);

function view(bindings: PushBindingView[] = []): PushChannelView {
  return {
    server_time: NOW,
    configured: true,
    application_server_key: `B${"A".repeat(86)}`,
    service: "open",
    session_state: "active",
    recovery_code_required: false,
    subscription_state: "initialized",
    remaining: {
      user: PUSH_USER_MAX - bindings.length,
      pending: 10,
      active: 10,
      total: 10,
      new_today: 10,
      test_today: 10,
      send_today: 10,
    },
    bindings,
  };
}
function binding(overrides: Partial<PushBindingView> = {}): PushBindingView {
  return {
    id: BINDING,
    state: "pending",
    service: "fcm",
    binding_version: 1,
    created_at: NOW,
    activated_at: null,
    activation: {
      deadline: NOW + PUSH_ACTIVATION_TTL * 1000,
      attempts: 0,
      last_sent_at: null,
      last_outcome: null,
    },
    lease_expires_at: null,
    last_processed_at: null,
    last_test: null,
    paused_reason: null,
    gone_at: null,
    ...overrides,
  };
}

/** 服务器发出第一条验证通知之后的事实：仍是验证中，平台已接受。 */
function activationSent(): PushChannelView {
  return view([
    binding({
      binding_version: 2,
      activation: {
        deadline: NOW + PUSH_ACTIVATION_TTL * 1000,
        attempts: 1,
        last_sent_at: NOW,
        last_outcome: "accepted",
      },
    }),
  ]);
}
function activeView(): PushChannelView {
  return view([
    binding({
      state: "active",
      binding_version: 3,
      activated_at: NOW,
      activation: null,
      lease_expires_at: pushLeaseExpiresAt(NOW),
      last_processed_at: NOW,
    }),
  ]);
}
async function deliverReceipt(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __push: { deliverReceipt(): void } }).__push.deliverReceipt(),
  );
}
async function nextFrame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 50)),
  );
}

/** 合成浏览器能力：权限、Service Worker 注册与推送订阅；记录调用以证明点击前没有副作用。 */
async function fakeBrowser(
  page: Page,
  options: { answer?: "granted" | "denied"; supported?: boolean } = {},
) {
  await page.addInitScript(
    ({ answer, supported }) => {
      const record = {
        permissionRequests: 0,
        registrations: 0,
        subscribes: 0,
        unsubscribes: 0,
        endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-e2e-1",
      };
      const listeners: ((event: { data: unknown }) => void)[] = [];
      let permission: NotificationPermission = "default";
      let subscribed = false;
      const subscription = () => ({
        endpoint: record.endpoint,
        toJSON: () => ({
          endpoint: record.endpoint,
          keys: { p256dh: `B${"Q".repeat(86)}`, auth: "A".repeat(22) },
        }),
        unsubscribe: async () => {
          record.unsubscribes++;
          subscribed = false;
          return true;
        },
      });
      const registration = {
        scope: "/",
        pushManager: {
          getSubscription: async () => (subscribed ? subscription() : null),
          subscribe: async () => {
            record.subscribes++;
            if (record.unsubscribes > 0)
              record.endpoint = `https://fcm.googleapis.com/fcm/send/synthetic-e2e-${record.unsubscribes + 1}`;
            subscribed = true;
            return subscription();
          },
        },
      };
      if (!supported) {
        // 合成"不支持"的浏览器：移除全局 PushManager 接口对象。
        Reflect.deleteProperty(window, "PushManager");
      } else Object.defineProperty(window, "PushManager", { value: () => {}, configurable: true });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          get permission() {
            return permission;
          },
          requestPermission: async () => {
            record.permissionRequests++;
            permission = answer;
            return permission;
          },
        },
      });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => {
            record.registrations++;
            return registration;
          },
          ready: Promise.resolve(registration),
          getRegistration: async () => (record.registrations > 0 ? registration : undefined),
          addEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
            listeners.push(listener),
        },
      });
      (window as unknown as { __push: unknown }).__push = {
        record,
        deliverReceipt: () => {
          for (const listener of listeners) listener({ data: { type: "hoyo-push-receipt" } });
        },
      };
    },
    { answer: options.answer ?? "granted", supported: options.supported ?? true },
  );
}
async function browserRecord(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __push: { record: Record<string, unknown> } }).__push.record,
  );
}
async function localBinding(page: Page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("hoyo-push", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("binding");
        request.onsuccess = () => {
          const get = request.result.transaction("binding").objectStore("binding").get("current");
          get.onsuccess = () => resolve(get.result ?? null);
        };
      }),
  );
}

interface Server {
  reads?: number;
  state: PushChannelView;
  capability: "open" | "closed";
  writes: { method: string; path: string; body: unknown; csrf: string | undefined }[];
  create?: (route: Route) => Promise<void>;
  /** 接管读取（例如扣住某一次响应）；不设时直接返回 state。 */
  read?: (route: Route) => Promise<void> | void;
  /** 接管发送验证通知的 PATCH；不设时返回 activationSent()。 */
  activate?: (route: Route) => Promise<void> | void;
}
async function openSubscription(page: Page, server: Server) {
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
  await page.route("**/api/v2/auth/renew", (route) => route.fulfill({ json: { renewed: false } }));
  await page.route("**/api/v2/me", (route) =>
    route.fulfill({ json: { user_id: "synthetic-account-a" } }),
  );
  await page.route("**/api/v2/me/subscription", (route) =>
    route.fulfill({ json: { state: "initialized", revision: config.revision, config } }),
  );
  await page.route("**/api/v2/status", (route) =>
    route.fulfill({
      json: {
        registration_open: false,
        mail_sending_available: true,
        capabilities: {
          calendar: "closed",
          email_seats: "closed",
          routine_email: "closed",
          push: server.capability,
        },
      },
    }),
  );
  await page.route("**/api/v2/me/push-bindings**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v2/me/push-bindings", "");
    if (request.method() === "GET") {
      server.reads = (server.reads ?? 0) + 1;
      if (server.read) return server.read(route);
      return route.fulfill({ json: server.state });
    }
    const body = request.postDataJSON();
    server.writes.push({
      method: request.method(),
      path,
      body,
      csrf: request.headers()["x-csrf-token"],
    });
    if (request.method() === "POST" && path === "") {
      if (server.create) return server.create(route);
      server.state = view([binding()]);
      return route.fulfill({
        status: 201,
        json: {
          result: "created",
          binding_id: BINDING,
          receipt_token: RECEIPT,
          state: server.state,
        },
      });
    }
    if (request.method() === "PATCH" && body.action === "activate") {
      if (server.activate) return server.activate(route);
      server.state = activationSent();
      return route.fulfill({
        json: { result: "completed", outcome: "accepted", state: server.state },
      });
    }
    return route.fulfill({ status: 400, json: buildApiErrorBody("validation") });
  });
  // ADR-0026：本浏览器通知在「我的订阅」的「接收方式」分区，直达 #channels。
  await page.goto("/subscription#channels");
}
const card = (page: Page) => page.locator("#push-channel");
const part = (page: Page, name: string) => page.locator(`[data-push="${name}"]`);

test("U23 能力未开放且没有绑定时不出现入口，也不申请权限", async ({ page }) => {
  await fakeBrowser(page);
  const server: Server = { state: view(), capability: "closed", writes: [] };
  await openSubscription(page, server);
  // 等卡片真的读完事实之后再判断：读到"能力关闭且没有绑定"才隐藏。
  await expect.poll(() => server.reads ?? 0).toBeGreaterThan(0);
  await expect(card(page)).toBeHidden();
  expect(await browserRecord(page)).toMatchObject({
    permissionRequests: 0,
    registrations: 0,
    subscribes: 0,
  });
  expect(server.writes).toEqual([]);
});

test("U23 点击前不申请权限、不登记、不发通知；平台接受后仍是验证中，合法回执后才显示验证通过", async ({
  page,
}) => {
  await fakeBrowser(page);
  const server: Server = { state: view(), capability: "open", writes: [] };
  await openSubscription(page, server);
  const enable = part(page, "enable");
  await expect(enable).toHaveText("在当前浏览器开启通知");
  await expect(part(page, "facts")).toContainText("尚未授权");
  expect(await browserRecord(page)).toMatchObject({
    permissionRequests: 0,
    registrations: 0,
    subscribes: 0,
  });
  expect(server.writes).toEqual([]);

  await enable.click();
  await expect(part(page, "message")).toContainText("正在验证本浏览器接收能力");
  await expect(part(page, "pill")).toHaveText("验证中");
  await expect(part(page, "facts")).toContainText("推送服务已接受（不代表已经显示）");
  await expect(card(page)).not.toContainText("本浏览器接收验证通过");
  expect(await browserRecord(page)).toMatchObject({ permissionRequests: 1, subscribes: 1 });
  // 先登记拿到凭证并存进本机，再请服务器发激活通知。
  expect(server.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    "POST ",
    `PATCH /${BINDING}`,
  ]);
  expect(server.writes[0]?.body).toEqual({
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-e2e-1",
    keys: { p256dh: `B${"Q".repeat(86)}`, auth: "A".repeat(22) },
  });
  expect(server.writes.every((write) => write.csrf === "synthetic-csrf")).toBe(true);
  expect(await localBinding(page)).toEqual({ binding_id: BINDING, receipt_token: RECEIPT });

  // Service Worker 报回执后页面重读；服务端已是 active 才显示验证通过。
  server.state = activeView();
  await deliverReceipt(page);
  await expect(part(page, "pill")).toHaveText("验证通过");
  await expect(part(page, "facts")).toContainText("本浏览器接收验证通过");
  await expect(card(page)).toContainText("不承诺以后每条都送达");
  await expect(part(page, "test")).toBeEnabled();
});

test("U23 激活超时显示未完成且可重新开启；重发受冷却约束并显示可重试时间", async ({ page }) => {
  await fakeBrowser(page);
  await page.addInitScript(() => {
    const request = indexedDB.open("hoyo-push", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("binding");
    request.onsuccess = () =>
      request.result
        .transaction("binding", "readwrite")
        .objectStore("binding")
        .put(
          { binding_id: "00000000-0000-4000-8000-0000000000b1", receipt_token: "R".repeat(43) },
          "current",
        );
  });
  const cooling = binding({
    activation: {
      deadline: NOW + PUSH_ACTIVATION_TTL * 1000,
      attempts: 1,
      last_sent_at: NOW,
      last_outcome: "accepted",
    },
  });
  const server: Server = { state: view([cooling]), capability: "open", writes: [] };
  await openSubscription(page, server);
  await expect(part(page, "resend")).toBeDisabled();
  await expect(part(page, "reasons")).toContainText("刚刚发过通知");
  await expect(part(page, "reasons")).toContainText("后可再试");
  expect(PUSH_TEST_COOLDOWN).toBeGreaterThan(0);
  await expect(part(page, "enable")).toHaveCount(0);

  server.state = view([
    binding({
      activation: {
        deadline: NOW - 1,
        attempts: 3,
        last_sent_at: NOW - 2,
        last_outcome: "accepted",
      },
    }),
  ]);
  await part(page, "refresh").click();
  await expect(part(page, "facts")).toContainText("验证未完成（已超过有效期）");
  await expect(card(page)).not.toContainText("本浏览器接收验证通过");
  await expect(part(page, "enable")).toBeVisible();
  expect(server.writes).toEqual([]);
});

test("U23 权限被拒：说明到浏览器设置调整，不循环弹窗、不登记", async ({ page }) => {
  await fakeBrowser(page, { answer: "denied" });
  const server: Server = { state: view(), capability: "open", writes: [] };
  await openSubscription(page, server);
  await part(page, "enable").click();
  await expect(part(page, "message")).toContainText("请在浏览器的网站设置里允许本站发送通知");
  await expect(part(page, "facts")).toContainText("已拒绝");
  await expect(part(page, "enable")).toHaveCount(0);
  await part(page, "refresh").click();
  await expect(part(page, "reasons")).toContainText("本页不会再次弹出请求");
  expect(await browserRecord(page)).toMatchObject({ permissionRequests: 1, subscribes: 0 });
  expect(server.writes).toEqual([]);
});

test("U23 绑定属于其他账号：解释冲突、不认领；用户明确选择后为当前账号重新订阅", async ({
  page,
}) => {
  await fakeBrowser(page);
  let attempts = 0;
  const server: Server = {
    state: view(),
    capability: "open",
    writes: [],
    create: async (route) => {
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 409,
          json: {
            ...buildApiErrorBody("conflict", {
              code: "conflict",
              reason: "push_endpoint_owned_elsewhere",
            }),
            blocked_reason: "state_mismatch",
          },
        });
      server.state = view([binding()]);
      return route.fulfill({
        status: 201,
        json: {
          result: "created",
          binding_id: BINDING,
          receipt_token: RECEIPT,
          state: server.state,
        },
      });
    },
  };
  await openSubscription(page, server);
  await part(page, "enable").click();
  await expect(part(page, "message")).toContainText("已登记在另一个账号下");
  await expect(part(page, "message")).toContainText("不会替你认领或删除");
  expect(await localBinding(page)).toBeNull();
  await part(page, "reset").click();
  await expect(part(page, "message")).toContainText("正在验证本浏览器接收能力");
  const record = await browserRecord(page);
  expect(record).toMatchObject({ unsubscribes: 1, subscribes: 2 });
  const posted = server.writes
    .filter((write) => write.method === "POST")
    .map((write) => write.body);
  expect(posted).toHaveLength(2);
  expect((posted[0] as { endpoint: string }).endpoint).not.toBe(
    (posted[1] as { endpoint: string }).endpoint,
  );
});

test("U23 不支持网页通知的浏览器如实说明，不显示开启按钮", async ({ page }) => {
  await fakeBrowser(page, { supported: false });
  const server: Server = { state: view(), capability: "open", writes: [] };
  await openSubscription(page, server);
  await expect(part(page, "reasons")).toContainText(/不支持网页通知|添加到主屏幕/);
  await expect(part(page, "enable")).toHaveCount(0);
  await expect(part(page, "facts")).toContainText("此浏览器不支持网页通知");
});

test("U23 身份切换后旧卡片迟到的读取作废，不画到新身份的卡片上", async ({ page }) => {
  await fakeBrowser(page);
  // 旧身份的事实与新身份可区分：今日新登记额度已用完，开启按钮会置灰并写出原因。
  const stale = view();
  stale.remaining = { ...stale.remaining, new_today: 0 };
  let held: Route | undefined;
  const server: Server = {
    state: view(),
    capability: "open",
    writes: [],
    read: (route) => {
      if (held) return route.fulfill({ json: server.state });
      held = route;
    },
  };
  await openSubscription(page, server);
  await expect.poll(() => held !== undefined).toBe(true);
  // 读取还在路上时身份切换并重新确认：新卡片挂载，读到新身份的事实。
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", {
        detail: { status: "confirmed", userId: "synthetic-account-b" },
      }),
    ),
  );
  await expect(part(page, "enable")).toBeEnabled();
  if (!held) throw new Error("missing_held_read");
  await held.fulfill({ json: stale });
  await nextFrame(page);
  await expect(part(page, "enable")).toBeEnabled();
  await expect(part(page, "reasons")).toHaveCount(0);
  expect(server.writes).toEqual([]);
});

test("U23 写入进行中到达的回执等写完再读，旧的写结果不盖掉验证通过", async ({ page }) => {
  await fakeBrowser(page);
  let held: Route | undefined;
  const server: Server = {
    state: view(),
    capability: "open",
    writes: [],
    activate: (route) => {
      held = route;
    },
  };
  await openSubscription(page, server);
  await part(page, "enable").click();
  await expect.poll(() => held !== undefined).toBe(true);
  // 验证通知比发送请求的响应先到：服务端已激活，回执在写入完成前到达页面。
  server.state = activeView();
  await deliverReceipt(page);
  if (!held) throw new Error("missing_held_activation");
  await held.fulfill({
    json: { result: "completed", outcome: "accepted", state: activationSent() },
  });
  await expect(part(page, "message")).toContainText("正在验证本浏览器接收能力");
  await expect(part(page, "pill")).toHaveText("验证通过");
  await expect(part(page, "facts")).toContainText("本浏览器接收验证通过");
});
