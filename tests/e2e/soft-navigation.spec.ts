// ADR-0032 按需刷新与局部更新：站内切换复用本标签页的公开副本，超过核对间隔才用条件请求核对；
// 切换筛选只重读日程、旧列表保留到新的一档读完；页头账号入口不每页闪「登录」。
import { expect, type Page, test } from "@playwright/test";
import { CLIENT_RECHECK_INTERVAL } from "../../packages/contracts/src/index";
import { catalogFixture, clock, eventsFixture, mockPublicApi } from "./fixtures/public-schedule";

async function complete(page: Page) {
  await expect(page.locator(".load-row")).toContainText("已显示完");
}

const apiPaths = (calls: { path: string }[]) => calls.map((call) => call.path).sort();

test("ADR-0032 站内切换回日程页直接显示本标签页的副本，核对间隔内不再请求公开接口", async ({
  page,
}) => {
  const control = await mockPublicApi(page);
  await page.goto("/");
  await complete(page);
  expect(apiPaths(control.calls)).toEqual([
    "/api/v2/catalog",
    "/api/v2/events",
    "/api/v2/redeem-codes",
    "/api/v2/status",
  ]);
  // 第一次读到的条目播放入场动效。
  expect(await page.locator("#schedule-results .is-entering").count()).toBeGreaterThan(0);
  control.calls.length = 0;

  await page.locator('[data-node="morning"] .event-title').click();
  await expect(page).toHaveURL(/\/events\/evt_morning$/);
  await expect(page.locator("#event-detail .detail-footer")).toBeVisible();
  await expect.poll(() => apiPaths(control.calls)).toEqual(["/api/v2/events/evt_morning"]);
  control.calls.length = 0;

  // 再进日程页（新的导航，不是后退缓存）：不出骨架，不发公开读取。
  await page.goto("/");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await expect(page.locator("#schedule-results .timeline-skeleton")).toHaveCount(0);
  await complete(page);
  // 取自副本的列表原地出现，不再播放入场动效。
  await expect(page.locator("#schedule-results .is-entering")).toHaveCount(0);
  // 同一活动的详情也直接复用。
  await page.goto("/events/evt_morning");
  await expect(page.locator("#event-detail .detail-footer")).toBeVisible();
  await page.goto("/help");
  await page.goto("/");
  await complete(page);
  expect(control.calls).toEqual([]);

  // 页头参与跨文档视图过渡（同源切换时原地不动，正文交叉淡入）。
  expect(
    await page.locator(".app-header").evaluate((e) => getComputedStyle(e).viewTransitionName),
  ).toBe("app-header");
});

test("ADR-0032 副本超过核对间隔：先照常显示，再带 If-None-Match 核对；304 不重新下载、不重绘成骨架", async ({
  page,
}) => {
  const control = await mockPublicApi(page);
  const conditional: { path: string; ifNoneMatch: string | null; status: number }[] = [];
  // 后注册的路由先匹配：日程与目录按内容给 ETag，带回一致的 If-None-Match 时回 304。
  for (const pattern of ["**/api/v2/events?**", "**/api/v2/catalog"])
    await page.route(pattern, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      control.calls.push({ path: url.pathname, method: request.method() });
      const etag = `W/"${url.pathname === "/api/v2/catalog" ? "catalog" : url.searchParams.toString()}-v7"`;
      const ifNoneMatch = request.headers()["if-none-match"] ?? null;
      const status = ifNoneMatch === etag ? 304 : 200;
      conditional.push({ path: url.pathname, ifNoneMatch, status });
      if (status === 304) return route.fulfill({ status, headers: { etag } });
      const body =
        url.pathname === "/api/v2/catalog" ? catalogFixture() : eventsFixture(url.searchParams);
      return route.fulfill({ json: body, headers: { etag } });
    });
  await page.goto("/");
  await complete(page);
  expect(conditional.every((item) => item.ifNoneMatch === null && item.status === 200)).toBe(true);
  control.calls.length = 0;
  conditional.length = 0;

  await page.clock.setFixedTime(new Date(clock.getTime() + CLIENT_RECHECK_INTERVAL * 1000 + 1));
  await page.goto("/help");
  await page.goto("/");
  // 副本先显示，不等核对。
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await expect(page.locator("#schedule-results .timeline-skeleton")).toHaveCount(0);
  await expect.poll(() => conditional.length).toBe(2);
  await complete(page);
  expect(conditional.map((item) => [item.path, item.status]).sort()).toEqual([
    ["/api/v2/catalog", 304],
    ["/api/v2/events", 304],
  ]);
  expect(conditional.every((item) => item.ifNoneMatch?.startsWith('W/"'))).toBe(true);
  // 日程只核对首页；状态与兑换码没有 ETag 时照常整份读取。
  expect(apiPaths(control.calls)).toEqual([
    "/api/v2/catalog",
    "/api/v2/events",
    "/api/v2/redeem-codes",
    "/api/v2/status",
  ]);
});

