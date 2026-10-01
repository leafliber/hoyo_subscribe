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
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEAT_LEASE,
  MAIL_SEATS_MAX,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  parseSubscriptionConfig,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { Draft, Phase, SubscriptionSaveMachine } from "../../subscription/save/machine";
import type { EmailUpdate, EmailView } from "./api";

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
declare global {
  interface Window {
    emailTest: {
      machine: SubscriptionSaveMachine;
      edit(): void;
      panel: { refresh(): Promise<void>; dispose(): void };
    };
  }
}
async function mount(
  page: Page,
  options: {
    state?: WireView;
    dirty?: boolean;
    write?: (route: Route, body: EmailUpdate, state: WireView) => Promise<void>;
    saveConflict?: boolean;
  } = {},
) {
  const state = options.state ?? facts();
  const writes: EmailUpdate[] = [];
  const saves: unknown[] = [];
  let reads = 0;
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
  await page.route("**/email-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles/tokens.css"></head><body><main id="email-root"></main></body></html>',
    }),
  );
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: state.subscription });
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
      return route.fulfill({ json: state });
    }
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-csrf");
    const body = route.request().postDataJSON() as EmailUpdate;
    writes.push(body);
    if (options.write) return options.write(route, body, state);
    state.enabled = body.enabled ?? state.enabled;
    state.routine_enabled = state.enabled && (body.routine_enabled ?? state.routine_enabled);
    state.channel_revision++;
    await route.fulfill({ json: { result: "completed", state } });
  });
  await page.goto("/email-fixture");
  await page.evaluate(
    async ({ base, dirty }) => {
      const machinePath = "/src/features/subscription/save/machine.ts";
      const panelPath = "/src/features/channels/email/panel.ts";
      const { SubscriptionSaveMachine } = (await import(
        machinePath
      )) as typeof import("../../subscription/save/machine");
      const { mountEmailChannel } = (await import(panelPath)) as typeof import("./panel");
      let draft: Draft = structuredClone(base);
      let phase: Phase = "guest";
      const machine = new SubscriptionSaveMachine({
        readDraft: () => draft,
        applyDraft: (value) => {
          draft = value;
        },
        render: (value) => {
          phase = value;
        },
        compare() {},
        validation() {},
      });
      await machine.start();
      const edit = () => {
        draft = { ...draft, notifications: { ...draft.notifications, rule_ids: [] } };
        machine.edited();
      };
      if (dirty) edit();
      const root = document.getElementById("email-root");
      if (!root) throw new Error("fixture_missing");
      const panel = mountEmailChannel(root, {
        machine: () => machine,
        readDraft: () => draft,
        phase: () => phase,
        current: () => true,
        save: () => machine.save(),
      });
      window.emailTest = { machine, panel, edit };
      await panel.refresh();
    },
    { base, dirty: options.dirty ?? false },
  );
  return { state, writes, saves, reads: () => reads };
}
const part = (page: Page, name: string) => page.locator(`[data-email="${name}"]`);
async function consent(page: Page, routine = false) {
  await part(page, "seat-start").click();
  await part(page, "seat-consent").check();
  if (routine) await part(page, "routine-consent").check();
  await part(page, "confirm").click();
}

test("U22b 席位和常规层默认关闭；只同意席位，版本来自 GET，发送暂停独立显示", async ({ page }) => {
  const run = await mount(page);
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
  await page.screenshot({ path: test.info().outputPath("seat-only.png"), fullPage: true });
});

test("U22b 两层分别同意；子名额竞争导致 partial，逐项保留真实结果", async ({ page }) => {
  const run = await mount(page, {
    write: async (route, _body, state) => {
      state.enabled = true;
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
  await page.screenshot({ path: test.info().outputPath("partial.png"), fullPage: true });
});

for (const kind of ["conflict", "validation"] as const)
  test(`U22 ${kind} 后重读邮箱/订阅/同意版本并重新确认，不自动重试`, async ({ page }) => {
    const run = await mount(page, {
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

test("U22 按 contracts 全部受阻原因置灰，写入拒绝优先使用 blocked_reason", async ({ page }) => {
  const cases: Array<[EmailChannelBlockReason, Partial<EmailView>]> = [
    ["pending_activation", { session_state: "pending" }],
    ["recovery_code_unconfirmed", { recovery_code_required: true }],
    ["recovery_code_not_saved", { recovery_code_saved: false }],
    [
      "subscription_uninitialized",
      { subscription_state: "uninitialized", subscription: { revision: 0, config: null } },
    ],
    ["address_suppressed", { deliverability: "suppressed" }],
    ["deliverability_unknown", { deliverability: "unknown" }],
    ["capacity_full", { remaining: { seat: 0, routine: 0 } }],
    ["capacity_unknown", { remaining: { seat: "unknown", routine: "unknown" } }],
  ];
  const run = await mount(page, {
    write: async (route) =>
      route.fulfill({ status: 401, json: emailChannelRefusal("recovery_code_not_saved", "seat") }),
  });
  await consent(page);
  await expect(part(page, "message")).toContainText("请先保存并确认当前恢复码");
  for (const [reason, patch] of cases) {
    Object.assign(run.state, facts(), patch);
    if (reason === "subscription_uninitialized") run.state.subscription.state = "uninitialized";
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
  const run = await mount(page, { state });
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
  const run = await mount(page, {
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
    const run = await mount(page, { dirty: true });
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
  const run = await mount(page, { dirty: true, saveConflict: true });
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
  await mount(page, {
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
  await expect(page.locator("#email-root")).toContainText("已清除邮件状态");
  release?.();
  await expect(page.locator("#email-root")).not.toContainText("example.invalid");
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test("U22b 已有席位时单独开启与关闭常规层；键盘明确确认且不重记席位同意", async ({ page }) => {
  const state = facts();
  state.enabled = true;
  // Service disclosures are facts, even when they differ from bundled defaults.
  state.disclosure.daily_limits.routine = MAIL_USER_BASE_DAY + 1;
  const run = await mount(page, { state });
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
  const run = await mount(page, {
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
