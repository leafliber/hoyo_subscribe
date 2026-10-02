import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { clock, eventsFixture, mockPublicApi, statusFixture } from "./fixtures/public-schedule";

const controls = new WeakMap<Page, Awaited<ReturnType<typeof mockPublicApi>>>();
test.beforeEach(async ({ page }) => {
  controls.set(page, await mockPublicApi(page));
});
async function complete(page: Page) {
  await expect(page.locator(".load-row")).toContainText("已显示完当前范围");
}
async function scenario(page: Page, value: "normal" | "quiet" | "source" | "review" | "stale") {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.scenario = value;
  await page.reload();
  await complete(page);
}

test("U01 游客读取公共 API，首屏显示时间动作与游戏，不创建用户", async ({ page, context }) => {
  await page.goto("/");
  await complete(page);
  const row = page.locator('[data-node="morning"]');
  await expect(row).toContainText("08:00");
  await expect(row).toContainText("2026-09-22");
  await expect(row).toContainText("活动开始");
  await expect(row).toContainText("原神");
  await expect(page.locator(".sample-notice, .demo-controls")).toHaveCount(0);
  expect(
    controls
      .get(page)
      ?.calls.map((call) => call.path)
      .sort(),
  ).toEqual(["/api/v2/catalog", "/api/v2/events", "/api/v2/status"]);
  expect(controls.get(page)?.calls.every((call) => call.method === "GET")).toBe(true);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect((await row.boundingBox())?.y).toBeLessThan(page.viewportSize()?.height ?? 0);
});

test("U03 八种时间状态、长标题、日期与未知混排不伪造时刻", async ({ page }) => {
  await page.goto("/");
  await complete(page);
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

test("U05 四种空态分开；昨天不计入范围条数；近7天出口可用", async ({ page }) => {
  await page.goto("/");
  await complete(page);
  await page.locator("#more-filters summary").click();
  await page.getByRole("checkbox", { name: "实际结束", exact: true }).check();
  await expect(page.locator('[data-empty="filtered"]')).toContainText("筛选没有匹配项");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await scenario(page, "source");
  await expect(page.locator('[data-empty="source"]')).toContainText("来源暂不可用");
  await expect(page.locator('[data-empty="range"]')).toHaveCount(0);
  await scenario(page, "review");
  await expect(page.locator('[data-empty="review"]')).toContainText("仍有待审核缺口");
  await expect(page.locator(".data-warning")).toContainText("2 项待核对");
  await scenario(page, "quiet");
  await expect(page.locator('[data-empty="range"]')).toContainText("当前范围没有已发布日程");
  await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toHaveCount(1);
  await expect(page.locator(".timeline-heading")).toContainText("0 项");
  await page.getByRole("button", { name: "试试近7天" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "近7天", exact: true })).toBeFocused();
  await expect(page.locator('[data-node="later"]')).toBeVisible();
});

test("U05 来源逐行、维护原因优先；来源聚合与审核计数未知不能当0", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.status = () => {
    const data = statusFixture();
    data.sources?.push(
      {
        sourceId: "list-only",
        game: "genshin",
        verifiedAt: clock.getTime(),
        verificationState: "verified",
        degradationReasons: ["content_unavailable"],
      },
      {
        sourceId: "maintenance-unknown",
        game: "genshin",
        verifiedAt: null,
        verificationState: "unknown",
        degradationReasons: ["maintenance_required"],
      },
      {
        sourceId: "maintenance-unavailable",
        game: "genshin",
        verifiedAt: clock.getTime(),
        verificationState: "unavailable",
        degradationReasons: ["maintenance_required"],
      },
    );
    return data;
  };
  await page.goto("/");
  await complete(page);
  await page.locator(".data-freshness summary").click();
  await expect(page.locator('[data-source="synthetic-genshin"]')).toContainText("已核验");
  await expect(page.locator('[data-source="list-only"]')).toContainText("仅列表可用");
  for (const id of ["maintenance-unknown", "maintenance-unavailable"])
    await expect(page.locator(`[data-source="${id}"]`)).toContainText("维护中，暂不可用");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  control.scenario = "quiet";
  control.status = () => ({
    ...statusFixture(),
    sources: null,
    reviewGaps: [{ game: "genshin", count: null }],
  });
  await page.reload();
  await complete(page);
  await expect(page.locator('[data-empty="range"]')).toHaveCount(0);
  await expect(page.locator('[data-empty="review"]')).toContainText("数量未知");
  await page.locator(".data-freshness summary").click();
  await expect(page.locator(".data-freshness")).toContainText("来源状态未知");
});

