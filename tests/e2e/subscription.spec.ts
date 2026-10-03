// F2-04 获准跨卡：仅将证据截图写入改为显式环境变量启用。
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  SUBSCRIPTION_RULE_COPY,
} from "../../packages/contracts/src";

test("U09a U10 清空全部提前规则仍可开变更消息；最后一条只提示，不要求确认", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.goto("/subscription");
  const rules = page.locator('input[name="rule_ids"]:checked');
  expect(await rules.count()).toBeGreaterThan(0);
  while ((await rules.count()) > 0) await rules.first().uncheck();
  await expect(page.locator('input[name="rule_ids"]:checked')).toHaveCount(0);
  await expect(page.locator("#rule-empty-note")).toBeVisible();
  await expect(page.locator("#rule-empty-note")).toHaveText(
    "不会收到提前提醒；活动取消或改期的通知仍会按下方设置发送。",
  );
  const change = page.getByRole("checkbox", { name: "新事件公布" });
  await expect(change).toBeEnabled();
  await change.check();
  await expect(change).toBeChecked();
  // 游客（含已改过选项的游客）的保存按钮是「登录并保存」：空提醒通过本地校验后
  // 一次点击即准备续接并跳转登录页（不写云端、不弹确认）。
  const save = page.locator("#save-subscription");
  await expect(save).toHaveText("登录并保存");
  await save.click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fsubscription$/);
  expect(dialogs).toEqual([]);
});

test("U09 关闭日历提醒只改变日历选择，规则及邮件和 Push 区域保持原样", async ({ page }) => {
  await page.goto("/subscription");
  const selectedRules = await page
    .locator('input[name="rule_ids"]:checked')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  const mailBefore = await page.locator("#mail-channel").innerText();
  // 浏览器通知（Push）区域已移除；改为核对另一个接收方式（日历订阅）区域不受影响。
  const calendarBefore = await page.locator("#calendar-channel").innerText();
  await page.getByRole("checkbox", { name: "在日历中提醒我" }).uncheck();
  await expect(page.locator("#alarm-status")).toContainText("已关闭");
  expect(
    await page
      .locator('input[name="rule_ids"]:checked')
      .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value)),
  ).toEqual(selectedRules);
  expect(await page.locator("#mail-channel").innerText()).toBe(mailBefore);
  expect(await page.locator("#calendar-channel").innerText()).toBe(calendarBefore);
});

test("U09 初始值来自 DEFAULT_*，只是本机预选；没有 Feed 时不宣称外部提醒已开启", async ({
  page,
}) => {
  await page.goto("/subscription");
  for (const [name, expected] of [
    ["games", DEFAULT_SCOPE_GAMES],
    ["event_types", DEFAULT_CALENDAR_EVENT_TYPES],
    ["node_types", DEFAULT_CALENDAR_NODE_TYPES],
    ["rule_ids", DEFAULT_RULE_IDS],
  ] as const) {
    const values = await page
      .locator(`input[name="${name}"]:checked`)
      .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
    expect(values).toEqual([...expected]);
  }
  for (const [key, selected] of Object.entries(CHANGE_DEFAULTS)) {
    expect(await page.locator(`input[name="${key}"]`).isChecked()).toBe(selected);
  }
  expect(await page.locator('input[name="alarms_enabled"]').isChecked()).toBe(
    CALENDAR_ALARMS_DEFAULT,
  );
  await expect(page.locator("#cloud-state")).toHaveText("未登录 · 设置仅保存在本机");
  await expect(page.locator("#draft-state")).toHaveText("登录后可保存到云端");
  await expect(page.locator("#alarm-status")).toContainText("按下方规则提前提醒");
  await expect(page.locator("#alarm-status")).not.toContainText("已在外部日历开启");
  await expect(page.locator("#calendar-channel")).not.toContainText("已在外部日历开启");
});

