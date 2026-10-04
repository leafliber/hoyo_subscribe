import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { articlesFixture, detailFixture, mockPublicApi } from "./fixtures/public-schedule";

test.beforeEach(async ({ page }) => {
  await mockPublicApi(page);
});

test("U02 活动结束与奖励领取截止在实际节点时间线中分别出现", async ({ page }) => {
  await page.goto("/events/evt_morning");
  await expect(page.locator(".event-detail")).toBeVisible();
  expect(
    await page
      .locator(".event-detail [data-section]")
      .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-section"))),
  ).toEqual(["important", "timeline", "change", "official"]);
  const timeline = page.locator('[data-section="timeline"]');
  await expect(timeline.locator("[data-milestone]")).toHaveCount(3);
  await expect(timeline.locator('[data-milestone="morning-end"]')).toContainText("活动结束");
  await expect(timeline.locator('[data-milestone="morning-reward"]')).toContainText("奖励领取截止");
  await expect(page.locator('[data-section="important"]')).toContainText("活动结束");
});

test("U02 从日程条目进入对应事件详情", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-node="morning"] .event-title').click();
  await expect(page).toHaveURL(/\/events\/evt_morning\/?$/);
  await expect(page.locator("h1")).toHaveText("巡游拾光 · 城市探索挑战");
});

test("U02 只有奖励截止时不补活动结束", async ({ page }) => {
  await page.goto("/events/evt_reward");
  const timeline = page.locator('[data-section="timeline"]');
  await expect(timeline.locator("[data-milestone]")).toHaveCount(1);
  await expect(timeline).toContainText("奖励领取截止");
  await expect(timeline).not.toContainText("活动结束");
});

test("U02 纯日期与未知精度只展示已知信息，不猜午夜或时刻", async ({ page }) => {
  await page.goto("/events/evt_date");
  const date = page.locator('[data-section="timeline"]');
  await expect(date.locator(".milestone-time")).toContainText("具体时间未公布");
  await expect(date.locator("time")).toHaveCount(0);
  await expect(date.locator(".milestone-time")).not.toContainText("00:00");
  await page.goto("/events/evt_pending");
  const unknown = page.locator('[data-section="timeline"]');
  await expect(unknown.locator(".milestone-time")).toContainText("时间待公布");
  await expect(unknown.locator("time")).toHaveCount(0);
  await expect(unknown.locator(".milestone-time")).not.toContainText(/\d{2}:\d{2}/);
});

test("U04 改期的历史原时间与当前时间并列，旧时间不作当前安排", async ({ page }) => {
  await page.goto("/events/evt_rescheduled");
  const change = page.locator('[data-section="change"]');
  await expect(change.locator(".historical-time")).toContainText("原时间（历史）");
  await expect(change.locator(".current-time")).toContainText("当前时间");
  const oldTime = await change.locator(".historical-time time").textContent();
  const currentTime = await change.locator(".current-time time").textContent();
  expect(oldTime).toMatch(/\d{1,2}月\d{1,2}日 周. 10:00/);
  expect(currentTime).toMatch(/\d{1,2}月\d{1,2}日 周. 10:00/);
  expect(oldTime).not.toBe(currentTime);
  await expect(page.locator('[data-section="important"]')).toContainText(currentTime ?? "");
  await expect(page.locator('[data-section="important"]')).not.toContainText(oldTime ?? "");
});

test("U04 官方取消和本站撤回分开呈现，不宣称撤回旧副本", async ({ page }) => {
  await page.goto("/events/evt_cancel");
  await expect(page.locator('[data-section="important"]')).toContainText("官方已取消");
  await expect(page.locator('[data-section="important"] time')).toHaveCount(0);
  await expect(page.locator('[data-section="change"]')).toContainText("主办方公告取消");
  await expect(page.locator('[data-section="change"]')).not.toContainText("本站撤回");
  await expect(page.locator('[data-section="timeline"]')).toContainText("原安排（历史）");
  await page.goto("/events/evt_retract");
  await expect(page.locator('[data-section="important"]')).toContainText("本站撤回");
  await expect(page.locator('[data-section="important"] time')).toHaveCount(0);
  await expect(page.locator('[data-section="change"]')).toContainText("误将旧版本公告收录");
  await expect(page.locator('[data-section="change"]')).not.toContainText("官方已取消");
  await expect(page.locator('[data-section="timeline"]')).toContainText("原安排（历史）");
  await expect(page.locator("body")).not.toContainText(
    /已撤回旧邮件|已撤回旧 Push|已撤回.*日历副本/,
  );
});