test("U06 浏览筛选不改云配置；URL只含白名单，低频筛选在本地立即生效", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("synthetic-draft", '{"games":["genshin"]}');
  });
  await page.goto("/?account=synthetic&draft=synthetic&feed=synthetic#secret");
  await complete(page);
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.locator(".game-option").filter({ hasText: "原神" }).click();
  await page.getByRole("radio", { name: "未来90天" }).check();
  await complete(page);
  const count = controls.get(page)?.calls.length;
  await page.getByRole("checkbox", { name: "临近截止" }).check();
  await page.locator("#more-filters summary").click();
  await page.getByRole("checkbox", { name: "限时活动", exact: true }).check();
  await page.locator("#more-filters summary").click();
  await expect(page.locator("#more-summary")).toContainText("限时活动");
  expect(controls.get(page)?.calls.length).toBe(count);
  expect(controls.get(page)?.calls.every((call) => call.method === "GET")).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  const url = new URL(page.url());
  expect([...url.searchParams.keys()].sort()).toEqual(["ending", "events", "games", "range"]);
  expect(url.hash).toBe("");
});

test("U03 六档昨天带常驻末尾；按响应 window 切分，不按浏览器日期", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-25T12:00:00+08:00"));
  await page.goto("/");
  for (const label of ["今天", "近3天", "近7天", "近30天", "未来90天", "全部"]) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await complete(page);
    await expect(page.locator('[data-node="morning"]')).toBeVisible();
    await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toHaveCount(1);
    await expect(page.locator('[data-region="yesterday"]')).toContainText("2026-09-21");
  }
  expect(await page.locator(".timeline > section:last-child").getAttribute("data-region")).toBe(
    "yesterday",
  );
  const alpha = await page.locator(".yesterday-band").evaluate((element) => ({
    actual: getComputedStyle(element, "::before").opacity,
    token: getComputedStyle(element).getPropertyValue("--alpha-band-tint").trim(),
    text: getComputedStyle(element).opacity,
  }));
  expect(Number(alpha.actual)).toBe(Number(alpha.token));
  expect(alpha.text).toBe("1");
});

test("U05 缓存新鲜度不以旧代次替代；离线显示当前页面已读取副本的实际时间", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await complete(page);
  await expect(page.locator(".data-warning")).toHaveCount(0);
  await page.locator(".data-freshness summary").click();
  await expect(page.locator(".data-freshness")).toContainText("2026-09-21 18:00");
  await expect(page.locator(".data-freshness")).toContainText("2026-09-21 19:00");
  await scenario(page, "stale");
  await expect(page.locator(".data-warning")).toContainText("陈旧缓存");
  await expect(page.locator(".data-warning")).toContainText("2026-09-21 20:00");
  await context.setOffline(true);
  await expect(page.locator(".data-warning").first()).toContainText("离线");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await context.setOffline(false);
});