test("ADR-0032 切换筛选只重读日程，旧列表淡化保留到新的一档读完，不退回骨架；切回读过的筛选不再请求", async ({
  page,
}) => {
  const control = await mockPublicApi(page);
  await page.goto("/");
  await complete(page);
  control.calls.length = 0;

  let release: (() => void) | undefined;
  await page.route("**/api/v2/events?**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    control.calls.push({ path: url.pathname, method: request.method() });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: eventsFixture(url.searchParams) }).catch(() => {});
  });
  const results = page.locator("#schedule-results");
  await page.locator('.game-option[data-game="zzz"]').click();
  await expect(results).toHaveAttribute("data-switching", "");
  await expect(results).toHaveAttribute("aria-busy", "true");
  await expect(results.locator(".timeline-skeleton")).toHaveCount(0);
  await expect(results.locator("[data-node]").first()).toBeVisible();
  expect(
    await results
      .locator('[data-region="days"]')
      .evaluate((e) => Number(getComputedStyle(e).opacity)),
  ).toBeLessThan(1);
  await expect.poll(() => release !== undefined).toBe(true);
  release?.();
  await complete(page);
  await expect(results).not.toHaveAttribute("data-switching");
  await expect(results.locator('[data-node] [data-game="zzz"]')).toHaveCount(0);
  // 目录、状态、兑换码与筛选无关，不重读。
  expect(apiPaths(control.calls)).toEqual(["/api/v2/events"]);
  control.calls.length = 0;

  // 切回刚才读过的筛选：直接换上副本。
  await page.locator('.game-option[data-game="zzz"]').click();
  await complete(page);
  await expect(results).not.toHaveAttribute("data-switching");
  expect(control.calls).toEqual([]);
});

test("ADR-0032 切换筛选读取失败：旧列表不冒充新筛选的结果", async ({ page }) => {
  const control = await mockPublicApi(page);
  await page.goto("/");
  await complete(page);
  await page.route("**/api/v2/events?**", (route) => route.fulfill({ status: 503, json: {} }));
  control.calls.length = 0;
  await page.locator('.game-option[data-game="zzz"]').click();
  await expect(page.locator("#schedule-results")).toContainText("暂时无法加载日程");
  await expect(page.locator("#schedule-results [data-node]")).toHaveCount(0);
  await expect(page.locator("#schedule-results")).not.toHaveAttribute("data-switching");
});

test("ADR-0032 页头：服务端确认过后站内切换直接显示「账号」，核对间隔内不重复读取；失效后回到「登录」", async ({
  page,
  context,
}) => {
  await mockPublicApi(page);
  let meReads = 0;
  let signedIn = true;
  await page.route("**/api/v2/me", (route) => {
    meReads += 1;
    return signedIn
      ? route.fulfill({ json: { user_id: "synthetic-header-user" } })
      : route.fulfill({ status: 401, json: {} });
  });
  await context.addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-header-csrf",
      url: "https://127.0.0.1",
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const entry = page.locator("[data-account-entry]");
  await page.goto("/help");
  await expect(entry).toHaveText("账号");
  expect(meReads).toBe(1);
  await page.goto("/status");
  await expect(entry).toHaveText("账号");
  await page.goto("/help");
  await expect(entry).toHaveText("账号");
  expect(meReads).toBe(1);
  // 提示里只有确认时间，没有账号标识。
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => !key.startsWith("hoyo:public:"))
        .map((key) => [key, sessionStorage.getItem(key)]),
    ),
  ).toEqual([["hoyo:account-hint:v1", String(clock.getTime())]]);

  // 过了核对间隔：先照提示显示，后台核对得到 401 后回到「登录」并清掉提示。
  signedIn = false;
  await page.clock.setFixedTime(new Date(clock.getTime() + CLIENT_RECHECK_INTERVAL * 1000 + 1));
  await page.goto("/help");
  await expect(entry).toHaveText("登录");
  expect(meReads).toBe(2);
  expect(await page.evaluate(() => sessionStorage.getItem("hoyo:account-hint:v1"))).toBeNull();
  await page.goto("/status");
  await expect(entry).toHaveText("登录");
  expect(meReads).toBe(3);
});