test("U04 公告与证据的 img onerror 只显示文字，不执行", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted = 0;
  });
  await page.goto("/events/evt_morning");
  await expect(page.locator(".event-detail")).toBeVisible();
  const maliciousText = '<img src=x onerror="window.__evidenceExecuted=1">';
  expect(
    await page.evaluate(
      () => (window as Window & { __evidenceExecuted?: number }).__evidenceExecuted,
    ),
  ).toBe(0);
  await expect(
    page.locator('[data-section="timeline"] img, [data-section="official"] img'),
  ).toHaveCount(0);
  await expect(page.locator('[data-milestone="morning-end"] .evidence-text')).toContainText(
    maliciousText,
  );
  await expect(page.locator(".notice-text")).toContainText(maliciousText);
});

test("U04 官方依据逐级展开，三项主要操作可用且设置订阅只跳整份草稿", async ({ page }) => {
  await page.goto("/events/evt_morning");
  await expect(page.locator(".event-detail")).toBeVisible();
  const official = page.locator('[data-section="official"]');
  // P3-22：「查看官方公告」打开原文弹窗；官方接口地址仍在官方来源里，标明是数据源。
  await expect(page.getByRole("button", { name: "查看官方公告", exact: true })).toBeVisible();
  await expect(official.getByRole("link", { name: "官方数据源", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  await expect(official.getByRole("link", { name: "官方数据源", exact: true })).toHaveAttribute(
    "title",
    "官方接口返回的原始数据，适合核对",
  );
  await official.locator("details > summary").first().click();
  await expect(official.locator(".notice-text")).toContainText("synthetic 公告原文样例");
  await official.locator("details details > summary").click();
  await expect(official).toContainText("源时区");
  await expect(official).toContainText("更新时间");
  await expect(page.getByRole("link", { name: "返回日程", exact: true })).toHaveAttribute(
    "href",
    "/",
  );
  // 页首主操作与侧栏提示都只进入整份订阅设置，不提供「订阅这个活动」。
  for (const link of await page.getByRole("link", { name: "设置订阅", exact: true }).all())
    await expect(link).toHaveAttribute("href", "/subscription");
  await expect(page.locator("body")).not.toContainText("订阅这个活动");
  await page
    .locator(".detail-actions")
    .getByRole("link", { name: "设置订阅", exact: true })
    .click();
  await expect(page).toHaveURL(/\/subscription\/?$/);
});

test("U02 U04 桌面与手机截图、窄屏和键盘展开留证", async ({ page }, info) => {
  await page.goto("/events/evt_morning");
  await expect(page.locator(".event-detail")).toBeVisible();
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  const folder = resolve(
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f1-06"
      : "tests/e2e/test-results/f1-06",
  );
  mkdirSync(folder, { recursive: true });
  if (viewport === "mobile") {
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: `${folder}/${viewport}-detail.png`, fullPage: true });
  const subscribe = page
    .locator(".detail-actions")
    .getByRole("link", { name: "设置订阅", exact: true });
  await page.getByRole("link", { name: "返回日程", exact: true }).focus();
  await expect(page.getByRole("link", { name: "返回日程", exact: true })).toBeFocused();
  // 键盘顺序：返回 → 主操作「设置订阅」→「查看官方公告」。
  await page.keyboard.press("Tab");
  await expect(subscribe).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "查看官方公告", exact: true })).toBeFocused();
  const outline = await page
    .getByRole("button", { name: "查看官方公告", exact: true })
    .evaluate((link) => getComputedStyle(link).outlineStyle);
  expect(outline).not.toBe("none");
  const summary = page.locator('[data-section="official"] details > summary').first();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-section="official"] details').first()).toHaveAttribute(
    "open",
    "",
  );
  await page.screenshot({ path: `${folder}/${viewport}-evidence-expanded.png`, fullPage: true });
  await page.goto("/events/evt_rescheduled");
  await expect(page.locator(".event-detail")).toBeVisible();
  await page.screenshot({ path: `${folder}/${viewport}-rescheduled.png`, fullPage: true });
});