test("U05 空页有游标继续加载，续页近期变更忽略且失败后保留条目", async ({ page }) => {
  let failed = false;
  const cursors: (string | null)[] = [];
  await page.route("**/api/v2/events?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const cursor = params.get("cursor");
    cursors.push(cursor);
    const data = eventsFixture(params);
    if (!cursor) return route.fulfill({ json: { ...data, nodes: [], nextCursor: "first" } });
    if (cursor === "first")
      return route.fulfill({
        json: {
          ...data,
          nodes: data.nodes.filter((n) => n.id === "morning"),
          recentChanges: [],
          nextCursor: "last",
        },
      });
    if (!failed) {
      failed = true;
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fulfill({
      json: {
        ...data,
        nodes: data.nodes.filter((n) => n.id !== "morning"),
        recentChanges: [{ ...data.nodes[0], id: "must-ignore" }],
        nextCursor: null,
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".load-row")).toContainText("加载失败");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await expect(page.locator("[data-empty]")).toHaveCount(0);
  await expect(page.locator(".load-row")).not.toContainText("已显示完");
  await page.getByRole("button", { name: "重试加载" }).click();
  await complete(page);
  expect(cursors).toEqual([null, "first", "last", "last"]);
  await expect(page.locator('[data-node="morning"]')).toHaveCount(1);
  await expect(page.locator('[data-change="cancel"]')).toHaveCount(1);
  await expect(page.locator('[data-change="must-ignore"]')).toHaveCount(0);
});

test("U05 409 立即清空旧代再重载，绝不跨代拼接", async ({ page }) => {
  let restarted = false;
  let resume: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await page.route("**/api/v2/events?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const data = eventsFixture(params);
    if (params.has("cursor")) {
      restarted = true;
      return route.fulfill({ status: 409, json: {} });
    }
    if (!restarted)
      return route.fulfill({
        json: { ...data, nodes: [{ ...data.nodes[0], id: "old-generation" }], nextCursor: "next" },
      });
    await barrier;
    return route.fulfill({
      json: {
        ...data,
        publication: { ...data.publication, generation: 8 },
        nodes: [{ ...data.nodes[0], id: "new-generation" }],
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => restarted).toBe(true);
  await expect(page.locator('[data-node="old-generation"]')).toHaveCount(0);
  await expect(page.locator(".load-row")).not.toContainText("已显示完");
  resume?.();
  await complete(page);
  await expect(page.locator('[data-node="new-generation"]')).toBeVisible();
  await expect(page.locator('[data-node="old-generation"]')).toHaveCount(0);
});

test("U05 旧筛选在途响应不会覆盖新筛选；首次失败不假空", async ({ page }) => {
  let release: (() => void) | undefined;
  let started = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v2/events?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("range") === "3d") {
      started = true;
      await barrier;
    }
    await route.fulfill({ json: eventsFixture(params) }).catch(() => {});
  });
  await page.goto("/");
  await expect.poll(() => started).toBe(true);
  await page.getByRole("radio", { name: "今天", exact: true }).check();
  await complete(page);
  release?.();
  await expect(page.locator('[data-node="date"]')).toHaveCount(0);
  await page.route("**/api/v2/events?**", (route) => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.locator(".load-row")).toContainText("加载失败");
  await expect(page.locator("[data-empty]")).toHaveCount(0);
});

test("U06 返回列表恢复筛选；U03 U05 桌面手机截图与窄屏关键内容", async ({ page }, info) => {
  await page.goto("/?range=7d");
  await complete(page);
  await page.locator('[data-node="later"] .event-title').click();
  await expect(page).toHaveURL(/\/events\/evt_later/);
  await page.goBack();
  await complete(page);
  await expect(page.getByRole("radio", { name: "近7天", exact: true })).toBeChecked();
  await expect(page.locator('[data-node="later"]')).toBeVisible();
  if (info.project.name.startsWith("mobile")) {
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
  const folder = resolve(
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f1-06"
      : "tests/e2e/test-results/f1-06",
  );
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/${info.project.name}-schedule.png`, fullPage: true });
});

test("U05 服务端等待信息约束重试与刷新入口，不因重复点击连续请求", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/v2/events?**", async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 429,
        json: {
          error: {
            code: "rate_limited",
            message: "synthetic wait",
            details: { code: "rate_limited", retry_after_ms: 1234 },
          },
        },
      });
    return route.fulfill({ json: eventsFixture(new URL(route.request().url()).searchParams) });
  });
  await page.goto("/");
  await expect(page.locator(".load-row")).toContainText("至少等待 2 秒");
  await expect(page.getByRole("button", { name: "重试加载" })).toBeDisabled();
  await page.locator(".data-freshness summary").click();
  await expect(page.getByRole("button", { name: "重新检查" })).toBeDisabled();
  await page.getByRole("radio", { name: "今天", exact: true }).check();
  expect(calls).toBe(1);
  await page.clock.setFixedTime(new Date(clock.getTime() + 1235));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("button", { name: "重试加载" }).click();
  await complete(page);
  expect(calls).toBe(2);
});

test("U04 首页公开证据也是文本；近期变更截断不宣称完整历史", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.events = (params) => {
    const data = eventsFixture(params);
    data.nodes[0].evidence = '<img src=x onerror="window.__evidenceExecuted=1">';
    data.recentChangesTruncated = true;
    return data;
  };
  await page.addInitScript(() => {
    (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted = 0;
  });
  await page.goto("/");
  await complete(page);
  await expect(page.locator('[data-node="morning"] .evidence-text')).toContainText("<img src=x");
  await expect(page.locator(".node-evidence img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted,
    ),
  ).toBe(0);
  await page.locator(".recent-changes summary").click();
  await expect(page.locator(".recent-changes")).toContainText("不是完整变更历史");
});

test("U18 公开离线提示使用 API 副本时间，没有已注册的 Service Worker", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await complete(page);
  await context.setOffline(true);
  const warning = page.locator("#schedule-results > div > .data-warning");
  await expect(warning).toContainText("离线");
  await expect(warning).toContainText("实际缓存时间 2026-09-22 12:30 · UTC+8");
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
});

test("U05 首次读取失败且没有副本时，不声称离线可读", async ({ page, context }) => {
  await page.route("**/api/v2/**", (route) => route.abort("internetdisconnected"));
  for (const path of ["/", "/events/evt_morning"]) {
    await context.setOffline(false);
    await page.goto(path);
    const root = page.locator(path === "/" ? "#schedule-results" : "#event-detail");
    await expect(root).toContainText("尚无可展示的公共副本");
    await context.setOffline(true);
    await expect(root).not.toContainText("实际缓存时间");
    await expect(root).not.toContainText("副本仍保留");
    await expect(root.locator("[data-node], .event-detail, [data-empty]")).toHaveCount(0);
  }
});
