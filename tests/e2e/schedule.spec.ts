import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  browseDate,
  compareScheduleNodes,
  DateOnlySchema,
  ExactTimeSchema,
} from "../../packages/contracts/src/index";
import {
  clock,
  eventsFixture,
  mockPublicApi,
  redeemCodesFixture,
  statusFixture,
} from "./fixtures/public-schedule";

const controls = new WeakMap<Page, Awaited<ReturnType<typeof mockPublicApi>>>();
test.beforeEach(async ({ page }) => {
  controls.set(page, await mockPublicApi(page));
});
async function complete(page: Page) {
  await expect(page.locator(".load-row")).toContainText("已显示完");
}
/** 时间范围在「筛选」弹层里（ADR-0017）：打开、选档、关闭。 */
async function chooseRange(page: Page, label: string) {
  await page.locator("#more-filters-toggle").click();
  await page.getByRole("radio", { name: label, exact: true }).check();
  await page.keyboard.press("Escape");
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
  // 日期由所在日期分组标题给出（北京日期 2026-09-22 = 今天 9月22日）。
  const day = page.locator('section.schedule-day[data-date="2026-09-22"]');
  await expect(day.locator('[data-node="morning"]')).toHaveCount(1);
  await expect(day.locator(".day-heading")).toContainText("9月22日");
  await expect(row).toContainText("活动开始");
  await expect(row).toContainText("原神");
  await expect(page.locator(".sample-notice, .demo-controls")).toHaveCount(0);
  expect(
    controls
      .get(page)
      ?.calls.map((call) => call.path)
      .sort(),
  ).toEqual(["/api/v2/catalog", "/api/v2/events", "/api/v2/redeem-codes", "/api/v2/status"]);
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
    "新时间待公布",
  );
  await expect(page.locator('[data-node="pending"] time')).toHaveCount(0);
  await expect(page.locator('[data-node="estimate"] .node-time')).toContainText("预计");
  await expect(page.locator('[data-node="estimate"]')).toContainText("官方预计");
  await expect(page.locator('[data-node="derived"]')).toContainText("按公告推算");
  await expect(page.locator('[data-node="morning"]')).toContainText("已到开始时间");
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
  await page.locator("#more-filters-toggle").click();
  await page.getByRole("checkbox", { name: "实际结束", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-empty="filtered"]')).toContainText("筛选没有匹配项");
  await page.locator('[data-empty="filtered"]').getByRole("button", { name: "清除筛选" }).click();
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
  // 时间范围在「筛选」里（ADR-0017）：焦点落到写着当前档位的按钮上。
  await expect(page.locator("#more-filters-toggle")).toBeFocused();
  await expect(page.locator("#more-filters-toggle")).toContainText("近7天");
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
        kind: "announcement",
        verifiedAt: clock.getTime(),
        verificationState: "verified",
        degradationReasons: ["content_unavailable"],
      },
      {
        sourceId: "maintenance-unknown",
        game: "genshin",
        kind: "announcement",
        verifiedAt: null,
        verificationState: "unknown",
        degradationReasons: ["maintenance_required"],
      },
      {
        sourceId: "maintenance-unavailable",
        game: "genshin",
        kind: "announcement",
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
  await chooseRange(page, "近30天");
  await complete(page);
  const count = controls.get(page)?.calls.length;
  await page.getByRole("checkbox", { name: "只看截止" }).check();
  await page.locator("#more-filters-toggle").click();
  await page.getByRole("checkbox", { name: "限时活动", exact: true }).check();
  await page.locator("#more-filters-toggle").click();
  await expect(page.locator("#more-filters")).toBeHidden();
  // 关闭弹层后以计数徽标与 title 显示已选的低频筛选。
  await expect(page.locator("#more-summary")).toHaveText("1");
  await expect(page.locator("#more-summary")).toHaveAttribute("title", /限时活动/);
  expect(controls.get(page)?.calls.length).toBe(count);
  expect(controls.get(page)?.calls.every((call) => call.method === "GET")).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  const url = new URL(page.url());
  expect([...url.searchParams.keys()].sort()).toEqual(["ending", "events", "games", "range"]);
  expect(url.hash).toBe("");
});

