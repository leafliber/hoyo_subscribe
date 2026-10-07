import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { GUEST_HANDOFF_KEY } from "../../apps/web/src/features/auth/return-path";
import {
  syntheticPreview,
  syntheticView,
} from "../../apps/web/src/features/channels/calendar/testing/fixtures";
import {
  type AccountSummary,
  AUTH_INTENT_PUBLIC_BODY,
  AUTH_INTENT_PUBLIC_STATUS,
  buildApiErrorBody,
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  EMAIL_CONSENT_VERSION,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEAT_LEASE,
  MAIL_SEATS_MAX,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  OTP_DIGITS,
  RECENT_AUTH_TTL,
  SESSION_RENEW_INTERVAL,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
} from "../../packages/contracts/src/index";
import { showChannels, showContent } from "./subscription-tabs";

// F3-05 / E2: synthetic accounts, auth and API responses only; no real mail.
// Calendar steps use the single F3-04 controller; local-flow.mjs separately exercises real D1/APIs.
test.use({ trace: "off", screenshot: "off", video: "off" });

const stamp = Date.UTC(2026, 9, 2);
const baseline: SubscriptionConfig = {
  schema_version: SUBSCRIPTION_SCHEMA_VERSION,
  revision: 1,
  scope: { games: [...DEFAULT_SCOPE_GAMES], regions: [...SUPPORTED_SCOPE_REGIONS] },
  calendar: {
    event_types: [...DEFAULT_CALENDAR_EVENT_TYPES],
    node_types: [...DEFAULT_CALENDAR_NODE_TYPES],
    alarms_enabled: CALENDAR_ALARMS_DEFAULT,
  },
  notifications: { rule_ids: [...DEFAULT_RULE_IDS], ...CHANGE_DEFAULTS },
};
type Snapshot = {
  state: "uninitialized" | "initialized";
  revision: number;
  config: SubscriptionConfig | null;
};
type Call = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  csrf?: string;
};
type SaveBody = { expected_revision: number; config: Omit<SubscriptionConfig, "revision"> };
type Scenario = {
  session: "public" | "pending" | "active";
  cloud: Snapshot;
  facts: AccountSummary;
  calls: Call[];
  badFacts: boolean;
  calendar: ReturnType<typeof syntheticView>;
  write?: (route: Route, body: SaveBody, state: Scenario) => Promise<void>;
  renew?: (route: Route) => Promise<void>;
};
function account(): AccountSummary {
  return {
    user_id: "synthetic-flow-account",
    server_time: stamp,
    email: { masked: "f***@example.invalid", email_version: 1 },
    recovery_code_saved: false,
    recovery_code_generation: null,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: stamp + RECENT_AUTH_TTL * 1000,
      absolute_expires_at: stamp + RECENT_AUTH_TTL * 1000,
      recovery_code_required: false,
      recovery_login_at: null,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "disabled", routine_enabled: false },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: { email_change: null, recovery_code_rotate: null, account_delete: null },
  };
}
function emailFacts(state: Scenario) {
  return {
    server_time: stamp,
    channel_revision: 1,
    session_state: state.session,
    recovery_code_required: state.facts.session.recovery_code_required,
    recovery_code_saved: state.facts.recovery_code_saved,
    subscription_state: state.cloud.state,
    subscription: state.cloud,
    email: state.facts.email,
    consent: {
      seat: { version: null, enabled_at: null, last_event: null },
      routine: { version: null, enabled_at: null, last_event: null },
    },
    enabled: false,
    routine_enabled: false,
    deliverability: "deliverable",
    suppression_kind: null,
    remaining: { seat: MAIL_SEATS_MAX, routine: MAIL_ROUTINE_SEATS_MAX },
    lease: {
      expires_at: null,
      last_renewed_at: null,
      last_renewed_reason: null,
      background_processing: "unknown",
    },
    service: { state: "normal" },
    disclosure: {
      consent_version: EMAIL_CONSENT_VERSION,
      daily_limits: { seat: MAIL_USER_URGENT_DAY, routine: MAIL_USER_BASE_DAY },
      lease_days: MAIL_SEAT_LEASE,
      renewal: "账号活动自动续租，无须专门返回网页。",
      budget: "按 UTC 日预算执行。",
    },
  };
}
function commit(state: Scenario, body: SaveBody): Snapshot {
  state.cloud = {
    state: "initialized",
    revision: body.expected_revision + 1,
    config: { ...body.config, revision: body.expected_revision + 1 },
  };
  state.facts.subscription.state = "initialized";
  return state.cloud;
}
const matching = (state: Scenario, endpoint: string) =>
  state.calls.filter((call) => call.path === endpoint);
