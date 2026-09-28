// F2-03 获准跨卡改动：U11/U16/U17 的订阅保存浏览器验收。
import { expect, type Page, test } from "@playwright/test";
import {
  buildApiErrorBody,
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
} from "../../packages/contracts/src";

const base: SubscriptionConfig = {
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

async function session(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "test-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
}

test("U11 显式保存已保存配置；后续本机改动不被旧响应清空，通道摘要仍指向已保存版本", async ({
  page,
}) => {
  await session(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: unknown[] = [];
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { state: "initialized", revision: 1, config: base } });
      return;
    }
    const body = route.request().postDataJSON() as {
      expected_revision: number;
      config: Record<string, unknown>;
    };
    writes.push(body);
    await pending;
    await route.fulfill({
      json: {
        state: "initialized",
        revision: 2,
        config: { ...body.config, revision: 2 },
        saved: true,
      },
    });
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.locator("#change-settings summary").click();
  await page.getByRole("checkbox", { name: "新事件公布" }).check();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#draft-state")).toHaveText("正在保存");
  await page.locator("#calendar-settings summary").click();
  await page.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  release?.();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  await expect(page.locator("#draft-state")).toContainText("本机未保存修改");
  await expect(page.getByRole("checkbox", { name: "日历提醒" })).not.toBeChecked();
  await expect(page.locator("#channel-saved-summary")).toContainText("版本 2");
  await expect(page.locator("#channel-saved-summary")).toContainText("日历提醒开启");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ expected_revision: 1 });
  expect((writes[0] as { config: Record<string, unknown> }).config).not.toHaveProperty("revision");
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#draft-state")).toContainText("当前选择与云端一致");
  expect(writes).toHaveLength(2);
});

test("U11 与云端规范配置相同的显式保存不发 PATCH", async ({ page }) => {
  await session(page);
  let writes = 0;
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { state: "initialized", revision: base.revision, config: base },
      });
    } else {
      writes += 1;
      await route.fulfill({ status: 500, json: { error: { code: "temporarily_unavailable" } } });
    }
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("无需再次保存");
  expect(writes).toBe(0);
});

test("U11 服务端字段错误定位字段；会话失效和额度暂停均保留草稿", async ({ page }) => {
  await session(page);
  let failure: { status: number; json: unknown } = {
    status: 400,
    json: buildApiErrorBody("validation", {
      code: "validation",
      fields: [{ path: "config.calendar.event_types", reason: "invalid" }],
    }),
  };
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { state: "initialized", revision: base.revision, config: base },
      });
    } else {
      await route.fulfill(failure);
    }
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.locator("#change-settings summary").click();
  const change = page.getByRole("checkbox", { name: "新事件公布" });
  await change.check();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#event-type-error")).toBeFocused();
  await expect(change).toBeChecked();
  failure = {
    status: 401,
    json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "session_expired" }),
  };
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("登录已过期");
  await expect(change).toBeChecked();
  failure = {
    status: 503,
    json: buildApiErrorBody("quota_paused", { code: "quota_paused", scope: "user_mutations_day" }),
  };
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("额度已用尽");
  await expect(change).toBeChecked();
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
});

test("U16 首次云端读取未完成时产生草稿，读取完成后进入比较而不静默覆盖", async ({ page }) => {
  await session(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await pending;
      await route.fulfill({
        json: { state: "initialized", revision: base.revision, config: base },
      });
    }
  });
  await page.goto("/subscription");
  await page.locator("#change-settings summary").click();
  const change = page.getByRole("checkbox", { name: "新事件公布" });
  await change.check();
  release?.();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(change).toBeChecked();
  await expect(page.getByRole("button", { name: "保存订阅" })).toBeDisabled();
});