test("U03 五档昨天带常驻顶部（从上到下按时间先后）；按响应 window 切分，不按浏览器日期", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-25T12:00:00+08:00"));
  await page.goto("/");
  // 「未来90天」与「全部」重叠，首页不再单独提供。
  await expect(page.getByRole("radio", { name: "未来90天", includeHidden: true })).toHaveCount(0);
  for (const label of ["今天", "近3天", "近7天", "近30天", "全部"]) {
    await chooseRange(page, label);
    await complete(page);
    await expect(page.locator('[data-node="morning"]')).toBeVisible();
    await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toHaveCount(1);
    await expect(page.locator('[data-region="yesterday"]')).toContainText("9月21日");
  }
  // ADR-0017 / F1-09：时间轴里昨天 → 当前范围逐日 → 末行；时间待定是时间轴下方单独的卡片。
  expect(
    await page
      .locator(".timeline > *")
      .evaluateAll((items) =>
        items
          .map((item) =>
            item instanceof HTMLElement
              ? (item.dataset.region ?? (item.classList.contains("load-row") ? "end" : ""))
              : "",
          )
          .filter(Boolean),
      ),
  ).toEqual(["yesterday", "days", "end"]);
  await expect(page.locator('.timeline.card + [data-region="pending"].card')).toHaveCount(1);
  // 昨天带默认折叠，展开后条目可见；文字不做半透明降权。
  await page.locator(".yesterday-band > summary").click();
  await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toBeVisible();
  expect(await page.locator(".yesterday-band").evaluate((e) => getComputedStyle(e).opacity)).toBe(
    "1",
  );
});

test("U05 缓存新鲜度不以旧代次替代；离线显示当前页面已读取副本的实际时间", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await complete(page);
  await expect(page.locator(".data-warning")).toHaveCount(0);
  await page.locator(".data-freshness summary").click();
  await expect(page.locator(".data-freshness")).toContainText("2026年9月21日 18:00");
  await expect(page.locator(".data-freshness")).toContainText("2026年9月21日 19:00");
  await scenario(page, "stale");
  await expect(page.locator(".data-warning")).toContainText("内容可能已过时");
  await expect(page.locator(".data-warning")).toContainText("2026年9月21日 20:00");
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
  await expect(page.locator(".load-row", { hasText: "已显示完" })).toHaveCount(0);
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
  await expect(page.locator(".load-row", { hasText: "已显示完" })).toHaveCount(0);
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
  await chooseRange(page, "今天");
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
  await expect(
    page.getByRole("radio", { name: "近7天", exact: true, includeHidden: true }),
  ).toBeChecked();
  await expect(page.locator("#more-range")).toHaveText("近7天");
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
  await chooseRange(page, "今天");
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
  const malicious = '<img src=x onerror="window.__evidenceExecuted=1">';
  control.events = (params) => {
    const data = eventsFixture(params);
    // 列表行不再展开证据；首页上的公开依据出现在近期变更里，同样只能作为文本。
    data.recentChanges = data.recentChanges.map((node) =>
      node.change ? { ...node, change: { ...node.change, evidence: malicious } } : node,
    );
    data.recentChangesTruncated = true;
    return data;
  };
  await page.addInitScript(() => {
    (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted = 0;
  });
  await page.goto("/");
  await complete(page);
  await page.locator(".recent-changes summary").click();
  await expect(page.locator(".recent-changes .evidence-text").first()).toContainText("<img src=x");
  // 游戏标识是官方图标图片（ADR-0015）；证据里的 <img> 只能是文字。
  await expect(
    page.locator(
      ".recent-changes img:not(.game-icon > img), .schedule-results img:not(.game-icon > img)",
    ),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted,
    ),
  ).toBe(0);
  await expect(page.locator(".recent-changes")).toContainText("还有更早的变更未列出");
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
  await expect(warning).toContainText("信息获取时间 2026年9月22日 12:30");
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
    await expect(root).not.toContainText("信息获取时间");
    await expect(root).not.toContainText("副本仍保留");
    await expect(root.locator("[data-node], .event-detail, [data-empty]")).toHaveCount(0);
  }
});

test("首屏即将截止：只列未到时间的截止节点并按先后排序，卡片不重复计入日程条目", async ({
  page,
}) => {
  await page.goto("/");
  await complete(page);
  const cards = page.locator("#ending-soon [data-ending]");
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll((items) => items.map((item) => item.dataset.ending))).toEqual([
    "end",
    "long",
    "derived",
  ]);
  const first = cards.first();
  await expect(first).toContainText("绝区零");
  await expect(first).toContainText("活动结束");
  await expect(first.locator(".cd-value")).toHaveText("5小时30分");
  await expect(first).toContainText("今天 18:00 截止");
  await expect(first).toHaveClass(/is-critical/);
  await expect(first.getByRole("link", { name: "街角奇遇记 · 第三期委托" })).toHaveAttribute(
    "href",
    "/events/evt_end",
  );
  await expect(cards.nth(1).locator(".cd-value")).toHaveText("1天7小时");
  await expect(page.locator("#ending-soon .ending-sub")).toHaveText("近3天内 · 共 3 项");
  // 已过时间的截止、开始类节点、只有日期的节点与已取消节点都不进入首屏卡片。
  for (const id of ["reward", "morning", "date", "cancel", "old"])
    await expect(page.locator(`#ending-soon [data-ending="${id}"]`)).toHaveCount(0);
  // 卡片不使用 data-node：日程里每个节点仍只出现一次。
  await expect(page.locator('[data-node="end"]')).toHaveCount(1);
  await expect(page.locator("#ending-soon [data-node]")).toHaveCount(0);
  // 首屏同时露出即将截止与日程首条。
  expect((await first.boundingBox())?.y).toBeLessThan(page.viewportSize()?.height ?? 0);
});