test("U02 真实形状 ID 直达和刷新均读取详情，HTML 导航不拦截", async ({ page }) => {
  const id = "evt_01J9PUBLICSCHEDULE";
  let calls = 0;
  await page.route(`**/api/v2/events/${id}`, (route) => {
    calls++;
    const data = detailFixture("evt_morning");
    if (!data) throw new Error("fixture missing");
    data.event.id = id;
    return route.fulfill({ json: data });
  });
  expect((await page.goto(`/events/${id}`))?.status()).toBe(200);
  await expect(page.locator(".event-detail")).toHaveAttribute("data-event", id);
  expect((await page.reload())?.status()).toBe(200);
  await expect(page.locator(".event-detail")).toHaveAttribute("data-event", id);
  expect(calls).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/events/${id}$`));
});

test("U04 importantNodeId 为 null 不补安排；删除与官方取消分开，未知元数据不补猜", async ({
  page,
}) => {
  await page.route("**/api/v2/events/evt_morning", (route) => {
    const data = detailFixture("evt_morning");
    if (!data) throw new Error("fixture missing");
    data.event.importantNodeId = null;
    data.event.official.url = "javascript:alert(1)";
    data.event.changes = [
      {
        nodeId: "removed",
        change: {
          kind: "deleted",
          explanation: "删除不再存在的节点",
          historicalTime: data.event.milestones[0].time,
          currentTime: null,
          retainUntil: 0,
          evidence: "公开删除依据",
        },
      },
    ];
    return route.fulfill({ json: data });
  });
  await page.goto("/events/evt_morning");
  await expect(page.locator('[data-section="important"]')).toContainText("暂无可确认");
  await expect(page.locator('[data-section="important"] time')).toHaveCount(0);
  await expect(page.locator('[data-section="change"]')).toContainText("本站删除节点（非官方取消）");
  await expect(page.locator('[data-section="official"]')).toContainText("发布者未知");
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test("U04 确定性推导在时间依据里写明推导依据（ADR-0011 版本锚点）", async ({ page }) => {
  let nodeId = "";
  await page.route("**/api/v2/events/evt_morning", (route) => {
    const data = detailFixture("evt_morning");
    if (!data) throw new Error("fixture missing");
    const node = data.event.milestones[0];
    nodeId = node.id;
    node.time = {
      ...node.time,
      time_basis: "deterministic_derived",
      raw_expression: "4.6版本结束",
    };
    return route.fulfill({ json: data });
  });
  await page.goto("/events/evt_morning");
  const milestone = page.locator(`[data-milestone="${nodeId}"]`);
  await expect(milestone.locator(".milestone-status")).toContainText("按公告推算");
  await expect(milestone.locator(".evidence-box")).toContainText("原始时间表述：4.6版本结束");
  await expect(milestone.locator(".evidence-box")).toContainText(
    "推导依据：取 4.6 版本的结束时间，按官方版本公告核对确认。",
  );
  // 其他节点不是版本锚点，不出现推导依据。
  await expect(page.locator(".evidence-box", { hasText: "推导依据" })).toHaveCount(1);
});

test("U04 补全年份的节点写明年份是补出来的（ADR-0013）", async ({ page }) => {
  let nodeId = "";
  await page.route("**/api/v2/events/evt_morning", (route) => {
    const data = detailFixture("evt_morning");
    if (!data) throw new Error("fixture missing");
    const node = data.event.milestones[0];
    nodeId = node.id;
    node.time = {
      precision: "date",
      date: "2026-10-01",
      source_timezone: "UTC+08:00",
      raw_expression: "10月1日",
      time_basis: "deterministic_derived",
    } as typeof node.time;
    return route.fulfill({ json: data });
  });
  await page.goto("/events/evt_morning");
  const milestone = page.locator(`[data-milestone="${nodeId}"]`);
  await expect(milestone.locator(".milestone-status")).toContainText("按公告推算");
  await expect(milestone.locator(".evidence-box")).toContainText("原始时间表述：10月1日");
  await expect(milestone.locator(".evidence-box")).toContainText(
    "推导依据：原文未写年份，按同一公告里写明的日期（或所属版本已确认的更新时间）补全为 2026 年；年份不是官方直接写出的。",
  );
});

test("U05 详情失败保留副本；离线注明缓存时间；404 不显示旧事实", async ({ page, context }) => {
  await page.goto("/events/evt_morning");
  await expect(page.locator(".event-detail")).toBeVisible();
  await page.route("**/api/v2/events/evt_morning", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator(".data-warning")).toContainText("加载失败");
  await expect(page.locator("h1")).toHaveText("巡游拾光 · 城市探索挑战");
  await context.setOffline(true);
  await expect(page.locator("article .data-warning")).toContainText("离线");
  await expect(page.locator("article .data-warning")).toContainText("2026年9月22日 12:30");
  await context.setOffline(false);
  await page.route("**/api/v2/events/evt_morning", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.getByRole("button", { name: "重试加载" }).click();
  await expect(page.locator("#event-detail")).toContainText("当前发布代次没有此事件");
  await expect(page.locator(".event-detail")).toHaveCount(0);
});

test("U04 重新读取详情后只保留用户已展开的证据，不展开其他节点", async ({ page }) => {
  await page.goto("/events/evt_morning");
  await page.locator('[data-milestone="morning-end"] summary').click();
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator("#event-detail")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-milestone="morning-end"] details')).toHaveAttribute("open", "");
  await expect(page.locator('[data-milestone="morning"] details')).not.toHaveAttribute("open");
});

// P3-22（ADR-0014）：官方公告原文弹窗。数据来自本站保存的正文版本，浏览器端整理成可读文字。
test("A-P3-ARTICLE-VIEW 查看官方公告打开原文弹窗：整理成可读文字，不出现原始 HTML", async ({
  page,
}, info) => {
  const thirdParty: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "example.com") thirdParty.push(request.url());
  });
  await page.goto("/events/evt_morning");
  await page.getByRole("button", { name: "查看官方公告", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "官方公告原文" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".article-title")).toHaveText("「巡游拾光」城市探索挑战活动说明");
  await expect(dialog.locator(".article-facts")).toContainText("本站抓取于 2026年9月21日 18:30");
  await expect(dialog.locator(".article-facts")).toContainText("第 2 版");
  await expect(dialog.getByRole("link", { name: "官方数据源" })).toHaveAttribute(
    "href",
    "https://example.com/official-api",
  );
  const content = dialog.locator(".article-content");
  // 官方转义的时间标签只留时间；不出现标签、实体、样式或脚本字样。
  await expect(content).toContainText("2026/09/22 10:00 - 2026/09/29 03:59");
  await expect(content).toContainText("注：活动规则以游戏内说明为准 & 解释权归官方所有");
  const text = (await content.textContent()) ?? "";
  for (const raw of [
    "<t",
    "<p",
    "<span",
    "</",
    "&lt;",
    "&amp;",
    "t_gl",
    "style=",
    "javascript:",
    "__articleExecuted",
  ])
    expect(text).not.toContain(raw);
  // 结构保留：标题、列表、表格合并单元格、加粗、官方折叠段（原文默认收起）。
  await expect(content.locator("h4")).toHaveText("活动说明");
  await expect(content.locator("strong")).toHaveText("■参与条件");
  await expect(content.locator("ul > li")).toHaveText(["冒险等阶达到 20 级", "完成序章任务"]);
  await expect(content.locator('td[colspan="2"]')).toHaveText("阶段安排");
  await expect(content.locator('td[rowspan="2"]')).toHaveText("第一阶段");
  await expect(content.locator("table")).toContainText("奖励领取截止 2026/09/30 23:59");
  const reward = content.locator("details");
  await expect(reward.locator("summary")).toHaveText("奖励一览");
  await expect(reward).not.toHaveAttribute("open");
  await expect(reward.getByText("◇原石×60")).toBeHidden();
  await reward.locator("summary").click();
  await expect(reward).toHaveAttribute("open", "");
  await expect(reward.getByText("◇原石×60")).toBeVisible();
  // 游戏内链接取出真实网址；javascript: 链接只留文字；图片只给链接、不自动加载。
  const go = dialog.getByRole("link", { name: ">>点击前往活动页面<<" });
  await expect(go).toHaveAttribute("href", "https://example.com/event?a=1&b=2");
  await expect(go).toHaveAttribute("target", "_blank");
  await expect(go).toHaveAttribute("rel", "noopener noreferrer");
  await expect(content).toContainText("不安全的链接文字");
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "查看图片" })).toHaveAttribute(
    "href",
    "https://example.com/banner.jpg",
  );
  await expect(dialog.locator("img, script, iframe, style")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __articleExecuted?: number }).__articleExecuted,
    ),
  ).toBeUndefined();
  expect(thirdParty).toEqual([]);
  // 弹窗期间背景不可操作；Esc 关闭后焦点回到触发按钮。
  expect(
    await page.evaluate(() =>
      [...document.body.children]
        .filter((element) => element.id !== "article-dialog")
        .every((element) => (element as HTMLElement).inert),
    ),
  ).toBe(true);
  if (info.project.name.startsWith("mobile")) {
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
  const folder = resolve(
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/p3-22"
      : "tests/e2e/test-results/p3-22",
  );
  mkdirSync(folder, { recursive: true });
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  await page.screenshot({ path: `${folder}/${viewport}-article-dialog.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "查看官方公告", exact: true })).toBeFocused();
});

