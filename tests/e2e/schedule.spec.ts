import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const clock = new Date("2026-09-22T12:30:00+08:00");
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(clock);
});
async function scenario(page: Page, name: string) {
  const control = page.locator(".demo-controls");
  if ((await control.getAttribute("open")) === null) await control.locator("summary").click();
  await page.getByLabel("演示场景").selectOption(name);
}
async function expand(page: Page) {
  const button = page.getByRole("button", { name: "继续查看日程 ↓" });
  if (await button.count()) await button.click();
}

test("U01 游客看到时间、动作与游戏，不创建用户；首屏包含日程", async ({ page, context }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiCalls.push(request.url());
  });
  await page.goto("/");
  const row = page.locator('[data-node="morning"]');
  await expect(row).toContainText("08:00");
  await expect(row).toContainText("2026-09-22");
  await expect(row).toContainText("活动开始");
  await expect(row).toContainText("原神");
  await expect(page.locator(".sample-notice")).toContainText("synthetic");
  expect(apiCalls).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  const box = await row.boundingBox();
  expect(box?.y).toBeLessThan(page.viewportSize()?.height ?? 0);
});

test("U03 八种时间状态、长标题、日期与未知混排不伪造时刻", async ({ page }) => {
  await page.goto("/");
  await expand(page);
  const date = page.locator('[data-node="date"]');
  await expect(date).toContainText("2026-09-23 · 具体时间未公布");
  await expect(date.locator("time")).toHaveCount(0);
  await expect(page.locator('.date-only [data-node="date"]')).toHaveCount(1);
  await expect(page.locator('.timed-list [data-node="date"]')).toHaveCount(0);
  await expect(page.locator('[data-region="pending"] [data-node="pending"]')).toContainText(
    "已延期，新时间待公布",
  );
  await expect(page.locator('[data-node="pending"] time')).toHaveCount(0);
  await expect(page.locator('[data-node="estimate"] .node-time')).toContainText("预计");
  await expect(page.locator('[data-node="estimate"]')).toContainText("官方预计");
  await expect(page.locator('[data-node="derived"]')).toContainText("确定性推导");
  await expect(page.locator('[data-node="morning"]')).toContainText("已到计划开始时间");
  await page.locator(".recent-changes summary").click();
  await expect(page.locator('[data-change="cancel"]')).toContainText("官方已取消");
  await expect(page.locator('[data-change="retract"]')).toContainText("本站撤回：此前收录有误");
  await expect(page.locator('[data-change="retract"]')).not.toContainText("官方已取消");
  await expect(page.locator('[data-change="rescheduled"]')).toContainText("历史");
  const long = page.locator('[data-node="long"]');
  await expect(long).toContainText("特别限时活动与挑战任务");
  for (const selector of [".node-time", ".node-action", ".event-title"]) {
    const style = await long.locator(selector).evaluate((element) => ({
      overflow: getComputedStyle(element).overflow,
      ellipsis: getComputedStyle(element).textOverflow,
      scroll: element.scrollWidth,
      width: element.clientWidth,
    }));
    expect(style.overflow).not.toBe("hidden");
    expect(style.ellipsis).not.toBe("ellipsis");
    expect(style.scroll).toBeLessThanOrEqual(style.width + 1);
  }
  await expect(page.locator(".timeline")).not.toContainText("实际进行中");
});

test("U05 四种空态分别表达；平静期有近7天出口，候选只给聚合信息", async ({ page }) => {
  await page.goto("/");
  await page.locator("#more-filters summary").click();
  await page.getByRole("checkbox", { name: "实际结束", exact: true }).check();
  await expect(page.locator('[data-empty="filtered"]')).toContainText("筛选没有匹配项");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await scenario(page, "source");
  await expect(page.locator('[data-empty="source"]')).toContainText("来源暂不可用");
  await expect(page.locator('[data-empty="range"]')).toHaveCount(0);
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.locator("#browse-announcement")).toContainText("样例来源状态未改变");
  await scenario(page, "review");
  await expect(page.locator('[data-empty="review"]')).toContainText("仍有待审核缺口");
  await expect(page.locator(".data-warning")).toContainText("2 项待核对");
  await expect(page.locator('[data-region="days"] .schedule-node')).toHaveCount(0);
  await scenario(page, "quiet");
  await expect(page.locator('[data-empty="range"]')).toContainText("当前范围没有已发布日程");
  await page.getByRole("button", { name: "试试近7天" }).click();
  await expect(page.locator('[data-node="later"]')).toBeVisible();
  await expect(page.getByRole("radio", { name: "近7天", exact: true })).toBeChecked();
});

