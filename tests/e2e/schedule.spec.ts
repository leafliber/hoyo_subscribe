import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ExactTimeSchema } from "../../packages/contracts/src/index";
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
  await page.getByRole("radio", { name: "近30天" }).check();
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

test("U03 五档昨天带常驻末尾；按响应 window 切分，不按浏览器日期", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-25T12:00:00+08:00"));
  await page.goto("/");
  // 「未来90天」与「全部」重叠，首页不再单独提供。
  await expect(page.getByRole("radio", { name: "未来90天" })).toHaveCount(0);
  for (const label of ["今天", "近3天", "近7天", "近30天", "全部"]) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await complete(page);
    await expect(page.locator('[data-node="morning"]')).toBeVisible();
    await expect(page.locator('[data-region="yesterday"] [data-node="old"]')).toHaveCount(1);
    await expect(page.locator('[data-region="yesterday"]')).toContainText("9月21日");
  }
  expect(await page.locator(".timeline > :last-child").getAttribute("data-region")).toBe(
    "yesterday",
  );
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
  await expect(page.locator(".data-warning")).toContainText("陈旧缓存");
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
  await expect(page.locator(".recent-changes img, .schedule-results img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted,
    ),
  ).toBe(0);
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
  await expect(warning).toContainText("实际缓存时间 2026年9月22日 12:30");
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
  await expect(first).toContainText("玩法结束");
  await expect(first.locator(".cd-value")).toHaveText("5小时30分");
  await expect(first).toContainText("今天 18:00 截止");
  await expect(first).toHaveClass(/is-urgent/);
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

test("筛选栏单行：桌面不换行，窄屏横向滑动且页面不横向溢出；更多筛选弹层不被裁切", async ({
  page,
}, info) => {
  await page.goto("/");
  await complete(page);
  const bar = page.locator("#browse-filters");
  const rows = await page
    .locator(
      "#browse-filters .game-option, #browse-filters .range-option, #browse-filters .deadline-filter, #more-filters-toggle",
    )
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
  await page.getByRole("button", { name: "清除这些条件" }).click();
  await expect(page.getByRole("checkbox", { name: "卡池", exact: true })).not.toBeChecked();
  await expect(toggle.locator("#more-summary")).toBeHidden();
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
  await expect(page.getByRole("radio", { name: "全部", exact: true })).toBeChecked();
  expect(new URL(page.url()).searchParams.get("range")).toBe("all");
  expect(ranges).toEqual(["all"]);
});