test("A-P3-ARTICLE-VIEW 侧栏也能打开原文；关闭按钮把焦点还给侧栏入口", async ({ page }) => {
  await page.goto("/events/evt_morning");
  const entry = page
    .locator('[data-section="official"]')
    .getByRole("button", { name: "阅读公告原文", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "官方公告原文" });
  await expect(dialog.locator(".article-content")).toContainText("城市探索");
  await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
});

test("A-P3-ARTICLE-VIEW 没有可确认的原文版本、读取失败与不完整版本都如实说明", async ({ page }) => {
  let mode: "empty" | "fail" | "gap" = "empty";
  await page.route("**/api/v2/events/evt_morning/articles", (route) => {
    const data = articlesFixture("evt_morning");
    if (!data) throw new Error("fixture missing");
    if (mode === "fail") return route.fulfill({ status: 503, json: {} });
    if (mode === "empty") data.articles = [];
    else
      data.articles = [
        {
          ...data.articles[0],
          // 合同的 z.url() 也接受 javascript:；网页只把 http/https 做成链接。
          officialUrl: "javascript:alert(1)",
          completeness: "gap-channel-unavailable",
          blocks: [{ kind: "title", text: "只有标题的资讯" }],
        },
      ];
    return route.fulfill({ json: data });
  });
  await page.goto("/events/evt_morning");
  const open = page.getByRole("button", { name: "查看官方公告", exact: true });
  const dialog = page.getByRole("dialog", { name: "官方公告原文" });
  await open.click();
  await expect(dialog).toContainText("暂时无法确认这个活动依据的公告原文版本");
  await expect(dialog.getByRole("link", { name: "打开官方数据源核对" })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  await page.keyboard.press("Escape");
  mode = "fail";
  await open.click();
  await expect(dialog).toContainText("原文没有读取成功");
  mode = "gap";
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog.locator(".article-title")).toHaveText("只有标题的资讯");
  await expect(dialog.locator(".article-gap")).toContainText("这个来源只提供公告列表，拿不到正文");
  await expect(dialog.locator(".article-content")).toHaveCount(0);
  await expect(dialog.locator("a")).toHaveCount(0);
});