test("U06 改浏览筛选不改写云配置、草稿或接收方式；URL只含白名单", async ({ page }) => {
  const cloud = { revision: 7, scope: ["genshin"], synthetic: true };
  const mutations: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") mutations.push(route.request().url());
    await route.fulfill({ json: cloud });
  });
  await page.addInitScript(() => {
    localStorage.setItem("synthetic-saved-subscription", '{"revision":7}');
    localStorage.setItem("synthetic-draft", '{"games":["genshin"]}');
  });
  await page.goto("/?account=synthetic&draft=synthetic&feed=synthetic#secret");
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.locator(".game-option").filter({ hasText: "原神" }).click();
  await page.getByRole("radio", { name: "未来90天" }).check();
  await page.getByRole("checkbox", { name: "临近截止" }).check();
  await page.locator("#more-filters summary").click();
  await page.getByRole("checkbox", { name: "限时活动", exact: true }).check();
  await page.locator("#more-filters summary").click();
  await expect(page.locator("#more-summary")).toContainText("限时活动");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  expect(mutations).toEqual([]);
  expect(cloud.revision).toBe(7);
  const url = new URL(page.url());
  expect([...url.searchParams.keys()].sort()).toEqual(["ending", "events", "games", "range"]);
  expect(url.hash).toBe("");
  await page.getByRole("button", { name: "清除筛选" }).click();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
});

test("U03 六档切换保留今日节点，昨天常驻末尾并采用已验证半透明组合", async ({ page }) => {
  await page.goto("/");
  for (const label of ["今天", "近3天", "近7天", "近30天", "未来90天", "全部"]) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await expect(page.locator('[data-node="morning"]')).toBeVisible();
    await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toHaveCount(1);
  }
  expect(await page.locator(".timeline > section:last-child").getAttribute("data-region")).toBe(
    "yesterday",
  );
  const alpha = await page.locator(".yesterday-band").evaluate((element) => ({
    actual: getComputedStyle(element, "::before").opacity,
    token: getComputedStyle(element).getPropertyValue("--alpha-band-tint").trim(),
    textOpacity: getComputedStyle(element).opacity,
  }));
  expect(Number(alpha.actual)).toBe(Number(alpha.token));
  expect(alpha.textOpacity).toBe("1");
});

test("U05 三种新鲜度字段分开、陈旧缓存与离线明确标记", async ({ page, context }) => {
  await page.goto("/");
  await page.locator(".data-freshness summary").click();
  await expect(page.locator(".data-freshness")).toContainText("2026-09-21 18:00");
  await expect(page.locator(".data-freshness")).toContainText("2026-09-21 19:00");
  await page.locator(".recent-changes summary").click();
  await expect(page.locator('[data-change="cancel"]')).toContainText("2026-09-21 10:00");
  await scenario(page, "stale");
  await expect(page.locator(".data-warning")).toContainText("陈旧缓存");
  await expect(page.locator(".data-warning")).toContainText("2026-09-21 20:00");
  await context.setOffline(true);
  await expect(page.locator(".data-warning")).toContainText("离线");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await context.setOffline(false);
});

test("U05 加载失败保留条目并可重试，不假称全部加载完成", async ({ page }) => {
  await page.goto("/");
  await scenario(page, "load");
  const before = await page
    .locator('[data-region="days"] [data-node]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-node")));
  await page.getByRole("button", { name: "继续查看日程 ↓" }).click();
  await expect(page.locator(".load-row")).toContainText("加载失败");
  await expect(page.locator(".load-row")).not.toContainText("已显示完");
  expect(
    await page
      .locator('[data-region="days"] [data-node]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-node"))),
  ).toEqual(before);
  await page.getByRole("button", { name: "重试加载" }).click();
  await expect(page.locator(".load-row")).toContainText("已显示完当前范围");
  await expect(page.locator('[data-node="derived"]')).toBeVisible();
});

test("U06 返回列表恢复筛选、已展开日程与合理滚动位置", async ({ page }) => {
  await page.goto("/?range=7d");
  await expand(page);
  const link = page.locator('[data-node="later"] .event-title');
  await link.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await link.click();
  await expect(page).toHaveURL(/\/events\/sample/);
  await page.goBack();
  await expect(page.getByRole("radio", { name: "近7天", exact: true })).toBeChecked();
  await expect(page.locator('[data-node="later"]')).toBeVisible();
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => scrollY)) - before))
    .toBeLessThan(150);
});

test("U03 U05 E2 桌面与手机实际截图、窄屏不裁剪关键内容", async ({ page }, info) => {
  await page.goto("/");
  const folder = resolve("tests/e2e/evidence/f1-02");
  mkdirSync(folder, { recursive: true });
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  await page.screenshot({ path: `${folder}/${viewport}-home.png`, fullPage: true });
  await expand(page);
  if (viewport === "mobile") {
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-node="long"] .node-action')).toBeVisible();
    await page.setViewportSize({ width: 393, height: 727 });
  }
  await scenario(page, "quiet");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${folder}/${viewport}-empty.png`, fullPage: true });
});

test("U05 筛选改变后丢弃旧加载结果，空态出口保留键盘焦点", async ({ page }) => {
  await page.goto("/");
  await scenario(page, "load");
  // 同一事件轮次发起加载后切换范围，确保旧异步任务仍在途。
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-action="load"]')?.click();
    const today = document.querySelector<HTMLInputElement>('input[name="range"][value="today"]');
    if (!today) throw new Error("today control missing");
    today.checked = true;
    today.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".load-row")).toContainText("已显示完当前范围");
  await expect(page.locator('[data-node="derived"]')).toHaveCount(0);
  await scenario(page, "quiet");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "试试近7天" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "近7天", exact: true })).toBeFocused();
});
