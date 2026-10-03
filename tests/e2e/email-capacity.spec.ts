import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { EmailUpdate, EmailView } from "../../apps/web/src/features/channels/email/api";
import {
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  EMAIL_CONSENT_VERSION,
  emailChannelRefusal,
  emailSeatLeaseExpiresAt,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEAT_LEASE,
  MAIL_SEATS_MAX,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  parseSubscriptionConfig,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
} from "../../packages/contracts/src";

// All account data is synthetic and masked; no live mail or account is used.
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
const base = parsed.data;
type WireView = EmailView & {
  subscription: EmailView["subscription"] & { state: "initialized" | "uninitialized" };
};
function facts(): WireView {
  return {
    server_time: Date.UTC(2026, 9, 1),
    channel_revision: 7,
    session_state: "active",
    recovery_code_required: false,
    recovery_code_saved: true,
    subscription_state: "initialized",
    subscription: { state: "initialized", revision: base.revision, config: structuredClone(base) },
    email: { masked: "s***@example.invalid", email_version: 4 },
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
    service: { state: "sending_paused" },
    disclosure: {
      consent_version: EMAIL_CONSENT_VERSION,
      daily_limits: { seat: MAIL_USER_URGENT_DAY, routine: MAIL_USER_BASE_DAY },
      lease_days: MAIL_SEAT_LEASE,
      renewal: "账号活动自动续租，无须专门返回网页。",
      budget: "UTC 日预算；基础池不足时暂停常规提醒，紧急池降级时只保留取消或撤回。",
    },
  };
}
/** Synthetic API result with the same visible audit/lease fields as P4-05. */
function applyUpdate(state: WireView, body: EmailUpdate) {
  state.enabled = body.enabled ?? state.enabled;
  state.routine_enabled = state.enabled && (body.routine_enabled ?? state.routine_enabled);
  state.channel_revision++;
  for (const layer of ["seat", "routine"] as const) {
    const requested = layer === "seat" ? body.enabled : body.routine_enabled;
    if (requested === undefined) continue;
    if (requested) {
      state.consent[layer] = {
        version: state.disclosure.consent_version,
        enabled_at: state.server_time,
        last_event: { action: "enable", created_at: state.server_time },
      };
    } else state.consent[layer].last_event = { action: "disable", created_at: state.server_time };
  }
  if (body.enabled === true) {
    state.lease.expires_at = emailSeatLeaseExpiresAt(state.server_time);
    state.lease.last_renewed_at = state.server_time;
    state.lease.last_renewed_reason = "explicit_consent";
    state.remaining.seat = MAIL_SEATS_MAX - 1;
  }
}
async function openSubscription(
  page: Page,
  options: {
    state?: WireView;
    write?: (route: Route, body: EmailUpdate, state: WireView) => Promise<void>;
    waitForReady?: boolean;
    read?: (route: Route) => Promise<void>;
  } = {},
) {
  const state = options.state ?? facts();
  const writes: EmailUpdate[] = [];
  const saves: unknown[] = [];
  const unexpected: string[] = [];
  let renewals = 0;
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
  await page.route("**/api/**", async (route) => {
    unexpected.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  // F2-02：仅允许同页公开预览读取，其余 API 仍受原断言保护。
  await page.route(
    (url) => url.pathname === "/api/v2/calendar/nodes",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      expect(request.method()).toBe("GET");
      expect(url.origin).toBe(new URL(page.url()).origin);
      expect([...url.searchParams.keys()].every((key) => key === "cursor")).toBe(true);
      expect(request.headers().cookie).toBeUndefined();
      expect(request.headers()["x-csrf-token"]).toBeUndefined();
      await route.fulfill({ status: 503, json: {} });
    },
  );
  // Redesign: the mounted calendar panel reads the public capability switch (no credentials);
  // every other API stays guarded by the catch-all above.
  await page.route(
    (url) => url.pathname === "/api/v2/status",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      expect(request.method()).toBe("GET");
      expect(url.origin).toBe(new URL(page.url()).origin);
      expect(url.search).toBe("");
      expect(request.headers().cookie).toBeUndefined();
      expect(request.headers()["x-csrf-token"]).toBeUndefined();
      await route.fulfill({ status: 503, json: {} });
    },
  );
  await page.route("**/api/v2/auth/renew", async (route) => {
    expect(route.request().method()).toBe("POST");
    renewals++;
    await route.fulfill({ json: { renewed: false, expires_at: state.server_time } });
  });
  await page.route("**/api/v2/me", async (route) => {
    await route.fulfill({ json: { user_id: "synthetic-account-a" } });
  });
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() !== "GET") saves.push(route.request().postDataJSON());
    await route.fulfill({ json: state.subscription });
  });
  await page.route("**/api/v2/me/email-channel", async (route) => {
    if (route.request().method() === "GET") {
      if (options.read) return options.read(route);
      return route.fulfill({ json: state });
    }
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-csrf");
    const body = route.request().postDataJSON() as EmailUpdate;
    writes.push(body);
    if (options.write) return options.write(route, body, state);
    applyUpdate(state, body);
    await route.fulfill({ json: { result: "completed", state } });
  });
  await page.goto("/subscription");
  if (options.waitForReady !== false) await ready(page);
  return { state, writes, saves, unexpected, renewals: () => renewals };
}
/**
 * The panel painted a successful read: facts only render after the GET resolves and the panel is
 * idle again. This does not depend on whether a (quiet) refresh announces itself in the message.
 */
