import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { EmailUpdate, EmailView } from "../../apps/web/src/features/channels/email/api";
import {
  buildApiErrorBody,
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  EMAIL_CONSENT_VERSION,
  type EmailChannelBlockReason,
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
    dirty?: boolean;
    write?: (route: Route, body: EmailUpdate, state: WireView) => Promise<void>;
    saveConflict?: boolean;
    waitForReady?: boolean;
    beforeAccount?: Promise<void>;
    beforeSubscription?: Promise<void>;
    read?: (route: Route, state: WireView, count: number) => Promise<void>;
    renew?: (route: Route) => Promise<void>;
  } = {},
) {
  const state = options.state ?? facts();
  const writes: EmailUpdate[] = [];
  const saves: unknown[] = [];
  let reads = 0;
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
  await page.route("**/api/v2/auth/renew", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-csrf");
    expect(route.request().postDataJSON()).toEqual({});
    renewals++;
    if (options.renew) return options.renew(route);
    await route.fulfill({ json: { renewed: false, expires_at: state.server_time } });
  });
  await page.route("**/api/v2/me", async (route) => {
    await options.beforeAccount;
    await route.fulfill({ json: { user_id: "synthetic-account-a" } });
  });
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      const subscription = structuredClone(state.subscription);
      await options.beforeSubscription;
      return route.fulfill({ json: subscription });
    }
    const body = route.request().postDataJSON();
    saves.push(body);
    if (options.saveConflict)
      return route.fulfill({
        status: 409,
        json: {
          ...buildApiErrorBody("conflict", { code: "conflict" }),
          current: state.subscription,
        },
      });
    state.subscription = {
      state: "initialized",
      revision: state.subscription.revision + 1,
      config: { ...body.config, revision: state.subscription.revision + 1 },
    };
    await route.fulfill({ json: state.subscription });
  });
  await page.route("**/api/v2/me/email-channel", async (route) => {
    if (route.request().method() === "GET") {
      reads++;
      if (options.read) return options.read(route, structuredClone(state), reads);
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
  if (options.waitForReady !== false)
    await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  if (options.dirty) await editRules(page);
  return { state, writes, saves, reads: () => reads, renewals: () => renewals };
}
async function editRules(page: Page) {
  for (const input of await page.locator('input[name="rule_ids"]').all()) {
    if (await input.isChecked()) await input.uncheck();
  }
}
async function screenshot(page: Page, name: string, fullPage = false) {
  const target =
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? path.join("tests/e2e/evidence/f4-01", `${test.info().project.name}-${name}.png`)
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

test("U22b 席位和常规层默认关闭；只同意席位，版本来自 GET，发送暂停独立显示", async ({ page }) => {
  const run = await openSubscription(page);
  await expect(part(page, "facts")).toContainText("发送暂停");
  await expect(part(page, "routine-start")).toBeDisabled();
  await part(page, "seat-start").click();
  await expect(part(page, "seat-consent")).not.toBeChecked();
  await expect(part(page, "routine-consent")).not.toBeChecked();
  await expect(part(page, "confirm")).toBeDisabled();
  await expect(part(page, "disclosure")).toContainText(`席位层 ${MAIL_USER_URGENT_DAY} 次`);
  await expect(part(page, "disclosure")).toContainText(`常规层 ${MAIL_USER_BASE_DAY} 次`);
  await expect(part(page, "disclosure")).toContainText(`名额租期 ${MAIL_SEAT_LEASE} 天`);
  await expect(part(page, "disclosure")).toContainText("非保证每条必达");
  await part(page, "seat-consent").check();
  await part(page, "confirm").click();
  await expect(part(page, "message")).toContainText("常规提醒邮件：已关闭");
  expect(run.writes).toEqual([
    {
      expected_revision: 7,
      email_version: 4,
      subscription_revision: base.revision,
      enabled: true,
      seat_consent_version: EMAIL_CONSENT_VERSION,
    },
  ]);
  await expect(part(page, "facts")).toContainText("发送暂停");
  await screenshot(page, "seat-only");
});

test("U22b 两层分别同意；子名额竞争导致 partial，逐项保留真实结果", async ({ page }) => {
  const run = await openSubscription(page, {
    write: async (route, _body, state) => {
      applyUpdate(state, { ..._body, routine_enabled: undefined });
      state.routine_enabled = false;
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
  await expect(part(page, "message")).toContainText(
    "部分完成。邮件席位：已开启；常规提醒邮件：已关闭",
  );
  expect(run.writes[0]?.routine_consent_version).toBe(EMAIL_CONSENT_VERSION);
  await expect(part(page, "routine-start")).toBeDisabled();
  await expect(part(page, "routine-reason")).toContainText("名额已满");
  await screenshot(page, "partial");
});

for (const kind of ["conflict", "validation"] as const)
  test(`U22 ${kind} 后重读邮箱/订阅/同意版本并重新确认，不自动重试`, async ({ page }) => {
    const run = await openSubscription(page, {
      write: async (route, _body, state) => {
        state.channel_revision++;
        state.email.email_version++;
        state.email.masked = "n***@example.invalid";
        state.subscription.revision++;
        if (state.subscription.config) state.subscription.config.revision++;
        state.disclosure.consent_version++;
        await route.fulfill({
          status: kind === "conflict" ? 409 : 400,
          json: buildApiErrorBody(
            kind,
            kind === "conflict"
              ? { code: kind }
              : {
                  code: kind,
                  fields: [{ path: "seat_consent_version", reason: "explicit_consent_required" }],
                },
          ),
        });
      },
    });
    await consent(page);
    await expect(part(page, "message")).toContainText("请重新开启确认流程");
    expect(run.writes).toHaveLength(1);
    expect(run.reads()).toBe(3);
    await part(page, "seat-start").click();
    await expect(part(page, "seat-consent")).not.toBeChecked();
    await expect(part(page, "disclosure")).toContainText("n***@example.invalid");
    await part(page, "seat-consent").check();
    await part(page, "confirm").click();
    await expect.poll(() => run.writes.length).toBe(2);
    expect(run.writes[1]).toMatchObject({
      expected_revision: 8,
      email_version: 5,
      subscription_revision: 2,
      seat_consent_version: EMAIL_CONSENT_VERSION + 1,
    });
  });

test("U22 按 contracts 受阻原因置灰，写入拒绝优先使用 blocked_reason", async ({ page }) => {
  const cases: Array<[EmailChannelBlockReason, Partial<EmailView>]> = [
    ["pending_activation", { session_state: "pending" }],
    ["recovery_code_unconfirmed", { recovery_code_required: true }],
    ["recovery_code_not_saved", { recovery_code_saved: false }],
    ["address_suppressed", { deliverability: "suppressed" }],
    ["deliverability_unknown", { deliverability: "unknown" }],
    ["capacity_full", { remaining: { seat: 0, routine: 0 } }],
    ["capacity_unknown", { remaining: { seat: "unknown", routine: "unknown" } }],
  ];
  const run = await openSubscription(page, {
    write: async (route) =>
      route.fulfill({ status: 401, json: emailChannelRefusal("recovery_code_not_saved", "seat") }),
  });
  await consent(page);
  await expect(part(page, "message")).toContainText("请先保存并确认当前恢复码");
  for (const [_reason, patch] of cases) {
    Object.assign(run.state, facts(), patch);
    await part(page, "refresh").click();
    await expect(part(page, "message")).toContainText("已读取当前邮件状态");
    await expect(part(page, "seat-start")).toBeDisabled();
    await expect(part(page, "seat-reason")).not.toBeEmpty();
    await expect(part(page, "seat-stop")).toBeEnabled();
  }
  expect(run.writes).toHaveLength(1);
});

test("U22 同意关闭、租期、投诉抑制、全站预算可并存；关闭不改其他通道", async ({ page }) => {
  const state = facts();
  state.deliverability = "suppressed";
  state.suppression_kind = "complaint";
  state.service.state = "budget_limited";
  state.lease.expires_at = state.server_time;
  state.lease.last_renewed_at = state.server_time;
  state.consent.seat = {
    version: EMAIL_CONSENT_VERSION,
    enabled_at: state.server_time,
    last_event: { action: "disable", created_at: state.server_time },
  };
  const run = await openSubscription(page, { state });
  await expect(page.getByRole("region", { name: "同意与主动关闭" })).toContainText("已关闭");
  await expect(part(page, "facts")).toContainText("投诉");
  await expect(part(page, "facts")).toContainText("预算受限");
  await expect(part(page, "facts")).toContainText("北京时间 UTC+8");
  await part(page, "seat-stop").click();
  await expect(part(page, "message")).toContainText("邮件席位：已关闭");
  expect(run.writes[0]).toEqual({
    expected_revision: 7,
    email_version: 4,
    subscription_revision: 1,
    enabled: false,
  });
  expect(run.saves).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("coexisting-states.png"), fullPage: true });
});

test("U22 断网但已写入时只 GET 核对；缺字段不显示正常或可开启", async ({ page }) => {
  const run = await openSubscription(page, {
    write: async (route, _body, state) => {
      state.enabled = true;
      await route.abort();
    },
  });
  await consent(page);
  await expect(part(page, "message")).toContainText("请求结果未知");
  await expect(part(page, "seat-status")).toContainText("已开启");
  expect(run.writes).toHaveLength(1);
  await page.route("**/api/v2/me/email-channel", (route) =>
    route.fulfill({ json: { ...run.state, service: {} } }),
  );
  await part(page, "refresh").click();
  await expect(part(page, "facts")).toContainText("邮件状态未知");
  await expect(part(page, "seat-start")).toBeDisabled();
});

for (const save of [false, true])
  test(`U11 真实保存状态机接邮件：${save ? "保存后继续" : "使用已保存设置"}只展示已保存版本`, async ({
    page,
  }) => {
    const run = await openSubscription(page, { dirty: true });
    await part(page, "seat-start").click();
    await expect(part(page, "draft-choice")).toBeVisible();
    await part(page, save ? "save-continue" : "use-saved").click();
    await expect(part(page, "disclosure")).toContainText(`已保存内容（版本 ${save ? 2 : 1}）`);
    if (save) await expect(part(page, "disclosure")).toContainText("提前提醒：未选择");
    expect(run.saves.length).toBe(save ? 1 : 0);
    expect(run.writes).toHaveLength(0);
    await part(page, "seat-consent").check();
    await part(page, "confirm").click();
    await expect.poll(() => run.writes.length).toBe(1);
    expect(run.writes[0]?.subscription_revision).toBe(save ? 2 : 1);
  });

test("U11 保存冲突不打开同意、不提交邮件", async ({ page }) => {
  const run = await openSubscription(page, { dirty: true, saveConflict: true });
  await part(page, "seat-start").click();
  await part(page, "save-continue").click();
  await expect(part(page, "message")).toContainText("请先处理保存结果或冲突");
  await expect(part(page, "confirmation")).toBeHidden();
  expect(run.writes).toHaveLength(0);
});

test("U22 身份失效清除私人视图，旧响应不重现；不写本机存储", async ({ page }) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openSubscription(page, {
    write: async (route, _body, state) => {
      await pending;
      state.enabled = true;
      await route.fulfill({ json: { result: "completed", state } });
    },
  });
  await consent(page);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
    ),
  );
  await expect(page.locator("#mail-channel")).toContainText("未展示邮件状态");
  release?.();
  await expect(page.locator("#mail-channel")).not.toContainText("example.invalid");
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test("U22b 已有席位时单独开启与关闭常规层；键盘明确确认且不重记席位同意", async ({ page }) => {
  const state = facts();
  state.enabled = true;
  // Service disclosures are facts, even when they differ from bundled defaults.
  state.disclosure.daily_limits.routine = MAIL_USER_BASE_DAY + 1;
  const run = await openSubscription(page, { state });
  await part(page, "routine-start").focus();
  await page.keyboard.press("Enter");
  await expect(part(page, "seat-label")).toBeHidden();
  await expect(part(page, "routine-consent")).not.toBeChecked();
  await expect(part(page, "disclosure")).toContainText(`常规层 ${MAIL_USER_BASE_DAY + 1} 次`);
  await part(page, "routine-consent").focus();
  await page.keyboard.press("Space");
  await part(page, "confirm").focus();
  await page.keyboard.press("Enter");
  await expect(part(page, "message")).toContainText("常规提醒邮件：已开启");
  expect(run.writes[0]).toEqual({
    expected_revision: 7,
    email_version: 4,
    subscription_revision: 1,
    routine_enabled: true,
    routine_consent_version: EMAIL_CONSENT_VERSION,
  });
  await part(page, "routine-stop").click();
  await expect(part(page, "message")).toContainText("邮件席位：已开启；常规提醒邮件：已关闭");
  expect(run.writes[1]).toEqual({
    expected_revision: 8,
    email_version: 4,
    subscription_revision: 1,
    routine_enabled: false,
  });
});

test("U22 拒绝后的重读失败保持未知，不沿用旧同意；重新读取也不提交", async ({ page }) => {
  const run = await openSubscription(page, {
    write: async (route) => {
      await page.route("**/api/v2/me/email-channel", (next) => next.abort());
      await route.fulfill({
        status: 409,
        json: buildApiErrorBody("conflict", { code: "conflict" }),
      });
    },
  });
  await consent(page);
  await expect(part(page, "message")).toContainText("当前事实仍无法读取");
  await expect(part(page, "confirmation")).toBeHidden();
  await expect(part(page, "seat-start")).toBeDisabled();
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("无法读取邮件状态");
  expect(run.writes).toHaveLength(1);
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function identity(page: Page, userId: string | null) {
  await page.evaluate(
    (userId) =>
      document.dispatchEvent(
        new CustomEvent("hoyo:draft-identity", {
          detail: userId ? { status: "confirmed", userId } : { status: "unknown" },
        }),
      ),
    userId,
  );
}

test("U22 正式页首次加载等待身份和已保存版本，不把未知显示为关闭", async ({ page }) => {
  const account = gate();
  const subscription = gate();
  const run = await openSubscription(page, {
    beforeAccount: account.promise,
    beforeSubscription: subscription.promise,
    waitForReady: false,
  });
  await expect(page.locator("#mail-channel")).toContainText("状态尚未读取");
  expect(run.reads()).toBe(0);
  account.release();
  await expect(page.locator("#draft-state")).toContainText("正在读取云端设置");
  expect(run.reads()).toBe(0);
  await expect(page.locator("#mail-channel")).not.toContainText("已关闭");
  subscription.release();
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  expect(run.reads()).toBe(1);
  expect(run.writes).toEqual([]);
  expect(run.saves).toEqual([]);
});

test("U22 正式页已开启事实覆盖占位，恢复码未保存不能开启也不会默认写订阅", async ({ page }) => {
  const state = facts();
  state.enabled = true;
  state.recovery_code_saved = false;
  const run = await openSubscription(page, { state });
  await expect(part(page, "seat-status")).toHaveText("已开启");
  await expect(part(page, "routine-start")).toBeDisabled();
  await expect(part(page, "routine-reason")).toContainText("请先保存并确认当前恢复码");
  await expect(page.locator("#change-summary")).not.toContainText("接收方式尚未开启");
  await screenshot(page, "recovery-blocked");
  expect(run.writes).toEqual([]);
  expect(run.saves).toEqual([]);
});

for (const next of [false, true])
  test(`U22 正式页${next ? "换账号" : "退出"}立即清理，迟到邮件 GET 不能恢复旧视图`, async ({
    page,
  }) => {
    const late = gate();
    const done = gate();
    const run = await openSubscription(page, {
      read: async (route, state, count) => {
        if (count === 2) {
          await late.promise;
          await route.fulfill({ json: state });
          done.release();
        } else await route.fulfill({ json: state });
      },
    });
    await part(page, "refresh").click();
    await expect.poll(run.reads).toBe(2);
    await identity(page, null);
    await expect(page.locator("#mail-channel")).toContainText("未展示邮件状态");
    await expect(page.locator("#mail-channel")).not.toContainText("s***@example.invalid");
    if (next) {
      run.state.email.masked = "b***@example.invalid";
      await identity(page, "synthetic-account-b");
      await expect(part(page, "facts")).toContainText("b***@example.invalid");
    }
    late.release();
    await done.promise;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator("#mail-channel")).not.toContainText("s***@example.invalid");
    if (next) await expect(part(page, "facts")).toContainText("b***@example.invalid");
    else await expect(page.locator("#mail-channel")).toContainText("未展示邮件状态");
  });

test("U22 首次邮件 GET 未完成时切换身份，旧请求不能占据新实例", async ({ page }) => {
  const late = gate();
  const done = gate();
  const run = await openSubscription(page, {
    waitForReady: false,
    read: async (route, state, count) => {
      if (count === 1) await late.promise;
      await route.fulfill({ json: state });
      if (count === 1) done.release();
    },
  });
  await expect.poll(run.reads).toBe(1);
  await identity(page, null);
  run.state.email.masked = "b***@example.invalid";
  await identity(page, "synthetic-account-b");
  await expect(part(page, "facts")).toContainText("b***@example.invalid");
  late.release();
  await done.promise;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(part(page, "facts")).not.toContainText("s***@example.invalid");
});

test("U22 跨标签身份失效立即清空；重新确认后重读；页面保存更新邮件摘要版本", async ({ page }) => {
  const run = await openSubscription(page);
  await page.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  });
  await expect(page.locator("#mail-channel")).toContainText("未展示邮件状态");
  await identity(page, "synthetic-account-a");
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  await editRules(page);
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  await part(page, "seat-start").click();
  await expect(part(page, "disclosure")).toContainText("已保存内容（版本 2）");
  await expect(part(page, "disclosure")).toContainText("提前提醒：未选择");
  expect(run.writes).toEqual([]);
});

test("U22 未初始化账号先保存一次；初始草稿预选不产生邮件同意", async ({ page }) => {
  const state = facts();
  state.subscription_state = "uninitialized";
  state.subscription = { state: "uninitialized", revision: 0, config: null };
  const run = await openSubscription(page, { state });
  await expect(part(page, "seat-reason")).toContainText("先保存一次订阅内容");
  await expect(part(page, "seat-start")).toBeDisabled();
  expect(run.writes).toEqual([]);
  expect(run.saves).toEqual([]);
});

test("U22 E2 正式构建页确认布局：完整页面无横向溢出，主要操作可见可触控", async ({ page }) => {
  await openSubscription(page);
  await part(page, "seat-start").click();
  await part(page, "seat-consent").check();
  await expect(part(page, "confirmation")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  for (const name of ["confirm", "cancel-confirm", "seat-start", "seat-stop", "refresh"]) {
    const box = await part(page, name).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await screenshot(page, "confirmation-page", true);
});

test("U22 同账号保存更新之后迟到的旧邮件快照保持未知，重读后使用新版本", async ({ page }) => {
  const late = gate();
  const run = await openSubscription(page, {
    waitForReady: false,
    read: async (route, state, count) => {
      if (count === 1) await late.promise;
      await route.fulfill({ json: state });
    },
  });
  await expect.poll(run.reads).toBe(1);
  await editRules(page);
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  late.release();
  await expect(part(page, "facts")).toContainText("邮件状态未知");
  await expect(part(page, "seat-start")).toBeDisabled();
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  await part(page, "seat-start").click();
  await expect(part(page, "disclosure")).toContainText("已保存内容（版本 2）");
});

test("U22 显式邮件操作 completed 启用停用各续期一次，GET 不续期", async ({ page }) => {
  const run = await openSubscription(page);
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  expect(run.renewals()).toBe(0);
  await consent(page);
  await expect(part(page, "message")).toContainText("已核对操作结果");
  await expect.poll(run.renewals).toBe(1);
  await part(page, "routine-start").click();
  await part(page, "routine-consent").check();
  await part(page, "confirm").click();
  await expect(part(page, "message")).toContainText("常规提醒邮件：已开启");
  await expect.poll(run.renewals).toBe(2);
  await part(page, "routine-stop").click();
  await expect(part(page, "message")).toContainText("常规提醒邮件：已关闭");
  await expect.poll(run.renewals).toBe(3);
  await part(page, "seat-stop").click();
  await expect(part(page, "message")).toContainText("邮件席位：已关闭");
  await expect.poll(run.renewals).toBe(4);
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  expect(run.renewals()).toBe(4);
  expect(run.writes).toHaveLength(4);
});

for (const outcome of ["completed", "partial", "disabled"] as const)
  test(`U11 U22 迟到 PUT ${outcome} 保留操作事实但旧保存版本不能成为当前状态`, async ({ page }) => {
    const late = gate();
    const written = gate();
    const run = await openSubscription(page, {
      state: { ...facts(), enabled: outcome === "disabled" },
      write: async (route, body, state) => {
        applyUpdate(state, outcome === "partial" ? { ...body, routine_enabled: undefined } : body);
        if (outcome === "partial") state.remaining.routine = 0;
        const result = {
          result: outcome === "partial" ? "partial" : "completed",
          state: structuredClone(state),
          ...(outcome === "partial"
            ? { routine_error: { code: "capacity_reached", capability: "email_routine" } }
            : {}),
        };
        written.release();
        await late.promise;
        await route.fulfill({ json: result });
      },
    });
    if (outcome === "disabled") await part(page, "seat-stop").click();
    else await consent(page, outcome === "partial");
    await written.promise;
    expect(run.renewals()).toBe(0);
    await editRules(page);
    await page.getByRole("button", { name: "保存订阅", exact: true }).click();
    await expect(page.locator("#cloud-state")).toContainText("版本 2");
    late.release();
    await expect(part(page, "message")).toContainText("操作回执（保存版本 1）");
    await expect(part(page, "message")).toContainText(
      outcome === "partial" ? "部分完成" : "已完成",
    );
    await expect(part(page, "message")).toContainText(
      outcome === "disabled" ? "邮件席位：已关闭" : "邮件席位：已开启",
    );
    await expect(part(page, "facts")).toContainText("邮件状态未知");
    await expect(part(page, "seat-start")).toBeDisabled();
    await expect(part(page, "confirmation")).toBeHidden();
    await expect.poll(run.renewals).toBe(1);
    expect(run.writes).toHaveLength(1);
    await part(page, "refresh").click();
    await expect(part(page, "message")).toContainText("已读取当前邮件状态");
    await expect(part(page, "seat-status")).toHaveText(
      outcome === "disabled" ? "未开启 / 已关闭" : "已开启",
    );
    expect(run.renewals()).toBe(1);
    expect(run.writes).toHaveLength(1);
    if (outcome === "disabled") {
      await part(page, "seat-start").click();
      await expect(part(page, "seat-consent")).not.toBeChecked();
      await expect(part(page, "disclosure")).toContainText("已保存内容（版本 2）");
      await expect(part(page, "confirm")).toBeDisabled();
    }
  });

for (const outcome of ["completed", "partial"] as const)
  for (const failure of ["http", "network", "pending"] as const)
    test(`U22 ${outcome} 续期 ${failure} 不改写或阻塞已完成邮件结果`, async ({ page }) => {
      const late = gate();
      const renewalDone = gate();
      const run = await openSubscription(page, {
        renew: async (route) => {
          if (failure === "pending") await late.promise;
          if (failure === "network") await route.abort();
          else await route.fulfill({ status: 503, json: {} });
          renewalDone.release();
        },
        write: async (route, body, state) => {
          applyUpdate(
            state,
            outcome === "partial" ? { ...body, routine_enabled: undefined } : body,
          );
          await route.fulfill({
            json: {
              result: outcome,
              state,
              ...(outcome === "partial"
                ? { routine_error: { code: "capacity_reached", capability: "email_routine" } }
                : {}),
            },
          });
        },
      });
      await consent(page, outcome === "partial");
      await expect(part(page, "message")).toContainText(
        outcome === "partial" ? "部分完成" : "已核对操作结果",
      );
      await expect.poll(run.renewals).toBe(1);
      const message = await part(page, "message").textContent();
      await expect(part(page, "refresh")).toBeEnabled();
      late.release();
      await renewalDone.promise;
      await settleBrowser(page);
      await expect(part(page, "message")).toHaveText(message ?? "");
      await expect(part(page, "seat-status")).toHaveText("已开启");
      expect(run.writes).toHaveLength(1);
      await part(page, "refresh").click();
      await expect(part(page, "message")).toContainText("已读取当前邮件状态");
      expect(run.renewals()).toBe(1);
    });

async function settleBrowser(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("U22 加载、未确认、取消、可见性与重读均不续期", async ({ page }) => {
  const run = await openSubscription(page);
  await part(page, "seat-start").click();
  await part(page, "seat-consent").check();
  await expect(part(page, "confirm")).toBeEnabled();
  expect(run.renewals()).toBe(0);
  await part(page, "cancel-confirm").click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("已读取当前邮件状态");
  await settleBrowser(page);
  expect(run.renewals()).toBe(0);
  expect(run.writes).toHaveLength(0);
});

for (const failure of ["conflict", "validation", "rejected", "unknown", "malformed"] as const)
  test(`U22 邮件 ${failure} 及核对 GET 不续期、不自动重发`, async ({ page }) => {
    const run = await openSubscription(page, {
      write: async (route, body, state) => {
        if (failure === "unknown" || failure === "malformed") {
          applyUpdate(state, body);
          if (failure === "unknown") return route.abort();
          return route.fulfill({ json: { result: "completed", state: { ...state, service: {} } } });
        }
        if (failure === "rejected")
          return route.fulfill({
            status: 401,
            json: emailChannelRefusal("recovery_code_not_saved", "seat"),
          });
        await route.fulfill({
          status: failure === "conflict" ? 409 : 400,
          json: buildApiErrorBody(
            failure,
            failure === "conflict" ? { code: failure } : { code: failure, fields: [] },
          ),
        });
      },
    });
    await consent(page);
    await expect(part(page, "message")).toContainText("已重新读取当前事实");
    await settleBrowser(page);
    expect(run.renewals()).toBe(0);
    expect(run.writes).toHaveLength(1);
    await part(page, "refresh").click();
    await expect(part(page, "message")).toContainText("已读取当前邮件状态");
    expect(run.renewals()).toBe(0);
    expect(run.writes).toHaveLength(1);
  });

for (const outcome of ["completed", "partial"] as const)
  test(`U22 旧身份迟到 ${outcome} PUT 不续期、不恢复私人视图`, async ({ page }) => {
    const late = gate();
    const written = gate();
    const responded = gate();
    const run = await openSubscription(page, {
      write: async (route, body, state) => {
        applyUpdate(state, outcome === "partial" ? { ...body, routine_enabled: undefined } : body);
        const result = {
          result: outcome,
          state: structuredClone(state),
          ...(outcome === "partial"
            ? { routine_error: { code: "capacity_reached", capability: "email_routine" } }
            : {}),
        };
        written.release();
        await late.promise;
        await route.fulfill({ json: result });
        responded.release();
      },
    });
    await consent(page, outcome === "partial");
    await written.promise;
    await identity(page, null);
    run.state.email.masked = "b***@example.invalid";
    await identity(page, "synthetic-account-b");
    await expect(part(page, "facts")).toContainText("b***@example.invalid");
    late.release();
    await responded.promise;
    await settleBrowser(page);
    await expect(part(page, "facts")).not.toContainText("s***@example.invalid");
    await expect(part(page, "message")).toContainText("已读取当前邮件状态");
    expect(run.renewals()).toBe(0);
    expect(run.writes).toHaveLength(1);
  });