test("首屏倒计时随时间推进不发请求；不足一小时按秒计，到点后移出", async ({ page }) => {
  await page.goto("/");
  await complete(page);
  const calls = controls.get(page)?.calls.length;
  const card = page.locator('#ending-soon [data-ending="end"]');
  await page.clock.setFixedTime(new Date(clock.getTime() + 60_000));
  await expect(card.locator(".cd-value")).toHaveText("5小时29分");
  await page.clock.setFixedTime(new Date("2026-09-22T17:30:00+08:00"));
  await expect(card.locator(".cd-value")).toHaveText("30分0秒");
  await expect(card).toHaveClass(/is-critical/);
  await page.clock.setFixedTime(new Date("2026-09-22T17:30:05+08:00"));
  await expect(card.locator(".cd-value")).toHaveText("29分55秒");
  await page.clock.setFixedTime(new Date("2026-09-22T18:00:01+08:00"));
  await expect(card).toHaveCount(0);
  await expect(page.locator("#ending-soon [data-ending]")).toHaveCount(2);
  // 「现在」标记移到已过条目之后。
  await expect(page.locator('[data-node="end"] + .now-marker')).toHaveCount(1);
  expect(controls.get(page)?.calls.length).toBe(calls);
});

test("首屏即将截止遵从游戏筛选；超过四项时「查看全部」切到只看截止并定位到日程", async ({
  page,
}) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.events = (params, scenario) => {
    const data = eventsFixture(params, scenario);
    const base = data.nodes.find((node) => node.id === "end");
    if (base?.time.precision !== "datetime") return data;
    const time = base.time;
    const extra = [1, 2].map((offset) => ({
      ...base,
      id: `extra-${offset}`,
      eventId: `evt_extra_${offset}`,
      title: `合成截止 ${offset}`,
      time: { ...time, utc_ms: ExactTimeSchema.parse(time.utc_ms + offset * 3_600_000) },
    }));
    return { ...data, nodes: [...data.nodes, ...extra] };
  };
  await page.goto("/");
  await complete(page);
  const cards = page.locator("#ending-soon [data-ending]");
  await expect(cards).toHaveCount(4);
  const more = page.getByRole("button", { name: "查看全部 5 项截止安排" });
  await more.click();
  await expect(page.getByRole("checkbox", { name: "只看截止" })).toBeChecked();
  expect(new URL(page.url()).searchParams.get("ending")).toBe("1");
  await expect(page.locator("#timeline-title")).toBeFocused();
  await expect(page.locator('.timeline [data-node="morning"]')).toHaveCount(0);
  await expect(page.locator('.timeline [data-node="extra-2"]')).toHaveCount(1);
  await page.locator(".game-option").filter({ hasText: "绝区零" }).click();
  await complete(page);
  for (const id of ["end", "extra-1", "extra-2"])
    await expect(page.locator(`#ending-soon [data-ending="${id}"]`)).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await page.locator(".game-option").filter({ hasText: "原神" }).click();
  await page.locator(".game-option").filter({ hasText: "崩坏：星穹铁道" }).click();
  await complete(page);
  // 一个游戏都不选：首屏卡片整块隐藏，交给日程的「筛选没有匹配项」。
  await expect(page.locator("#ending-soon")).toBeHidden();
  await expect(page.locator('[data-empty="filtered"]')).toBeVisible();
});

test("ADR-0028 没有即将截止的条目时整块不显示，日程照常", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.events = (params, scenario) => {
    const data = eventsFixture(params, scenario);
    return {
      ...data,
      nodes: data.nodes.filter(
        (node) => node.nodeType !== "end" && node.nodeType !== "reward_deadline",
      ),
    };
  };
  await page.goto("/");
  await complete(page);
  await expect(page.locator("#ending-soon")).toBeHidden();
  await expect(page.locator("#ending-soon")).not.toContainText("没有即将截止");
  await expect(page.locator('.timeline [data-node="morning"]')).toHaveCount(1);
});