async function ready(page: Page) {
  await expect(part(page, "facts")).toContainText("当前已验证邮箱（脱敏）");
  await expect(part(page, "refresh")).toBeEnabled();
}
async function screenshot(page: Page, name: string, fullPage = false) {
  const target =
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? path.join("tests/e2e/evidence/f4-02", `${test.info().project.name}-${name}.png`)
      : test.info().outputPath(`${name}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  if (fullPage) await page.screenshot({ path: target, fullPage: true });
  else await page.locator("#mail-channel").screenshot({ path: target });
}
const part = (page: Page, name: string) => page.locator(`[data-email="${name}"]`);
async function consent(page: Page, routine = false) {
  await part(page, "seat-start").click();
  await part(page, "seat-consent").check();
  if (routine) await part(page, "routine-consent").check();
  await part(page, "confirm").click();
}

test("U22a 席位已满：预算解释、日历替代、主动通知差别与无候补；不自动开通", async ({ page }) => {
  const state = facts();
  state.remaining.seat = 0;
  const run = await openSubscription(page, { state });
  const notice = part(page, "capacity");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("邮件提醒席位已满");
  await expect(notice).toContainText("内测期的预算限制，不是账号有问题");
  await expect(notice).toContainText("个人日历 + 日历提醒");
  await expect(notice).toContainText("不占邮件名额");
  await expect(notice).toContainText("取消/改期的主动邮件通知");
  await expect(notice).toContainText("暂不提供候补");
  await expect(notice).toContainText("不承诺具体开放时间");
  await expect(notice.getByRole("link", { name: "去启用日历提醒" })).toHaveAttribute(
    "href",
    "#calendar-channel",
  );
  // Copy rewritten: the calendar still needs the user's own confirmation and is never auto-enabled.
  await expect(notice).toContainText("需要你在下方确认启用");
  await expect(notice).toContainText("不会因为邮件名额不足而自动开启");
  await expect(part(page, "seat-start")).toBeDisabled();
  const beforeFacts = await notice.evaluate((node) => {
    const facts = document.querySelector('[data-email="facts"]');
    return (
      facts !== null &&
      Boolean(node.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(beforeFacts).toBe(true);
  expect(run.writes).toEqual([]);
  expect(run.saves).toEqual([]);
  expect(run.unexpected).toEqual([]);
  expect(run.renewals()).toBe(0);
  await screenshot(page, "seat-full");
});

function enableSeat(state: WireView) {
  applyUpdate(state, {
    expected_revision: state.channel_revision,
    email_version: state.email.email_version,
    subscription_revision: state.subscription.revision,
    enabled: true,
    seat_consent_version: EMAIL_CONSENT_VERSION,
  });
}

test("U22a 仅常规子名额满：保留席位与取消更正资格，发送暂停仍独立显示", async ({ page }) => {
  const state = facts();
  enableSeat(state);
  state.remaining = { seat: 0, routine: 0 };
  const run = await openSubscription(page, { state });
  await expect(part(page, "capacity")).toContainText("常规提醒子名额已满");
  await expect(part(page, "capacity")).toContainText("已开启的邮件席位保留");
  await expect(part(page, "capacity")).not.toContainText("你将无法收到");
  await expect(part(page, "seat-status")).toHaveText("已开启");
  await expect(part(page, "routine-start")).toBeDisabled();
  await expect(part(page, "facts")).toContainText("发送暂停");
  expect(run.writes).toEqual([]);
  await screenshot(page, "routine-full");
});

test("U22a partial 保留实际取得的席位和续期，不重发，不撤销，不自动切换", async ({ page }) => {
  const run = await openSubscription(page, {
    write: async (route, body, state) => {
      applyUpdate(state, { ...body, routine_enabled: undefined });
      state.remaining.routine = 0;
      await route.fulfill({
        json: {
          result: "partial",
          state,
          routine_error: { code: "capacity_reached", capability: "email_routine" },
        },
      });
    },
  });
  await consent(page, true);
  await expect(part(page, "message")).toContainText("部分完成");
  await expect(part(page, "capacity")).toContainText("已开启的邮件席位保留");
  await expect(part(page, "seat-status")).toHaveText("已开启");
  await expect(part(page, "routine-status")).toHaveText("未开启");
  await expect.poll(run.renewals).toBe(1);
  expect(run.writes).toHaveLength(1);
  expect(run.unexpected).toEqual([]);
  expect(run.saves).toEqual([]);
  expect(run.writes[0]).toMatchObject({
    enabled: true,
    routine_enabled: true,
    seat_consent_version: EMAIL_CONSENT_VERSION,
    routine_consent_version: EMAIL_CONSENT_VERSION,
  });
  await screenshot(page, "partial");
});

for (const layer of ["seat", "routine"] as const) {
  test(`U22a ${layer} 写入竞争满额：重新读取事实并呈现对应容量，不自动重试或续期`, async ({
    page,
  }) => {
    const state = facts();
    if (layer === "routine") enableSeat(state);
    const run = await openSubscription(page, {
      state,
      write: async (route, _body, current) => {
        current.remaining[layer] = 0;
        await route.fulfill({ status: 409, json: emailChannelRefusal("capacity_full", layer) });
      },
    });
    await part(page, `${layer}-start`).click();
    await part(page, `${layer}-consent`).check();
    await part(page, "confirm").click();
    await expect(part(page, "message")).toContainText("已重新读取当前状态");
    await expect(part(page, "capacity")).toContainText(
      layer === "seat" ? "邮件提醒席位已满" : "已开启的邮件席位保留",
    );
    expect(run.writes).toHaveLength(1);
    expect(run.renewals()).toBe(0);
  });
}

test("U22a 余量未知不冒充满额；重新读到余量后移除旧容量说明，不自动同意", async ({ page }) => {
  const state = facts();
  state.remaining.seat = 0;
  const run = await openSubscription(page, { state });
  await expect(part(page, "capacity")).toBeVisible();
  run.state.remaining.seat = "unknown";
  await part(page, "refresh").click();
  await expect(part(page, "seat-reason")).toContainText("余量未知");
  await expect(part(page, "capacity")).toBeHidden();
  run.state.remaining.seat = MAIL_SEATS_MAX;
  await part(page, "refresh").click();
  await expect(part(page, "seat-start")).toBeEnabled();
  await expect(part(page, "capacity")).toBeHidden();
  await part(page, "seat-start").click();
  await expect(part(page, "seat-consent")).not.toBeChecked();
  await expect(part(page, "routine-consent")).not.toBeChecked();
  expect(run.writes).toEqual([]);
  expect(run.renewals()).toBe(0);
});

test("U22a 常规满额不阻止首次单独同意席位，不把预选当开启", async ({ page }) => {
  const state = facts();
  state.remaining.routine = 0;
  const run = await openSubscription(page, { state });
  await part(page, "seat-start").click();
  await part(page, "seat-consent").check();
  await expect(part(page, "routine-consent")).toBeDisabled();
  await expect(part(page, "capacity")).toContainText("席位尚未开启");
  await part(page, "confirm").click();
  await expect(part(page, "capacity")).toContainText("已开启的邮件席位保留");
  expect(run.writes).toHaveLength(1);
  expect(run.writes[0]?.routine_enabled).toBeUndefined();
});

for (const mode of ["suppressed", "budget", "failed-read"] as const) {
  test(`U22a ${mode} 不误报邮件席位满`, async ({ page }) => {
    const state = facts();
    if (mode === "suppressed") state.deliverability = "suppressed";
    if (mode === "budget") state.service.state = "budget_limited";
    await openSubscription(page, {
      state,
      waitForReady: mode !== "failed-read",
      ...(mode === "failed-read"
        ? {
            read: async (route: Route) => {
              await route.abort();
            },
          }
        : {}),
    });
    if (mode === "failed-read")
      await expect(part(page, "message")).toContainText("无法读取邮件状态");
    await expect(part(page, "capacity")).toBeHidden();
  });
}

test("U22a 邮件满额链接进入同一个真实日历确认控制器，不自动开通", async ({ page }) => {
  const { syntheticAccount, syntheticPreview, syntheticView } = await import(
    "../../apps/web/src/features/channels/calendar/testing/fixtures"
  );
  const state = facts();
  state.remaining.seat = 0;
  const run = await openSubscription(page, { state });
  const view = syntheticView(base);
  let previews = 0,
    enables = 0;
  await page.route("**/api/v2/me", (route) => route.fulfill({ json: syntheticAccount() }));
  await page.route("**/api/v2/me/calendar", (route) => route.fulfill({ json: view }));
  await page.route("**/api/v2/me/calendar/preview", (route) => {
    previews++;
    return route.fulfill({ json: syntheticPreview(base) });
  });
  await page.route("**/api/v2/me/calendar/enable", (route) => {
    enables++;
    expect(route.request().postDataJSON()).toEqual({
      confirmed: true,
      expected_generation: view.token_generation,
      expected_revision: base.revision,
      publication_generation: 31,
    });
    view.address_state = "enabled";
    view.token_generation++;
    return route.fulfill({
      json: {
        changed: true,
        address_state: view.address_state,
        token_generation: view.token_generation,
      },
    });
  });
  await part(page, "capacity").getByRole("link", { name: "去启用日历提醒" }).click();
  await expect(page).toHaveURL(/#calendar-channel$/);
  expect(previews).toBe(0);
  expect(enables).toBe(0);
  const calendar = (name: string) => page.locator(`[data-calendar="${name}"]`);
  await calendar("refresh").click();
  await expect(calendar("begin")).toBeEnabled();
  await calendar("begin").click();
  await expect(calendar("preview")).toContainText("完整预览");
  expect(previews).toBe(1);
  expect(enables).toBe(0);
  // Redesign: the consent checkbox was removed; the explicit "确认启用" button shown after the
  // server preview is the confirmation step.
  await expect(calendar("confirm")).toBeVisible();
  await expect(calendar("confirm")).toBeEnabled();
  expect(enables).toBe(0);
  await calendar("confirm").click();
  await expect(calendar("address")).toContainText("日历订阅地址已创建");
  expect(enables).toBe(1);
  expect(run.writes).toEqual([]);
  expect(run.saves).toEqual([]);
  expect(run.unexpected).toEqual([]);
});
