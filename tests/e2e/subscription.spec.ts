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
  await expect(page.locator("#rule-empty-note")).toHaveText(
    "将不再收到提前提醒，变更消息仍按所选游戏与日历显示范围发送。",
  );
  await page.locator("#change-settings summary").click();
  const change = page.getByRole("checkbox", { name: "新事件公布" });
  await expect(change).toBeEnabled();
  await change.check();
  await expect(change).toBeChecked();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("未写入云端");
  await expect(page.locator("#game-error")).toBeHidden();
  await expect(page.locator("#event-type-error")).toBeHidden();
  expect(dialogs).toEqual([]);
});

test("U09 关闭日历提醒只改变日历选择，规则及邮件和 Push 区域保持原样", async ({ page }) => {
  await page.goto("/subscription");
  const selectedRules = await page
    .locator('input[name="rule_ids"]:checked')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  const mailBefore = await page.locator("#mail-channel").innerText();
  const pushBefore = await page.locator("#push-channel").innerText();
  await page.locator("#calendar-settings summary").click();
  await page.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  await expect(page.locator("#alarm-status")).toContainText("已关闭日历提醒");
  expect(
    await page
      .locator('input[name="rule_ids"]:checked')
      .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value)),
  ).toEqual(selectedRules);
  expect(await page.locator("#mail-channel").innerText()).toBe(mailBefore);
  expect(await page.locator("#push-channel").innerText()).toBe(pushBefore);
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
  await expect(page.locator("#cloud-state")).toContainText("尚无已保存订阅");
  await expect(page.locator("#draft-state")).toContainText("本机预选");
  await expect(page.locator("#alarm-status")).toContainText("已选择日历提醒");
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
  const recommended = await page
    .locator('#recommended-rules input[name="rule_ids"]')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));
  expect(recommended).toEqual([...DEFAULT_RULE_IDS]);

  await page.locator("#calendar-settings summary").click();
  await page.locator('input[name="event_types"][value="gacha"]').uncheck();
  await expect(page.locator("#change-scope")).toContainText("卡池");
  await page.locator('input[name="rule_ids"][value="gacha_end_1d"]').uncheck();
  await expect(page.locator("#change-scope")).not.toContainText("卡池");
  await page.locator('input[name="event_types"][value="gacha"]').check();
  await expect(page.locator("#change-scope")).toContainText("卡池");
  await page.locator("#change-settings summary").click();
  await expect(page.locator("#change-summary")).not.toContainText("规则已配置");
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
  await expect(page.locator(".subscription-page .button")).toHaveCount(1);
  await expect(page.locator('input[type="number"]')).toHaveCount(0);
  await expect(page.locator('[name="lead_minutes"]')).toHaveCount(0);
  const checkedGames = page.locator('input[name="games"]:checked');
  while ((await checkedGames.count()) > 0) await checkedGames.first().uncheck();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#game-error")).toBeFocused();
  await expect(page.locator("#game-error")).toBeVisible();
  await page.locator('input[name="games"]').first().check();
  await page.locator("#calendar-settings summary").click();
  const checkedEventTypes = page.locator('input[name="event_types"]:checked');
  while ((await checkedEventTypes.count()) > 0) await checkedEventTypes.first().uncheck();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#calendar-settings")).toHaveAttribute("open", "");
  await expect(page.locator("#event-type-error")).toBeFocused();
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  if (viewport === "mobile") await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  for (const selector of ["#event-type-error", "#push-channel"]) {
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
  await expect(page.locator("#actual-preview")).toContainText("样例预览（合成）");
  await expect(page.locator("#calendar-channel")).toBeVisible();
  await expect(page.locator("#mail-channel")).toBeVisible();
  await expect(page.locator("#push-channel")).toBeVisible();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#save-result")).toContainText("未写入云端");
  await expect(page.locator("#cloud-state")).toContainText("尚无已保存订阅");
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