test("筛选栏单行：桌面不换行，窄屏横向滑动且页面不横向溢出；筛选弹层不被裁切", async ({
  page,
}, info) => {
  await page.goto("/");
  await complete(page);
  const bar = page.locator("#browse-filters");
  // ADR-0017：时间范围收进「筛选」弹层，筛选栏只剩游戏、只看截止与「筛选」按钮。
  await expect(page.locator("#more-filters .range-option")).toHaveCount(5);
  await expect(page.locator("#more-filters-toggle")).toContainText("近3天");
  const rows = await page
    .locator("#browse-filters .game-option, #browse-filters .deadline-filter, #more-filters-toggle")
    .evaluateAll((items) =>
      items
        .map((item) => item.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => Math.round(box.top + box.height / 2)),
    );
  expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(2);
  expect((await bar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(64);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const toggle = page.locator("#more-filters-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const panel = page.locator("#more-filters");
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("missing viewport");
  if (info.project.name.startsWith("mobile"))
    // 窄屏是贴底的面板：等滑入动画结束后底边与视口底边对齐。
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box ? Math.round(box.y + box.height) : -1;
      })
      .toBe(viewport.height);
  else
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        const anchor = await toggle.boundingBox();
        return box && anchor ? box.y - (anchor.y + anchor.height) : -1;
      })
      .toBe(8);
  const box = await panel.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
  await page.getByRole("checkbox", { name: "卡池", exact: true }).check();
  await expect(toggle.locator("#more-summary")).toHaveText("1");
  await page.getByRole("radio", { name: "近7天", exact: true }).check();
  await expect(toggle.locator("#more-range")).toHaveText("近7天");
  // 「清除这些条件」恢复弹层里的全部条件：时间范围回到默认档，类型清空。
  await page.getByRole("button", { name: "清除这些条件" }).click();
  await expect(page.getByRole("checkbox", { name: "卡池", exact: true })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "近3天", exact: true })).toBeChecked();
  await expect(toggle.locator("#more-range")).toHaveText("近3天");
  await expect(toggle.locator("#more-summary")).toBeHidden();
  await expect(page.getByRole("button", { name: "清除这些条件" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("旧链接 range=90d 按「全部」读取，地址改写为当前档位", async ({ page }) => {
  const ranges: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/events") ranges.push(url.searchParams.get("range"));
  });
  await page.goto("/?range=90d");
  await complete(page);
  await expect(
    page.getByRole("radio", { name: "全部", exact: true, includeHidden: true }),
  ).toBeChecked();
  await expect(page.locator("#more-range")).toHaveText("全部");
  await expect(page.locator(".load-row")).toContainText("已显示完全部日程");
  await expect(page.locator('.load-row [data-action="show-more"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("range")).toBe("all");
  expect(ranges).toEqual(["all"]);
});

// F1-07（ADR-0015）：日程界面简化。
test("A-F1-POLISH 时间轴跨日连续，日期是轨道上的标记；全天条目接在当天之后", async ({ page }) => {
  await page.goto("/");
  await complete(page);
  const days = page.locator('[data-region="days"] > section.schedule-day');
  expect(await days.count()).toBeGreaterThan(1);
  // 日期标记与条目同一网格、带日期点，不再是带上下边框的整条标题栏。
  for (const heading of await page.locator('[data-region="days"] .day-heading').all()) {
    await expect(heading.locator(".day-rail")).toHaveCount(1);
    expect(await heading.evaluate((e) => getComputedStyle(e).borderBottomWidth)).toBe("0px");
  }
  for (const day of await days.all())
    expect(await day.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("0px");
  // 日程区的列表之间没有内边距空隙，轨道才连得上。
  for (const list of await page.locator('[data-region="days"] ul').all())
    expect(
      await list.evaluate((e) => [
        getComputedStyle(e).paddingTop,
        getComputedStyle(e).paddingBottom,
      ]),
    ).toEqual(["0px", "0px"]);
  await expect(page.locator('[data-region="days"] .day-heading').first()).toContainText(
    "周二 · 今天",
  );
  // 只有日期的条目归在当天，标"全天"，没有"具体时刻未公布"小标题。
  const day = page.locator('section.schedule-day[data-date="2026-09-23"]');
  await expect(day.locator('.date-only [data-node="date"]')).toContainText("全天");
  await expect(page.locator(".date-only h4, .timeline h4")).toHaveCount(0);
  await expect(page.locator(".timeline")).not.toContainText("当天 · 具体时刻未公布");
});

test("A-F1-POLISH 时间待定默认折叠，展开后重绘仍保持展开", async ({ page, context }) => {
  await page.goto("/");
  await complete(page);
  const pending = page.locator('[data-region="pending"]');
  // F1-09：时间待定是时间轴下方单独的卡片，不在时间轴卡片里。
  await expect(page.locator('.timeline [data-region="pending"]')).toHaveCount(0);
  await expect(pending).toHaveClass(/\bcard\b/);
  await expect(pending).not.toHaveAttribute("open");
  await expect(pending.locator("summary")).toContainText("时间待定");
  await expect(pending.locator('[data-node="pending"]')).toBeHidden();
  await pending.locator("summary").click();
  await expect(pending.locator('[data-node="pending"]')).toBeVisible();
  // 离线/恢复都会触发整页重绘。
  await context.setOffline(true);
  await expect(page.locator(".data-warning").first()).toContainText("当前离线");
  await context.setOffline(false);
  await expect(page.locator('[data-region="pending"]')).toHaveAttribute("open", "");
});

test("A-F1-POLISH 截止 24 小时内为高危：卡片与时间轴剩余时间都标红，3 天内为临近", async ({
  page,
}) => {
  await page.goto("/");
  await complete(page);
  const cards = page.locator("#ending-soon [data-ending]");
  await expect(cards.nth(0)).toHaveClass(/is-critical/);
  await expect(cards.nth(1)).toHaveClass(/is-soon/);
  await expect(page.locator(".ending-card.is-urgent")).toHaveCount(0);
  await expect(page.locator('[data-node="end"] .node-relative')).toHaveClass(/is-critical/);
  await expect(page.locator('[data-node="long"] .node-relative')).not.toHaveClass(/is-critical/);
  // 时间推进到 24 小时内，时间轴的剩余时间随每分钟刷新转为高危，不需要重新加载。
  await page.clock.setFixedTime(new Date("2026-09-22T20:30:00+08:00"));
  await expect(page.locator('[data-node="long"] .node-relative')).toHaveClass(/is-critical/, {
    timeout: 70_000,
  });
});

test("A-F1-POLISH 游戏标识使用官方应用图标，随站点发布，不向第三方请求", async ({ page }) => {
  const thirdParty: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "data:" && !["127.0.0.1", "localhost"].includes(url.hostname))
      thirdParty.push(request.url());
  });
  await page.goto("/");
  await complete(page);
  for (const game of ["genshin", "hsr", "zzz"]) {
    const image = page.locator(`.game-option[data-game="${game}"] .game-icon img`);
    await expect(image).toHaveAttribute("src", `/game-icons/${game}.png`);
    await expect(image).toHaveAttribute("alt", "");
    expect(await image.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator(".game-icon svg")).toHaveCount(0);
  expect(thirdParty).toEqual([]);
});

test("A-F1-POLISH 过时条幅只说信息获取时间，条幅里的刷新按钮重新读取", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  await page.goto("/");
  await complete(page);
  await scenario(page, "stale");
  const warning = page.locator("#schedule-results .cache-notice");
  await expect(warning).toHaveText(/^内容可能已过时，信息获取时间 2026年9月21日 20:00\s*刷新$/);
  const reloads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v2/"))
      reloads.push(new URL(request.url()).pathname);
  });
  control.scenario = "normal";
  await warning.getByRole("button", { name: "刷新" }).click();
  await complete(page);
  await expect(page.locator("#schedule-results .cache-notice")).toHaveCount(0);
  // 刷新重新读取目录、状态、日程与兑换码（ADR-0030），不沿用已加载的副本。
  expect([...new Set(reloads)].sort()).toEqual([
    "/api/v2/catalog",
    "/api/v2/events",
    "/api/v2/redeem-codes",
    "/api/v2/status",
  ]);
});