test("U09a 规则选项与推荐分组来自 contracts；变更范围取 calendar.event_types 与规则事件类型并集", async ({
  page,
}) => {
  await page.goto("/subscription");
  const renderedRules = await page
    .locator('input[name="rule_ids"]')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  expect(renderedRules.sort()).toEqual(SUBSCRIPTION_RULE_COPY.map((rule) => rule.rule_id).sort());
  // 全部规则按事件类型分组展示；推荐项以「推荐」徽标标出。
  const recommended = await page
    .locator('#recommended-rules label:has(.badge) input[name="rule_ids"]')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  expect(recommended).toEqual([...DEFAULT_RULE_IDS]);

  await page.locator('input[name="event_types"][value="gacha"]').uncheck();
  await expect(page.locator("#change-scope")).toContainText("卡池");
  await page.locator('input[name="rule_ids"][value="gacha_end_1d"]').uncheck();
  await expect(page.locator("#change-scope")).not.toContainText("卡池");
  await page.locator('input[name="event_types"][value="gacha"]').check();
  await expect(page.locator("#change-scope")).toContainText("卡池");
  // 原 #change-settings 折叠摘要（#change-summary）已移除，变化通知开关始终可见，无摘要可核对。
  for (const source of [
    "apps/web/src/pages/subscription.astro",
    "apps/web/src/features/subscription/page.ts",
  ]) {
    const webSource = readFileSync(resolve(source), "utf8");
    for (const rule of SUBSCRIPTION_RULE_COPY) expect(webSource).not.toContain(rule.rule_id);
  }
});

test("U09 U10 一个主按钮、无自由分钟输入；空游戏和空日历类型错误可聚焦且保存栏不遮挡", async ({
  page,
}, info) => {
  await page.goto("/subscription");
  // 新设计有多个次级按钮；「一个主按钮」对应表单里唯一的提交（保存）按钮。
  await expect(page.locator('#subscription-form [type="submit"]')).toHaveCount(1);
  await expect(page.locator('input[type="number"]')).toHaveCount(0);
  await expect(page.locator('[name="lead_minutes"]')).toHaveCount(0);
  const checkedGames = page.locator('input[name="games"]:checked');
  while ((await checkedGames.count()) > 0) await checkedGames.first().uncheck();
  await page.locator("#save-subscription").click();
  await expect(page.locator("#game-error")).toBeFocused();
  await expect(page.locator("#game-error")).toBeVisible();
  await page.locator('input[name="games"]').first().check();
  const checkedEventTypes = page.locator('input[name="event_types"]:checked');
  while ((await checkedEventTypes.count()) > 0) await checkedEventTypes.first().uncheck();
  await page.locator("#save-subscription").click();
  // 活动类型已是常显卡片，不再需要展开 #calendar-settings 才能看到错误。
  await expect(page.locator("#event-type-error")).toBeVisible();
  await expect(page.locator("#event-type-error")).toBeFocused();
  await expect(page).toHaveURL(/\/subscription$/);
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  if (viewport === "mobile") await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  for (const selector of ["#event-type-error", "#mail-channel"]) {
    const el = page.locator(selector);
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
      page.viewportSize()?.height ?? 0,
    );
  }
});

test("U09a 页面仅维护本机选择，不请求订阅 API；实际预览和三个接收方式均明确状态", async ({
  page,
}) => {
  const apiRequests: string[] = [];
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

  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiRequests.push(request.url());
  });
  await page.goto("/subscription");
  await expect(page.locator("#actual-preview")).toContainText("未保存草稿");
  await expect(page.locator("#actual-preview")).toContainText("样例预览（合成数据）");
  await expect(page.locator("#calendar-channel")).toBeVisible();
  await expect(page.locator("#mail-channel")).toBeVisible();
  // 浏览器通知（Push）区域已从新界面移除；现有两个接收方式都给出明确的未登录状态。
  await expect(page.locator("#calendar-channel")).toContainText("登录并保存订阅后");
  await expect(page.locator("#mail-channel")).toContainText("登录并保存订阅后");
  await expect(page.locator("#cloud-state")).toHaveText("未登录 · 设置仅保存在本机");
  // 游客的保存按钮只跳转登录页；拦下这次跳转，确认页面本身没有为此发出任何 API 请求。
  await page.route(
    (url) => url.pathname === "/login",
    (route) => route.abort("aborted"),
  );
  const navigation = page.waitForRequest((request) =>
    request.url().endsWith("/login?returnTo=%2Fsubscription"),
  );
  await page.getByRole("button", { name: "登录并保存" }).click();
  expect((await navigation).isNavigationRequest()).toBe(true);
  await expect(page).toHaveURL(/\/subscription$/);
  expect(apiRequests.map((url) => new URL(url).pathname)).toEqual(["/api/v2/calendar/nodes"]);
});

test("U09 U09a U10 E2 桌面与手机实际截图", async ({ page }, info) => {
  await page.goto("/subscription");
  const folder = resolve(
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f2-01"
      : "tests/e2e/test-results/f2-01",
  );
  mkdirSync(folder, { recursive: true });
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  await page.screenshot({ path: `${folder}/${viewport}-subscription.png`, fullPage: true });
});