test("U16 两设备同版本保存后一方 409：按四组比较，采用云端需确认，保留草稿可显式再保存", async ({
  context,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await session(first);
  let cloud = base;
  let firstCommitted: (() => void) | undefined;
  const commit = new Promise<void>((resolve) => {
    firstCommitted = resolve;
  });
  const writes: Array<{ expected_revision: number; config: Omit<SubscriptionConfig, "revision"> }> =
    [];
  await context.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { state: "initialized", revision: cloud.revision, config: cloud },
      });
      return;
    }
    const body = route.request().postDataJSON() as {
      expected_revision: number;
      config: Omit<SubscriptionConfig, "revision">;
    };
    writes.push(body);
    if (!body.config.notifications.new_event && body.expected_revision === 1) await commit;
    if (body.expected_revision !== cloud.revision) {
      await route.fulfill({
        status: 409,
        json: {
          error: { code: "conflict" },
          current: { state: "initialized", revision: cloud.revision, config: cloud },
        },
      });
      return;
    }
    cloud = { ...body.config, revision: cloud.revision + 1 };
    if (cloud.revision === 2) firstCommitted?.();
    await route.fulfill({
      json: { state: "initialized", revision: cloud.revision, config: cloud, saved: true },
    });
  });
  await Promise.all([first.goto("/subscription"), second.goto("/subscription")]);
  await expect(first.locator("#cloud-state")).toContainText("版本 1");
  await expect(second.locator("#cloud-state")).toContainText("版本 1");
  await first.locator("#change-settings summary").click();
  await first.getByRole("checkbox", { name: "新事件公布" }).check();
  await second.locator("#calendar-settings summary").click();
  await second.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  await Promise.all([
    first.getByRole("button", { name: "保存订阅" }).click(),
    second.getByRole("button", { name: "保存订阅" }).click(),
  ]);
  await expect(first.locator("#cloud-state")).toContainText("版本 2");
  await expect(second.locator("#save-comparison")).toBeVisible();
  await expect(second.locator("#save-differences h3")).toHaveCount(4);
  await expect(second.getByRole("button", { name: "保存订阅" })).toBeDisabled();
  second.once("dialog", (dialog) => void dialog.dismiss());
  await second.getByRole("button", { name: "采用云端设置" }).click();
  await expect(second.locator("#save-comparison")).toBeVisible();
  await second.getByRole("button", { name: "保留草稿，返回编辑" }).click();
  await expect(second.locator("#save-comparison")).toBeHidden();
  await expect(second.getByRole("checkbox", { name: "日历提醒" })).not.toBeChecked();
  await second.getByRole("button", { name: "保存订阅" }).click();
  await expect(second.locator("#cloud-state")).toContainText("版本 3");
  expect(writes.map((write) => write.expected_revision)).toEqual([1, 1, 2]);
});

test("U17 保存响应丢失：重新读取一致才确认", async ({ page }) => {
  await session(page);
  let cloud = base;
  let loseResponse = true;
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { state: "initialized", revision: cloud.revision, config: cloud },
      });
      return;
    }
    const body = route.request().postDataJSON() as { config: Omit<SubscriptionConfig, "revision"> };
    cloud = { ...body.config, revision: cloud.revision + 1 };
    if (loseResponse) await route.abort("failed");
    else
      await route.fulfill({
        json: { state: "initialized", revision: cloud.revision, config: cloud, saved: true },
      });
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.locator("#change-settings summary").click();
  await page.getByRole("checkbox", { name: "新事件公布" }).check();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("已从云端确认提交的配置");
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  loseResponse = false;
  await page.locator("#calendar-settings summary").click();
  await page.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#cloud-state")).toContainText("版本 3");
});

test("U17 响应丢失后虽读到提交快照，若已有后续草稿仍须比较", async ({ page }) => {
  await session(page);
  let cloud = base;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { state: "initialized", revision: cloud.revision, config: cloud },
      });
      return;
    }
    const body = route.request().postDataJSON() as { config: Omit<SubscriptionConfig, "revision"> };
    await pending;
    cloud = { ...body.config, revision: 2 };
    await route.abort("failed");
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.locator("#change-settings summary").click();
  await page.getByRole("checkbox", { name: "新事件公布" }).check();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#draft-state")).toHaveText("正在保存");
  await page.locator("#calendar-settings summary").click();
  await page.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  release?.();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "日历提醒" })).not.toBeChecked();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
});