// ADR-0017：从上到下按时间先后；时间范围收进「筛选」；「显示更多」逐档续读。
const nodeIds = (items: Element[]) =>
  items.map((item) => (item as HTMLElement).dataset.node ?? (item as HTMLElement).dataset.change);

test("A-F1-BROWSE 末行写明已显示完的档位；「显示更多」读下一档，已显示的条目不清空，新条目接在末行位置", async ({
  page,
}) => {
  let hold: (() => void) | undefined;
  const ranges: (string | null)[] = [];
  const shownBefore = new Set(
    eventsFixture(new URLSearchParams({ range: "3d" })).nodes.map((node) => node.id),
  );
  await page.route("**/api/v2/events?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    ranges.push(params.get("range"));
    const data = eventsFixture(params);
    if (params.get("range") !== "7d") return route.fulfill({ json: data });
    // 下一档分两页、第一页只有新条目：逐页替换会让已显示的条目先消失。
    // 换上时上方区块变高（副本已过新鲜期的提示），检验视口以最后一天为锚不跳。
    const stale = { ...data, cache: { ...data.cache, freshUntil: clock.getTime() - 1 } };
    if (!params.has("cursor"))
      return route.fulfill({
        json: {
          ...stale,
          nodes: data.nodes.filter((node) => !shownBefore.has(node.id)),
          nextCursor: "7d-rest",
        },
      });
    await new Promise<void>((resolve) => {
      hold = resolve;
    });
    return route.fulfill({
      json: {
        ...stale,
        nodes: data.nodes.filter((node) => shownBefore.has(node.id)),
        recentChanges: [],
      },
    });
  });
  await page.goto("/");
  await complete(page);
  const end = page.locator(".load-row");
  await expect(end).toContainText("已显示完近3天");
  await expect(page.locator('[data-node="later"]')).toHaveCount(0);
  const rows = page.locator('[data-region="days"] [data-node]');
  const before = await rows.count();
  const lastDate = await page
    .locator('[data-region="days"] > .schedule-day')
    .last()
    .getAttribute("data-date");
  // 记录读取期间日程条目的最少数量：页面不清空、不整体重载。
  await page.evaluate(() => {
    const state = window as unknown as { minRows: number };
    state.minRows = Number.POSITIVE_INFINITY;
    const count = () => {
      state.minRows = Math.min(
        state.minRows,
        document.querySelectorAll('#schedule-results [data-region="days"] [data-node]').length,
      );
    };
    const results = document.getElementById("schedule-results");
    if (results) new MutationObserver(count).observe(results, { childList: true, subtree: true });
  });
  await end.scrollIntoViewIfNeeded();
  const lastDay = page.locator(`[data-region="days"] > [data-date="${lastDate}"]`);
  const topBefore = (await lastDay.boundingBox())?.y ?? 0;
  await end.getByRole("button", { name: "显示更多" }).click();
  // 读取期间：提示在时间线顶部；末行按钮保留（焦点不丢）并标为不可用；条目原样保留。
  await expect(page.locator(".timeline-heading")).toContainText("正在加载近7天");
  await expect(end.locator('[data-action="show-more"]')).toHaveAttribute("aria-disabled", "true");
  await expect(end.locator('[data-action="show-more"]')).toBeFocused();
  await expect(rows).toHaveCount(before);
  await expect.poll(() => hold !== undefined).toBe(true);
  hold?.();
  await expect(end).toContainText("已显示完近7天");
  await expect(page.locator('[data-node="later"]')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { minRows: number }).minRows),
  ).toBeGreaterThanOrEqual(before);
  // 原来的最后一天原地不动，下一档的日期接在它之后（原末行的位置）。
  expect(Math.abs(((await lastDay.boundingBox())?.y ?? 0) - topBefore)).toBeLessThanOrEqual(2);
  const dates = await page
    .locator('[data-region="days"] > .schedule-day')
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.date));
  expect(dates.indexOf(lastDate ?? "")).toBeLessThan(dates.length - 1);
  expect(new URL(page.url()).searchParams.get("range")).toBe("7d");
  await expect(page.locator("#more-range")).toHaveText("近7天");
  await expect(end.locator('[data-action="show-more"]')).toBeFocused();
  // 逐档：近30天 → 全部；最大一档不再提供「显示更多」，焦点留在末行；只重读日程，不重读目录与状态。
  await end.getByRole("button", { name: "显示更多" }).click();
  await expect(end).toContainText("已显示完近30天");
  await end.getByRole("button", { name: "显示更多" }).click();
  await expect(end).toContainText("已显示完全部日程");
  await expect(end.locator('[data-action="show-more"]')).toHaveCount(0);
  await expect(end).toBeFocused();
  expect(ranges).toEqual(["3d", "7d", "7d", "30d", "all"]);
  // 目录、状态与兑换码各读一次（ADR-0030 增加兑换码）。
  expect(controls.get(page)?.calls.filter((call) => call.path !== "/api/v2/events").length).toBe(3);
});