const renewals = (state: Scenario) => matching(state, "auth/renew");
const saves = (state: Scenario) =>
  matching(state, "me/subscription").filter((call) => call.method === "PATCH");
function expectNoChannelWrites(state: Scenario): void {
  expect(
    state.calls.filter(
      (call) =>
        call.method !== "GET" &&
        /^(me\/calendar|me\/email-channel|me\/push-bindings)/.test(call.path),
    ),
  ).toEqual([]);
}
async function setup(
  page: Page,
  options: { session?: Scenario["session"]; uninitialized?: boolean; restricted?: boolean } = {},
): Promise<Scenario> {
  const state: Scenario = {
    session: options.session ?? "active",
    cloud: options.uninitialized
      ? { state: "uninitialized", revision: 0, config: null }
      : { state: "initialized", revision: baseline.revision, config: structuredClone(baseline) },
    facts: account(),
    calls: [],
    badFacts: false,
    calendar: syntheticView(baseline),
  };
  state.facts.subscription.state = state.cloud.state;
  state.facts.session.recovery_code_required = options.restricted ?? false;
  if (options.restricted) state.facts.session.recovery_login_at = stamp;
  if (state.session !== "public")
    await page.context().addCookies([
      {
        name: "__Host-hoyo_csrf",
        value: "synthetic-flow-csrf",
        domain: "127.0.0.1",
        path: "/",
        secure: true,
      },
    ]);
  await page.route(/\/login(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        /data-sitekey(?:="[^"]*")?/,
        'data-sitekey="synthetic-sitekey"',
      ),
    });
  });
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `let options;window.turnstile={render:(el,value)=>{options=value;value.callback('synthetic-token');return 'synthetic-widget'},reset:()=>options.callback('synthetic-token')};`,
      }),
  );
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname.replace("/api/v2/", "");
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    state.calls.push({
      path: endpoint,
      method: req.method(),
      body,
      csrf: req.headers()["x-csrf-token"],
    });
    const reply = (json: unknown, status = 200, cookie?: string) =>
      route.fulfill({
        status,
        json,
        headers: {
          "cache-control": "no-store",
          ...(cookie
            ? { "set-cookie": `__Host-hoyo_csrf=${cookie}; Secure; SameSite=Lax; Path=/` }
            : {}),
        },
      });
    const unauthorized = () =>
      reply(buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" }), 401);
    if (endpoint === "status")
      return reply({
        registration_open: true,
        mail_sending_available: true,
        publication: null,
        cache: { generatedAt: stamp, freshUntil: stamp, stale: false },
        sources: [],
        reviewGaps: [],
        capabilities: {
          calendar: "unknown",
          email_seats: "unknown",
          routine_email: "unknown",
          push: "unknown",
        },
        calendarClients: [],
      });
    if (endpoint === "auth/preauth")
      return reply({ csrf_token: "synthetic-preauth" }, 200, "synthetic-preauth");
    if (endpoint === "auth/challenges")
      return reply(AUTH_INTENT_PUBLIC_BODY, AUTH_INTENT_PUBLIC_STATUS);
    if (endpoint === "auth/challenges/verify") {
      state.session = "pending";
      return reply({ verified: true, pending_session_id: "synthetic-pending" });
    }
    if (endpoint === "me/sessions") {
      if (state.session === "public") return unauthorized();
      return reply(
        {
          sessions: [],
          current_session_state: state.session,
          current_needs_reverification: false,
          renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * 1000,
          csrf_token: "synthetic-flow-csrf",
        },
        200,
        "synthetic-flow-csrf",
      );
    }
    if (endpoint === "auth/activate") {
      state.session = "active";
      return reply(
        { activated: true, csrf_token: "synthetic-flow-csrf" },
        200,
        "synthetic-flow-csrf",
      );
    }
    if (endpoint === "me") {
      if (state.session !== "active") return unauthorized();
      return reply(state.badFacts ? { user_id: state.facts.user_id } : state.facts);
    }
    if (endpoint === "me/subscription") {
      if (state.session !== "active") return unauthorized();
      if (req.method() === "GET") return reply(state.cloud);
      if (state.write) return state.write(route, body as SaveBody, state);
      return reply({ ...commit(state, body as SaveBody), saved: true });
    }
    if (endpoint === "me/email-channel") {
      if (state.session !== "active") return unauthorized();
      if (req.method() === "GET") return reply(emailFacts(state));
      return reply({}, 500);
    }
    if (endpoint === "me/calendar") {
      if (state.session !== "active") return unauthorized();
      state.calendar.configuration = {
        state: state.cloud.state,
        revision: state.cloud.revision,
        alarms_enabled: state.cloud.config?.calendar.alarms_enabled ?? null,
      };
      return reply(state.calendar);
    }
    if (endpoint === "me/calendar/preview") {
      if (!state.cloud.config) return reply(buildApiErrorBody("validation"), 400);
      return reply(syntheticPreview(state.cloud.config));
    }
    if (endpoint === "me/calendar/enable") {
      // ADR-0026：恢复码可选，启用日历不再要求账号已保存恢复码。
      expect(state.facts.session.recovery_code_required).toBe(false);
      expect(body).toEqual({
        confirmed: true,
        expected_generation: state.calendar.token_generation,
        expected_revision: state.cloud.revision,
        publication_generation: 31,
      });
      state.calendar.address_state = "enabled";
      state.calendar.token_generation++;
      state.calendar.url = "https://example.invalid/feeds/u/synthetic-flow.ics";
      return reply({
        changed: true,
        token_generation: state.calendar.token_generation,
        address_state: "enabled",
      });
    }
    if (endpoint === "auth/renew") {
      if (state.renew) return state.renew(route);
      return reply({ renewed: false, expires_at: state.facts.session.expires_at });
    }
    if (endpoint === "auth/recovery/code") {
      if (req.method() === "GET")
        return reply({
          has_current_code: state.facts.recovery_code_generation !== null,
          saved_confirmed: state.facts.recovery_code_saved,
        });
      if (body.action === "generate") {
        state.facts.recovery_code_generation = 1;
        return reply({
          recovery_id: "synthetic-flow-code",
          secret: "synthetic-flow-secret",
          saved_confirmed: false,
        });
      }
      state.facts.recovery_code_saved = true;
      state.facts.session.recovery_code_required = false;
      return reply({ saved_confirmed: true });
    }
    return reply({}, 404);
  });
  return state;
}
async function login(page: Page): Promise<void> {
  await expect(page.locator("#turnstile-status")).toContainText("已完成");
  await page.locator("#login-email").fill("flow@example.invalid");
  await page.locator("#login-request-otp").click();
  await expect(page.locator("#code-section")).toBeVisible();
  await page.locator("#login-code").fill("1".repeat(OTP_DIGITS));
  await page.locator("#verify").click();
  await expect(page.locator("#pending-section")).toBeVisible();
  await expect(page.locator("#activate")).toBeEnabled();
}
async function edit(page: Page): Promise<void> {
  // 变化通知开关始终可见，不再折叠在 details 里。
  await page.locator('input[name="new_event"]').check();
}
// #cloud-state 现在是保存阶段胶囊；云端版本号显示在 #draft-state。
async function expectCloudRevision(page: Page, revision: number): Promise<void> {
  await expect(page.locator("#draft-state")).toHaveText(`云端版本 ${revision}`);
}
async function openSaved(page: Page, state: Scenario): Promise<void> {
  await page.goto("/subscription");
  await expectCloudRevision(page, state.cloud.revision);
  await expect(page.locator("#save-subscription")).toBeEnabled();
}
async function evidence(page: Page, name: string): Promise<void> {
  if (process.env.HOYO_E2E_WRITE_EVIDENCE !== "1") return;
  const target = path.join("tests/e2e/evidence/f3-05", `${test.info().project.name}-${name}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: true });
}

for (const choice of ["keep", "cloud"] as const) {
  test(`U12 游客草稿经 OTP 和手动激活返回，展示差异后${choice === "keep" ? "继续编辑并保存" : "明确采用云端"}`, async ({
    page,
  }) => {
    const state = await setup(page, { session: "public" });
    await page.goto("/subscription");
    await edit(page);
    await expect(page.locator("#local-draft-status")).toContainText("已暂存在本机");
    await expect(page.locator("#subscription-login")).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fsubscription",
    );
    await page.locator("#subscription-login").click();
    await login(page);
    expect(matching(state, "auth/activate")).toHaveLength(0);
    expect(saves(state)).toHaveLength(0);
    await page.locator("#activate").click();
    await expect(page).toHaveURL(/\/subscription$/);
    await expect(page.locator("#save-comparison")).toBeVisible();
    await expect(page.locator("#save-differences")).toContainText("变化通知 · 不同");
    await expect(page.locator("#save-differences h3")).toHaveText([
      "游戏 · 相同",
      "提醒 · 相同",
      "日历显示 · 相同",
      "变化通知 · 不同",
    ]);
    await expect(page.locator("#save-differences")).toContainText("本机草稿：");
    await expect(page.locator("#save-subscription")).toBeDisabled();
    expect(saves(state)).toHaveLength(0);
    expect(renewals(state)).toHaveLength(0);
    await evidence(page, "guest-cloud-comparison");
    if (choice === "cloud") {
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#adopt-cloud").click();
      await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
      await expect(page.locator("#cloud-state")).toHaveText("已保存到云端");
      await expectCloudRevision(page, 1);
      expect(saves(state)).toHaveLength(0);
      expect(renewals(state)).toHaveLength(0);
    } else {
      await page.locator("#keep-draft").click();
      await expect(page.locator('input[name="new_event"]')).toBeChecked();
      await expect(page.locator("#save-comparison")).toBeHidden();
      await page.locator("#save-subscription").click();
      await expectCloudRevision(page, 2);
      await expect.poll(() => renewals(state).length).toBe(1);
      expect(saves(state)[0]?.body).toMatchObject({
        expected_revision: 1,
        config: { notifications: { new_event: true } },
      });
      // ADR-0026：恢复码可选，保存订阅后直接进入第 2 步「添加到日历」，不经过恢复页。
      await expect(page.locator("#save-recovery-link")).toBeHidden();
      await expect(page.locator("#cloud-flow-status")).toContainText("日历");
      await expect(page.locator('#setup-steps [data-step="calendar"]')).toHaveAttribute(
        "data-state",
        "current",
      );
      await page.locator("#setup-calendar-link").click();
      await expect(page.locator("#panel-channels")).toBeVisible();
      await expect(page.locator("#calendar-channel")).toBeInViewport();
      expect(state.cloud.config?.notifications.new_event).toBe(true);
      expect(renewals(state)).toHaveLength(1);
      const part = (name: string) => page.locator(`[data-calendar="${name}"]`);
      await part("refresh").click();
      await expect(part("begin")).toBeEnabled();
      expectNoChannelWrites(state);
      await part("begin").click();
      await expect(part("preview")).toContainText("完整预览");
      // 同意勾选框已移除：服务端预览完成后由显式「确认启用」按钮发起启用；此前不得发出启用请求。
      await expect(part("confirm")).toBeVisible();
      await expect(part("confirm")).toBeEnabled();
      expect(matching(state, "me/calendar/enable")).toHaveLength(0);
      expect(renewals(state)).toHaveLength(1);
      await evidence(page, "calendar-confirmation");
      await part("confirm").click();
      await expect(part("address")).toContainText("日历订阅地址已创建");
      await expect.poll(() => renewals(state).length).toBe(2);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => {} },
        }),
      );
      await part("copy").click();
      await expect(part("message")).toContainText("链接已复制");
      await expect(part("manual")).toBeHidden();
      await evidence(page, "calendar-copied");
      expect(matching(state, "me/calendar/enable")).toHaveLength(1);
      expect(renewals(state)).toHaveLength(2);
      expect(await page.evaluate(() => document.body.innerHTML.includes("/feeds/u/"))).toBe(false);
    }
    if (choice === "cloud") expectNoChannelWrites(state);
    expect(
      state.calls.filter(
        (call) => call.method !== "GET" && /^me\/(email-channel|push-bindings)/.test(call.path),
      ),
    ).toEqual([]);
  });
}

test("U15a 新账号只有注册表预选，首次显式保存后直接引导添加日历（恢复码可选），三通道不附带开启", async ({
  page,
}) => {
  const state = await setup(page, { uninitialized: true });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-flow-status")).toContainText("保存订阅");
  await expect(page.locator('#setup-steps [data-step="save"]')).toHaveAttribute(
    "data-state",
    "current",
  );
  await showChannels(page);
  await expect(page.locator("#calendar-first-save")).toBeVisible();
  await expect(page.locator("#calendar-first-save")).toContainText("保存一次订阅");
  // 浏览器通知（Push）区域已从新界面移除，原 #push-first-save 占位断言不再适用。
  await expect(page.locator('#mail-channel [data-email="seat-start"]')).toBeDisabled();
  await page.locator('[data-calendar="refresh"]').click();
  await expect(page.locator("#calendar-first-save")).toBeVisible();
  // ADR-0026：唯一的前置是先保存一次订阅，不再要求恢复码。
  await expect(page.locator('[data-calendar="reason"]')).toContainText("请先保存一次订阅设置");
  await expect(page.locator('[data-calendar="recovery"]')).toBeHidden();
  await expect(page.locator('[data-calendar="begin"]')).toBeDisabled();
  await showContent(page);
  await expect(page.locator("#cloud-state")).toHaveText("尚未保存到云端");
  await expect(page.locator("#draft-state")).not.toContainText("云端版本");
  for (const game of DEFAULT_SCOPE_GAMES)
    await expect(page.locator(`input[name="games"][value="${game}"]`)).toBeChecked();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  await evidence(page, "uninitialized");
  await page.locator("#save-subscription").click();
  await expectCloudRevision(page, 1);
  await expect.poll(() => renewals(state).length).toBe(1);
  await expect(page.locator("#save-recovery-link")).toBeHidden();
  await expect(page.locator("#setup-calendar-link")).toBeVisible();
  await showChannels(page);
  await page.locator('[data-calendar="refresh"]').click();
  await expect(page.locator('[data-calendar="begin"]')).toBeEnabled();
  expect(saves(state)[0]?.body.expected_revision).toBe(0);
  expectNoChannelWrites(state);
  await page.goto("/help");
  await page.goto("/subscription");
  await expectCloudRevision(page, 1);
  expect(saves(state)).toHaveLength(1);
  expect(renewals(state)).toHaveLength(1);
});

test("U15a 受限恢复会话在操作前禁用保存，复用恢复码保存入口", async ({ page }) => {
  const state = await setup(page, { restricted: true });
  await page.goto("/subscription");
  await expectCloudRevision(page, 1);
  await expect(page.locator("#save-subscription")).toBeDisabled();
  await expect(page.locator("#cloud-flow-status")).toContainText("恢复码");
  await expect(page.locator("#save-recovery-link")).toHaveAttribute("href", "/recover#save");
  await edit(page);
  await expect(page.locator("#save-subscription")).toBeDisabled();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("U12 无法将游客续接绑定到已确认账号时关闭续接，不自动采用草稿", async ({ page }) => {
  const state = await setup(page, { session: "public" });
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hoyo-subscription-guest-handoff" && value !== "pending")
        throw new Error("synthetic-storage-denied");
      return setItem.call(this, key, value);
    };
  });
  await page.goto("/subscription");
  await edit(page);
  await expect(page.locator("#local-draft-status")).toContainText("已暂存在本机");
  await page.locator("#subscription-login").click();
  await login(page);
  await page.locator("#activate").click();
  await expect(page).toHaveURL(/\/subscription$/);
  await expectCloudRevision(page, 1);
  await expect(page.locator("#local-draft-status")).toContainText("无法暂存本机草稿");
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("U12 没有显式登录续接时，旧游客草稿不会自动进入已登录账号", async ({ page }) => {
  const state = await setup(page, { session: "public" });
  await page.goto("/subscription");
  await edit(page);
  await expect(page.locator("#local-draft-status")).toContainText("已暂存在本机");
  state.session = "active";
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-flow-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
  await page.reload();
  await expectCloudRevision(page, 1);
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("U12 已有云配置只关注原神时，页面预选不替账号加入其他游戏", async ({ page }) => {
  const state = await setup(page);
  if (!state.cloud.config) throw new Error("missing_synthetic_config");
  state.cloud.config.scope.games = ["genshin"];
  await openSaved(page, state);
  for (const input of await page.locator('input[name="games"]').all()) {
    if ((await input.inputValue()) === "genshin") await expect(input).toBeChecked();
    else await expect(input).not.toBeChecked();
  }
  await expect(page.locator("#save-comparison")).toBeHidden();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
});

test("U12 已绑定账号 A 的未决游客草稿不能进入账号 B", async ({ page }) => {
  const state = await setup(page, { session: "public" });
  await page.goto("/subscription");
  await edit(page);
  await expect(page.locator("#local-draft-status")).toContainText("已暂存在本机");
  await page.locator("#subscription-login").click();
  await login(page);
  await page.locator("#activate").click();
  await expect(page).toHaveURL(/\/subscription$/);
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  state.facts.user_id = "synthetic-flow-account-b";
  await page.evaluate((userId) => {
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "confirmed", userId } }),
    );
  }, state.facts.user_id);
  await expectCloudRevision(page, 1);
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), GUEST_HANDOFF_KEY)).toBeNull();
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("U12 游客续接落盘挂起时身份改变，旧动作不写续接标识或离开页面", async ({ page }) => {
  const state = await setup(page, { session: "public" });
  await page.goto("/subscription");
  await edit(page);
  await expect(page.locator("#local-draft-status")).toContainText("已暂存在本机");
  await page.evaluate(() => {
    const scope = window as unknown as { releaseGuestWrite?: () => void };
    const open = indexedDB.open.bind(indexedDB);
    let holdNext = true;
    indexedDB.open = (name, version) => {
      const request = version === undefined ? open(name) : open(name, version);
      if (holdNext) {
        holdNext = false;
        request.addEventListener(
          "success",
          (event) => {
            event.stopImmediatePropagation();
            scope.releaseGuestWrite = () => request.onsuccess?.call(request, event);
          },
          { once: true },
        );
      }
      return request;
    };
  });
  await page.locator("#subscription-login").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { releaseGuestWrite?: () => void }).releaseGuestWrite,
      ),
    )
    .toBe("function");
  // Same visible Cookie: the identity generation, rather than a Cookie mismatch, must reject it.
  state.session = "active";
  state.facts.user_id = "synthetic-flow-account-b";
  await page.evaluate((userId) => {
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "confirmed", userId } }),
    );
    (window as unknown as { releaseGuestWrite: () => void }).releaseGuestWrite();
  }, state.facts.user_id);
  await expect(page.locator("#subscription-login")).toBeHidden();
  // A later transaction observes completion of the held write before the negative assertions.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("hoyo-local-drafts", 1);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("drafts");
          transaction.objectStore("drafts").get("guest");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(new Error("synthetic_storage_read_failed"));
        };
        request.onerror = () => reject(new Error("synthetic_storage_open_failed"));
      }),
  );
  await expect(page).toHaveURL(/\/subscription$/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), GUEST_HANDOFF_KEY)).toBeNull();
  expect(matching(state, "auth/preauth")).toHaveLength(0);
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
});

for (const reason of ["no_session", "session_expired"] as const) {
  test(`U15a 重新核对账号明确 ${reason} 清除私人状态且不续期`, async ({ page }) => {
    const state = await setup(page);
    await openSaved(page, state);
    await edit(page);
    await page.route("**/api/v2/me", (route) =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason }),
      }),
    );
    const response = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === "/api/v2/me" && reply.status() === 401,
    );
    await page.locator("#recheck-save").click();
    await response;
    await expect(page.locator("#draft-state")).not.toContainText("版本 1");
    await expect(page.locator("#cloud-state")).toHaveText("登录状态待确认");
    await expect(page.locator("#subscription-login")).toBeVisible();
    await expect(page.locator("#save-comparison")).toBeHidden();
    await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
    expect(saves(state)).toHaveLength(0);
    expect(renewals(state)).toHaveLength(0);
    expectNoChannelWrites(state);
  });
}

for (const reason of ["recent_auth_required", "csrf_mismatch"] as const) {
  test(`U15a 非退出 ${reason} 不误清已保存配置与本机草稿`, async ({ page }) => {
    const state = await setup(page);
    await openSaved(page, state);
    await edit(page);
    await page.route("**/api/v2/me", (route) =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason }),
      }),
    );
    const response = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === "/api/v2/me" && reply.status() === 401,
    );
    await page.locator("#recheck-save").click();
    await response;
    // ADR-0026：引导不再依赖恢复码事实；读不到摘要时只是不知道是否受限，已保存配置照常显示。
    await expect(page.locator("#cloud-flow-status")).toContainText("订阅已保存");
    await expectCloudRevision(page, 1);
    await expect(page.locator('input[name="new_event"]')).toBeChecked();
    await expect(page.locator("#subscription-login")).toBeHidden();
    expect(saves(state)).toHaveLength(0);
    expect(renewals(state)).toHaveLength(0);
    expectNoChannelWrites(state);
  });
}

for (const failure of ["network", "malformed", "recent_auth_required", "csrf_mismatch"] as const) {
  test(`U15a 已知恢复受限后 ${failure} 保持保存禁用，仅同身份有效摘要解除`, async ({ page }) => {
    const state = await setup(page, { restricted: true });
    await page.goto("/subscription");
    await expectCloudRevision(page, 1);
    await expect(page.locator("#cloud-flow-status")).toContainText("新的恢复码");
    await expect(page.locator("#save-subscription")).toBeDisabled();
    await edit(page);
    const fail = (route: Route) =>
      failure === "network"
        ? route.abort("failed")
        : failure === "malformed"
          ? route.fulfill({ json: { user_id: state.facts.user_id } })
          : route.fulfill({
              status: 401,
              json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: failure }),
            });
    // 页头账号入口也会只读 GET /me；所有被挂起的 /me 读取都按同一种失败应答，保证核对读取拿到它。
    const held: Route[] = [];
    let failing = false;
    await page.route("**/api/v2/me", (route) => (failing ? fail(route) : held.push(route)));
    await page.locator("#recheck-save").click();
    await expect(page.locator("#cloud-flow-status")).toHaveText("正在核对账号状态…");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    failing = true;
    for (const route of held.splice(0)) await fail(route);
    await expect(page.locator("#cloud-flow-status")).toContainText("新的恢复码");
    await expect(page.locator("#save-subscription")).toBeDisabled();
    await expect(page.locator("#save-recovery-link")).toBeVisible();
    await expectCloudRevision(page, 1);
    await expect(page.locator('input[name="new_event"]')).toBeChecked();
    await expect(page.locator("#subscription-login")).toBeHidden();
    expect(saves(state)).toHaveLength(0);
    expect(renewals(state)).toHaveLength(0);
    // A later authoritative response for this same account can clear the restriction.
    await page.unroute("**/api/v2/me");
    state.facts.session.recovery_code_required = false;
    state.facts.recovery_code_saved = true;
    await page.locator("#recheck-save").click();
    await expect(page.locator("#save-subscription")).toBeEnabled();
    await expect(page.locator("#save-recovery-link")).toBeHidden();
    await expect(page.locator('input[name="new_event"]')).toBeChecked();
    expect(saves(state)).toHaveLength(0);
    expect(renewals(state)).toHaveLength(0);
    expectNoChannelWrites(state);
  });
}

test("U15a 同 Cookie 下完整摘要从 A 变为 B，清理 A 的配置与草稿", async ({ page }) => {
  const state = await setup(page);
  await openSaved(page, state);
  await edit(page);
  state.facts.user_id = "synthetic-flow-account-b";
  const response = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === "/api/v2/me" && reply.status() === 200,
  );
  await page.locator("#recheck-save").click();
  await response;
  await expect(page.locator("#draft-state")).not.toContainText("版本 1");
  await expect(page.locator("#cloud-state")).toHaveText("登录状态待确认");
  await expect(page.locator("#subscription-login")).toBeVisible();
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await expect(page.locator("#channel-saved-summary")).not.toContainText("第 1 版");
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("§12.2 加载、编辑、重新读取、采用一致配置与返回前台不续期", async ({ page }) => {
  const state = await setup(page);
  await openSaved(page, state);
  await page.locator("#save-subscription").click();
  await expect(page.locator("#save-result")).toContainText("无需再次保存");
  await edit(page);
  await page.locator("#recheck-save").click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#cloud-state")).toHaveText("有未保存的修改");
  expect(saves(state)).toHaveLength(0);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("§12.2 保存成功只续期一次，续期网络失败不改写保存成功", async ({ page }) => {
  const state = await setup(page);
  state.renew = (route) => route.abort("failed");
  await openSaved(page, state);
  await edit(page);
  await page.locator("#save-subscription").click();
  await expectCloudRevision(page, 2);
  await expect(page.locator("#cloud-state")).toHaveText("已保存到云端");
  await expect.poll(() => renewals(state).length).toBe(1);
  expect(renewals(state)[0]).toMatchObject({
    method: "POST",
    body: {},
    csrf: "synthetic-flow-csrf",
  });
  await page.locator("#save-subscription").click();
  await expect(page.locator("#save-result")).toContainText("无需再次保存");
  expect(saves(state)).toHaveLength(1);
  expect(renewals(state)).toHaveLength(1);
});

for (const outcome of [
  "conflict",
  "rejected",
  "lost",
  "malformed",
  "same-revision",
  "unsaved",
  "wrong-config",
  "skipped-revision",
] as const) {
  test(`§12.2 ${outcome} 保存结果及后续核对不续期`, async ({ page }) => {
    const state = await setup(page);
    state.write = async (route, body) => {
      if (outcome === "conflict")
        return route.fulfill({
          status: 409,
          json: { ...buildApiErrorBody("conflict", { code: "conflict" }), current: state.cloud },
        });
      if (outcome === "rejected")
        return route.fulfill({
          status: 400,
          json: buildApiErrorBody("validation", {
            code: "validation",
            fields: [{ path: "config.scope.games", reason: "invalid" }],
          }),
        });
      if (outcome === "lost") {
        commit(state, body);
        return route.abort("failed");
      }
      if (outcome === "same-revision")
        return route.fulfill({ json: { ...state.cloud, saved: true } });
      if (outcome === "unsaved")
        return route.fulfill({ json: { ...commit(state, body), saved: false } });
      if (outcome === "wrong-config") {
        const snapshot = commit(state, body);
        return route.fulfill({
          json: {
            ...snapshot,
            saved: true,
            config: { ...baseline, revision: snapshot.revision },
          },
        });
      }
      if (outcome === "skipped-revision") {
        const snapshot = commit(state, body);
        return route.fulfill({
          json: {
            ...snapshot,
            saved: true,
            revision: snapshot.revision + 1,
            config: { ...snapshot.config, revision: snapshot.revision + 1 },
          },
        });
      }
      return route.fulfill({ json: { saved: true, state: "initialized" } });
    };
    await openSaved(page, state);
    await edit(page);
    await page.locator("#save-subscription").click();
    await expect.poll(() => saves(state).length).toBe(1);
    await expect(page.locator("#save-bar")).not.toHaveAttribute("data-phase", "saving");
    await expect(page.locator("#cloud-state")).not.toHaveText("正在保存…");
    expect(renewals(state)).toHaveLength(0);
    const reads = matching(state, "me/subscription").filter((call) => call.method === "GET").length;
    // 新界面只在冲突/待确认/未保存时提供「重新读取」；结果被当作已保存时改用返回前台的后台读取，
    // 两条路径都只发 GET 核对。
    if (["conflict", "rejected", "malformed"].includes(outcome))
      await page.locator("#recheck-save").click();
    else {
      await expect(page.locator("#recheck-save")).toBeHidden();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await expect
      .poll(() => matching(state, "me/subscription").filter((call) => call.method === "GET").length)
      .toBeGreaterThan(reads);
    await expect(page.locator("#cloud-state")).not.toHaveText("正在保存…");
    expect(renewals(state)).toHaveLength(0);
    expect(saves(state)).toHaveLength(1);
    expectNoChannelWrites(state);
  });
}

test("§12.2 保存等待期间身份失效，旧成功响应不恢复私人状态或续期", async ({ page }) => {
  const state = await setup(page);
  let held: Route | undefined;
  let submitted: SaveBody | undefined;
  state.write = async (route, body) => {
    held = route;
    submitted = body;
  };
  await openSaved(page, state);
  await edit(page);
  await page.locator("#save-subscription").click();
  await expect(page.locator("#cloud-state")).toHaveText("正在保存…");
  await expect.poll(() => held !== undefined).toBe(true);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
    ),
  );
  await expect(page.locator("#draft-state")).not.toContainText("版本 1");
  await expect(page.locator("#cloud-state")).toHaveText("登录状态待确认");
  if (!held || !submitted) throw new Error("missing_synthetic_save");
  await held.fulfill({ json: { ...commit(state, submitted), saved: true } });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#draft-state")).not.toContainText("版本 2");
  await expect(page.locator("#channel-saved-summary")).not.toContainText("第 2 版");
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

const returnCases = [
  ["/", "/"],
  ["/subscription", "/subscription"],
  ["/account", "/account"],
  ["/recover", "/recover"],
  // ADR-0026：普通会话的恢复码在账号设置里管理，恢复页的保存分区转去那里。
  ["/recover#save", "/account#account-security"],
  ["/status", "/status"],
  ["https://outside.example.invalid", "/subscription"],
  ["//outside.example.invalid", "/subscription"],
  ["/\\outside.example.invalid", "/subscription"],
  ["javascript:alert(1)", "/subscription"],
  ["/subscription?next=https://outside.example.invalid", "/subscription"],
  ["/recover#other", "/subscription"],
  ["/%73ubscription", "/subscription"],
  ["%2Faccount", "/subscription"],
  ["/account/../status", "/subscription"],
  ["/help", "/subscription"],
  [" /account", "/subscription"],
] as const;
for (const [requested, destination] of returnCases) {
  test(`U12 激活后返回白名单：${JSON.stringify(requested)} → ${destination}`, async ({ page }) => {
    const state = await setup(page, { session: "pending" });
    await page.goto(`/login?${new URLSearchParams({ returnTo: requested })}`);
    await expect(page.locator("#pending-section")).toBeVisible();
    expect(matching(state, "auth/activate")).toHaveLength(0);
    const origin = new URL(page.url()).origin;
    await page.locator("#activate").click();
    await expect(page).toHaveURL(`${origin}${destination}`);
    expect(matching(state, "auth/activate")).toHaveLength(1);
    expect(renewals(state)).toHaveLength(0);
    expect(saves(state)).toHaveLength(0);
    expectNoChannelWrites(state);
  });
}

test("U12 没有 returnTo 的旧登录入口仍保留完成页", async ({ page }) => {
  const state = await setup(page, { session: "pending" });
  await page.goto("/login");
  await expect(page.locator("#pending-section")).toBeVisible();
  await page.locator("#activate").click();
  await expect(page.locator("#login-done")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});

test("U12/U20 页面恢复重新挂载日历，三方私人视图先失效再确认且不续期", async ({ page }) => {
  const state = await setup(page);
  state.facts.recovery_code_saved = true;
  await openSaved(page, state);
  await showChannels(page);
  const calendar = (name: string) => page.locator(`[data-calendar="${name}"]`);
  await calendar("refresh").click();
  await calendar("begin").click();
  await expect(calendar("preview")).toContainText("完整预览");
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect(calendar("preview")).toHaveCount(0);
  await expect(page.locator("#calendar-preview-content")).toBeEmpty();
  await expect(page.locator("#mail-channel")).toContainText("正在确认账号");
  await expect(page.locator("#mail-channel [data-email]")).toHaveCount(0);
  // 版本号已移到 #draft-state：失效后不得残留，下面恢复后的版本必须来自重新读取。
  await expect(page.locator("#draft-state")).not.toContainText("版本 1");
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expectCloudRevision(page, 1);
  await calendar("refresh").click();
  await expect(calendar("begin")).toBeEnabled();
  await expect(page.locator('#mail-channel [data-email="seat-start"]')).toBeVisible();
  expect(renewals(state)).toHaveLength(0);
  expectNoChannelWrites(state);
});