test("A-F1-BROWSE 加载提示在时间线顶部；读完之前不出现末行", async ({ page }) => {
  const holds: (() => void)[] = [];
  await page.route("**/api/v2/events?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await new Promise<void>((resolve) => holds.push(resolve));
    const data = eventsFixture(params);
    await route.fulfill({
      json: params.has("cursor")
        ? { ...data, nodes: [], recentChanges: [] }
        : { ...data, nextCursor: "more" },
    });
  });
  await page.goto("/");
  const heading = page.locator(".timeline-heading");
  // 首屏骨架：提示在卡片顶部、首屏之内。
  await expect(heading).toContainText("正在加载日程");
  await expect(page.locator(".timeline-skeleton")).toBeVisible();
  expect((await heading.boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    page.viewportSize()?.height ?? 0,
  );
  await expect.poll(() => holds.length).toBe(1);
  holds[0]();
  // 第一页到达、续页未到：条目已显示，提示仍在顶部，末行不出现。
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
  await expect(heading).toContainText("正在加载日程");
  await expect(page.locator(".load-row")).toHaveCount(0);
  await expect.poll(() => holds.length).toBe(2);
  holds[1]();
  await complete(page);
  await expect(heading).not.toContainText("正在加载");
});

test("A-F1-BROWSE 近期变更与时间待定从上到下按时间先后、从开始到结束", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  const unknown = {
    precision: "unknown" as const,
    source_timezone: "UTC+8",
    raw_expression: "待公布",
    time_basis: "unresolved" as const,
  };
  control.events = (params, scenario) => {
    const data = eventsFixture(params, scenario);
    const base = data.nodes.find((node) => node.time.precision === "datetime");
    if (!base) throw new Error("fixture needs a timed node");
    return {
      ...data,
      nodes: [
        ...data.nodes.filter((node) => node.time.precision !== "unknown"),
        { ...base, id: "pending-end", eventId: "evt_pending", nodeType: "end", time: unknown },
        { ...base, id: "pending-start", eventId: "evt_pending", nodeType: "start", time: unknown },
      ],
      // 接口按变更保留期排序；页面按节点时间先后重排。
      recentChanges: [...data.recentChanges].reverse(),
    };
  };
  await page.goto("/");
  await complete(page);
  const expected = [...eventsFixture(new URLSearchParams()).recentChanges]
    .sort(compareScheduleNodes)
    .map((node) => node.id);
  expect(expected).not.toEqual([...expected].reverse());
  await page.locator(".recent-changes summary").click();
  expect(await page.locator(".change-list > [data-change]").evaluateAll(nodeIds)).toEqual(expected);
  await page.locator('[data-region="pending"] > summary').click();
  expect(await page.locator('[data-region="pending"] [data-node]').evaluateAll(nodeIds)).toEqual([
    "pending-start",
    "pending-end",
  ]);
});

// F1-09（ADR-0020）：时间轴整合——今天总在、回看昨天接在主轴上、时间待定单独成卡、日期点与已过条目。
const TODAY = browseDate(clock.getTime());
type FixtureNode = ReturnType<typeof eventsFixture>["nodes"][number];
const dayOf = (node: FixtureNode) =>
  node.time.precision === "datetime"
    ? browseDate(node.time.utc_ms)
    : node.time.precision === "date"
      ? node.time.date
      : null;
/** 页面里 token 实际解析出的颜色，用来比对计算样式（不在测试里写死色值）。 */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
const railCenter = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return Math.round(box.left + box.width / 2);
  });

test("A-F1-TIMELINE 今天没有安排时仍画出今天与「现在」时刻线", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.events = (params, scenario) => {
    const data = eventsFixture(params, scenario);
    return { ...data, nodes: data.nodes.filter((node) => dayOf(node) !== TODAY) };
  };
  await page.goto("/");
  await complete(page);
  const days = page.locator('[data-region="days"] > section.schedule-day');
  await expect(days.first()).toHaveAttribute("data-date", TODAY);
  const today = days.first();
  await expect(today).toHaveClass(/is-today/);
  await expect(today.locator(".day-count")).toHaveText("暂无安排");
  await expect(today.locator("[data-node]")).toHaveCount(0);
  await expect(today.locator(".now-marker")).toHaveCount(1);
  await expect(today.locator("[data-now-clock]")).toHaveText("12:30");
  expect(await days.count()).toBeGreaterThan(1);
});

test("A-F1-TIMELINE 今天只有全天条目时，时刻线在全天条目之前", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  control.events = (params, scenario) => {
    const data = eventsFixture(params, scenario);
    return {
      ...data,
      nodes: data.nodes
        .filter((node) => dayOf(node) !== TODAY)
        .map((node) =>
          node.id === "date" && node.time.precision === "date"
            ? { ...node, time: { ...node.time, date: DateOnlySchema.parse(TODAY) } }
            : node,
        ),
    };
  };
  await page.goto("/");
  await complete(page);
  const today = page.locator(`[data-region="days"] > section.schedule-day[data-date="${TODAY}"]`);
  await expect(today.locator(".day-count")).toHaveText("1 项");
  await expect(today.locator(".timed-list > .now-marker")).toHaveCount(1);
  await expect(today.locator('.date-only > [data-node="date"]')).toHaveCount(1);
  expect(
    await today.evaluate((section) => [...section.children].map((child) => child.className)),
  ).toEqual(["day-heading", "timed-list", "date-only"]);
});

test("A-F1-TIMELINE 回看昨天接在主时间轴上：同一条轨道，展开后昨天的日期段落在今天之上", async ({
  page,
}) => {
  await page.goto("/");
  await complete(page);
  const toggle = page.locator(".yesterday-band > summary");
  const todayRail = page.locator('[data-region="days"] > section.is-today .day-rail');
  // 折叠时是轨道上的一行：轨道从这一行的图标处向下接到今天。
  expect(await railCenter(toggle.locator(".toggle-rail"))).toBe(await railCenter(todayRail));
  expect(
    await toggle
      .locator(".toggle-rail")
      .evaluate((element) => getComputedStyle(element, "::before").display),
  ).not.toBe("none");
  await toggle.click();
  const yesterday = page.locator(
    '[data-region="yesterday"] > section.schedule-day[data-date="2026-09-21"]',
  );
  await expect(yesterday.locator(".day-heading")).toContainText("周一 · 昨天");
  await expect(yesterday.locator('[data-node="old"]')).toBeVisible();
  expect(await railCenter(yesterday.locator(".day-rail"))).toBe(await railCenter(todayRail));
  // 不再另开一段列表；昨天整段在今天之上。
  await expect(page.locator('[data-region="yesterday"] .node-list')).toHaveCount(0);
  const above = await yesterday.boundingBox();
  const below = await page.locator('[data-region="days"] > section.is-today').boundingBox();
  if (!above || !below) throw new Error("missing layout");
  expect(above.y + above.height).toBeLessThanOrEqual(below.y + 1);
});

test("A-F1-TIMELINE 日期点是实心圆角方块；已过的条目降权", async ({ page }) => {
  // 入场动效期间行的不透明度在变化；只量静止状态。
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await complete(page);
  // 日期点曾被通用的条目圆点规则覆盖，画成无边框的白点、看起来像轨道断了一截。
  const dot = await page
    .locator('[data-region="days"] > section.schedule-day:not(.is-today) .day-rail')
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        radius: style.borderTopLeftRadius,
        width: style.width,
        color: style.backgroundColor,
      };
    });
  expect(dot).toEqual({
    radius: "3px",
    width: "10px",
    color: await tokenColor(page, "--color-control-border"),
  });
  // 已过（08:00）的标题用次要文字色，未到的（18:00）不降权；不降不透明度。
  const secondary = await tokenColor(page, "--color-text-secondary");
  const titleColor = (id: string) =>
    page
      .locator(`[data-node="${id}"] .event-title`)
      .evaluate((element) => getComputedStyle(element).color);
  expect(await titleColor("morning")).toBe(secondary);
  expect(await titleColor("end")).not.toBe(secondary);
  expect(
    await page.locator('[data-node="morning"]').evaluate((e) => getComputedStyle(e).opacity),
  ).toBe("1");
});

// ADR-0030：有效兑换码条。
test("ADR-0030 有效兑换码条：有可显示的兑换码才出现，按游戏筛，一键复制，到点自动移除", async ({
  page,
  context,
}) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const now = clock.getTime();
  const hour = 3_600_000;
  control.redeem = () =>
    redeemCodesFixture([
      {
        game: "genshin",
        code: "GENSHINSYNTH1",
        reward: "原石*100，精炼用魔矿*10",
        liveTitle: "合成原神前瞻特别节目",
        revealedAt: now - hour,
        expiresAt: now + 2 * hour,
        expiryText: "9月22日14:30",
        hiddenAt: now + 2 * hour,
        officialUrl: "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=synthetic1",
        eventId: "evt_morning",
      },
      {
        game: "zzz",
        code: "ZZZSYNTH2",
        reward: "菲林*100",
        liveTitle: "合成绝区零前瞻特别节目",
        revealedAt: now - hour,
        expiresAt: null,
        expiryText: null,
        // ADR-0034：没有截止时间时，页面只按跟踪期满（7 天）兜底隐藏。
        hiddenAt: now - hour + 7 * 24 * hour,
        officialUrl: "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=synthetic2",
        eventId: null,
      },
    ]);
  await page.goto("/");
  await complete(page);
  const bar = page.locator("#redeem-codes");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("heading", { name: "有效兑换码" })).toBeVisible();
  await expect(bar.locator(".redeem-item")).toHaveCount(2);
  const genshin = bar.locator('[data-redeem="genshin:GENSHINSYNTH1"]');
  await expect(genshin).toContainText("原石*100，精炼用魔矿*10");
  await expect(genshin).toContainText("9月22日 14:30 过期 · 还剩 2 小时");
  await expect(genshin.getByRole("link", { name: "合成原神前瞻特别节目" })).toHaveAttribute(
    "href",
    "/events/evt_morning",
  );
  const zzz = bar.locator('[data-redeem="zzz:ZZZSYNTH2"]');
  // ADR-0034：没有截止时间时只写"请尽快兑换"。
  await expect(zzz.locator(".redeem-expiry")).toHaveText("请尽快兑换");
  await expect(zzz.getByRole("link", { name: "合成绝区零前瞻特别节目" })).toHaveAttribute(
    "href",
    /webstatic\.mihoyo\.com\/bbs\/event\/live/,
  );
  // 条在「即将截止」之前、筛选栏之后；位于首屏。
  expect((await bar.boundingBox())?.y).toBeLessThan(page.viewportSize()?.height ?? 0);

  await genshin.getByRole("button", { name: "复制兑换码 GENSHINSYNTH1" }).click();
  await expect(page.locator("#toast-region")).toContainText("已复制兑换码 GENSHINSYNTH1");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("GENSHINSYNTH1");

  // 按首页选中的游戏筛：取消绝区零后只剩原神；两个都取消则整块隐藏。
  await page.locator('label.game-option[data-game="zzz"]').click();
  await expect(bar.locator(".redeem-item")).toHaveCount(1);
  await page.locator('label.game-option[data-game="genshin"]').click();
  await expect(bar).toBeHidden();
  await page.locator('label.game-option[data-game="genshin"]').click();
  await expect(bar.locator(".redeem-item")).toHaveCount(1);

  // 官方有效期到点：条目移除、整块隐藏，不发新请求。
  const before = control.calls.length;
  await page.clock.setFixedTime(now + 2 * hour + 1000);
  await page.clock.runFor(2000);
  await expect(bar).toBeHidden();
  expect(control.calls.length).toBe(before);
});

test("ADR-0030 没有可显示的兑换码、或兑换码接口失败时整块不出现，日程照常", async ({ page }) => {
  const control = controls.get(page);
  if (!control) throw new Error("missing fixture");
  await page.goto("/");
  await complete(page);
  await expect(page.locator("#redeem-codes")).toBeHidden();
  await page.route("**/api/v2/redeem-codes", (route) => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await complete(page);
  await expect(page.locator("#redeem-codes")).toBeHidden();
  await expect(page.locator(".data-warning")).toHaveCount(0);
  await expect(page.locator('[data-node="morning"]')).toBeVisible();
});
