import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  CALENDAR_ALARMS_DEFAULT,
  type CalendarNodesResponse,
  type CalendarPreviewNode,
  CalendarPreviewNodeSchema,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  FEED_BASE_NODE_MAX,
  FEED_MAX_STALE,
  feedWindow,
  PUBLIC_CACHE_FRESH,
  REMINDER_RULES,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
  TimeValueSchema,
} from "../../packages/contracts/src";

// All API responses and screenshots are synthetic. Only API routes are intercepted.
const now = Date.UTC(2026, 9, 2, 12);
const rule = REMINDER_RULES.find((r) => r.event_type === "limited_event" && r.node_type === "end");
if (!rule) throw new Error("synthetic_rule_missing");
const selectedRule = rule;
function node(
  id: string,
  time: unknown = { precision: "datetime", utc_ms: now },
): CalendarPreviewNode {
  return CalendarPreviewNodeSchema.parse({
    game: "genshin",
    region: "CN",
    tombstone: false,
    patch: null,
    projection: {
      event_id: `synthetic-event-${id}`,
      milestone_id: id,
      event: {
        event_type: selectedRule.event_type,
        status: "scheduled",
        title: `合成活动 ${id}`,
        summary: null,
        official_url: null,
      },
      milestone: {
        milestone_key: id,
        node_type: selectedRule.node_type,
        title: "合成结束节点",
        time: {
          source_timezone: "UTC+8",
          raw_expression: "synthetic",
          time_basis: "official_explicit",
          ...(time as object),
        },
      },
    },
  });
}
function dataset(nodes = [node("exact")], generation = 1): CalendarNodesResponse {
  return {
    publication: { generation, publishedAt: now },
    asOf: now,
    window: feedWindow(now),
    cache: { generatedAt: now, freshUntil: now + PUBLIC_CACHE_FRESH * 1000, stale: false },
    sources: DEFAULT_SCOPE_GAMES.map((game) => ({
      sourceId: `synthetic-${game}`,
      game,
      region: "cn",
      lastSuccessAt: now,
    })),
    totals: { nodes: nodes.length },
    nodes,
    nextCursor: null,
  };
}
const config: SubscriptionConfig = {
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
const preview = (page: Page) => page.locator("#calendar-preview-content");
const item = (page: Page, id = "exact") => preview(page).locator(`[data-milestone="${id}"]`);
async function open(
  page: Page,
  respond: (route: Route, count: number) => Promise<void>,
  account = false,
) {
  await page.clock.setFixedTime(now);
  let count = 0;
  const privateWrites: string[] = [];
  let cloud = structuredClone(config);
  if (account)
    await page.context().addCookies([
      {
        name: "__Host-hoyo_csrf",
        value: "synthetic-csrf",
        domain: "127.0.0.1",
        path: "/",
        secure: true,
      },
    ]);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/v2/calendar/nodes") {
      expect(req.method()).toBe("GET");
      expect(req.headers().cookie).toBeUndefined();
      expect(req.headers()["x-csrf-token"]).toBeUndefined();
      expect([...url.searchParams.keys()].every((key) => key === "cursor")).toBe(true);
      return respond(route, ++count);
    }
    if (req.method() !== "GET") privateWrites.push(url.pathname);
    if (url.pathname === "/api/v2/me") return route.fulfill({ json: { user_id: "synthetic-a" } });
    if (url.pathname === "/api/v2/me/subscription") {
      if (req.method() === "PATCH")
        cloud = { ...req.postDataJSON().config, revision: cloud.revision + 1 };
      return route.fulfill({
        json: { state: "initialized", revision: cloud.revision, config: cloud },
      });
    }
    return route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } });
  });
  await page.goto("/subscription");
  await page.locator("#calendar-settings").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  return { count: () => count, privateWrites };
}
async function ready(page: Page) {
  await expect(preview(page)).toContainText("真实数据 · 完整");
  await expect(preview(page)).toContainText("未经验证的客户端不保证提醒可用");
}
async function selectRule(page: Page) {
  await page.locator(`input[name="rule_ids"][value="${selectedRule.rule_id}"]`).check();
  await page.locator('input[name="alarms_enabled"]').check();
}
async function screenshot(page: Page, name: string, project: string) {
  await preview(page).scrollIntoViewIfNeeded();
  const folder =
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f2-02"
      : "tests/e2e/test-results/f2-02";
  await mkdir(folder, { recursive: true });
  await preview(page).screenshot({ path: path.join(folder, `${name}-${project}.png`) });
}

for (const hidden of ["node", "event", "both"] as const) {
  test(`U07 U08 ${hidden} 隐藏仍由所选提醒引入，同一身份不重复`, async ({ page }, info) => {
    const mock = await open(page, (r) => r.fulfill({ json: dataset() }));
    await ready(page);
    await selectRule(page);
    if (hidden !== "event") await page.locator('input[name="node_types"][value="end"]').uncheck();
    if (hidden !== "node")
      await page.locator('input[name="event_types"][value="limited_event"]').uncheck();
    await expect(item(page)).toHaveCount(1);
    await expect(item(page)).toContainText("提醒关联节点");
    await expect(item(page)).toContainText(selectedRule.user_copy_zh);
    if (hidden !== "event") await expect(item(page)).toContainText("节点类型已隐藏");
    if (hidden !== "node") await expect(item(page)).toContainText("事件类型已隐藏");
    await expect(item(page)).toContainText("日历闹钟");
    await screenshot(page, `hidden-${hidden}`, info.project.name);
    await page.locator('input[name="alarms_enabled"]').uncheck();
    await expect(item(page)).toHaveCount(0);
    await expect(
      page.locator(`input[name="rule_ids"][value="${selectedRule.rule_id}"]`),
    ).toBeChecked();
    expect(mock.count()).toBe(1);
    expect(mock.privateWrites).toEqual([]);
  });
}

test("U07 基础与规则同时命中只出现一次，关闭提醒保留基础节点", async ({ page }) => {
  await open(page, (r) => r.fulfill({ json: dataset() }));
  await ready(page);
  await selectRule(page);
  await expect(item(page)).toHaveCount(1);
  await expect(item(page)).toContainText("基础显示节点");
  await expect(item(page)).not.toContainText("提醒关联节点");
  await page.locator('input[name="alarms_enabled"]').uncheck();
  await expect(item(page)).toHaveCount(1);
  await expect(item(page)).toContainText("无闹钟：日历提醒未开启");
});

test("U07 U21 未知补集只计省略；日期与预计无闹钟，隐藏后省略计数", async ({ page }, info) => {
  const nodes = [
    node("date", { precision: "date", date: "2026-10-02" }),
    node("estimate", { precision: "datetime", utc_ms: now, time_basis: "official_estimate" }),
    node("unknown", { precision: "unknown", time_basis: "unresolved" }),
    node("exact"),
  ];
  await open(page, (r) => r.fulfill({ json: dataset(nodes) }));
  await ready(page);
  await selectRule(page);
  await expect(preview(page).locator("[data-milestone]")).toHaveCount(3);
  await expect(preview(page)).toContainText("时间待定 1 条");
  await expect(item(page, "date")).toContainText("无闹钟：只有日期");
  await expect(item(page, "date")).not.toContainText("00:00");
  await expect(item(page, "estimate")).toContainText("预计或未确定时间");
  expect(
    await preview(page)
      .locator("[data-milestone]")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-milestone"))),
  ).toEqual(["estimate", "exact", "date"]);
  await screenshot(page, "precision", info.project.name);
  await page.locator('input[name="node_types"][value="end"]').uncheck();
  await expect(preview(page).locator("[data-milestone]")).toHaveCount(1);
  await expect(preview(page)).toContainText("没有精确时间 2 条");
  await expect(preview(page)).toContainText("时间待定 1 条");
});

test("U21 更正保留事实原因、旧时间与跨窗口新时间，注入文本不执行", async ({ page }, info) => {
  const nodes = ["cancelled", "retracted", "deleted", "postponed_unknown", "rescheduled"].map(
    (kind) => {
      const n = node(kind);
      const oldTime = n.projection.milestone.time;
      const newTime =
        kind === "rescheduled"
          ? TimeValueSchema.parse({ ...oldTime, utc_ms: feedWindow(now).end + 1 })
          : oldTime;
      n.patch = {
        kind: kind as NonNullable<CalendarPreviewNode["patch"]>["kind"],
        fact_reason: `合成事实 ${kind} <img src=x onerror=alert(1)>`,
        extends_window: true,
        display_time: newTime,
        old_time: oldTime,
        new_time: null,
        retain_until: now + PUBLIC_CACHE_FRESH * 1000,
      };
      if (kind === "deleted") n.tombstone = true;
      if (kind === "cancelled" || kind === "retracted") n.projection.event.status = kind;
      if (kind === "postponed_unknown")
        n.projection.milestone.time = TimeValueSchema.parse({
          precision: "unknown",
          time_basis: "unresolved",
          source_timezone: "UTC",
          raw_expression: "synthetic",
        });
      return n;
    },
  );
  await open(page, (r) => r.fulfill({ json: dataset(nodes) }));
  await ready(page);
  await selectRule(page);
  await expect(preview(page).locator(".is-correction")).toHaveCount(nodes.length);
  for (const id of ["cancelled", "retracted", "deleted", "postponed_unknown"]) {
    await expect(item(page, id)).toContainText("日历标记为已取消");
    await expect(item(page, id)).toContainText("无闹钟");
    await expect(item(page, id)).toContainText(`合成事实 ${id}`);
  }
  await expect(item(page, "rescheduled")).toContainText("不计入基础窗口条目");
  await expect(preview(page)).toContainText("时间待定 0 条");
  await expect(preview(page).locator("img")).toHaveCount(0);
  await screenshot(page, "corrections", info.project.name);
});

test("U21 分页未完不渲染部分日历，409 整份丢弃并绕缓存重取", async ({ page }) => {
  const a = dataset([node("old")]);
  a.totals.nodes = 2;
  a.nextCursor = "synthetic-cursor";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await open(page, async (r, count) => {
    if (count === 1) return r.fulfill({ json: a });
    if (count === 2) {
      await gate;
      return r.fulfill({ status: 409, json: { error: "conflict" } });
    }
    expect(new URL(r.request().url()).search).toBe("");
    expect(r.request().headers()["cache-control"]).toBe("no-cache");
    return r.fulfill({ json: dataset([node("new")], 2) });
  });
  await expect(preview(page)).toContainText("已下载 1 / 2");
  await expect(preview(page)).not.toContainText("真实数据 · 完整");
  await expect(item(page, "old")).toHaveCount(0);
  release();
  await ready(page);
  await expect(item(page, "new")).toHaveCount(1);
  await expect(item(page, "old")).toHaveCount(0);
  expect(mock.count()).toBe(3);
});

for (const mismatch of [
  "generation",
  "asOf",
  "window",
  "total",
  "schema",
  "duplicate",
  "cursor",
  "sources",
  "cache",
] as const) {
  test(`U21 拒绝 ${mismatch} 损坏或跨快照响应，不伪造空日历或样例`, async ({ page }) => {
    const first = dataset([node("first")]);
    first.totals.nodes = 2;
    first.nextCursor = "synthetic-cursor";
    const second = dataset([node("second")]);
    second.totals.nodes = 2;
    if (mismatch === "generation") second.publication.generation++;
    if (mismatch === "asOf") second.asOf--;
    if (mismatch === "window") second.window.end++;
    if (mismatch === "total") second.totals.nodes++;
    if (mismatch === "schema") Object.assign(second, { internal: true });
    if (mismatch === "duplicate") second.nodes = first.nodes;
    if (mismatch === "cursor") second.nextCursor = first.nextCursor;
    if (mismatch === "sources") second.sources = [];
    if (mismatch === "cache") second.cache.stale = true;
    await open(page, (r, c) => r.fulfill({ json: c === 1 ? first : second }));
    await expect(preview(page)).toContainText("未通过完整性校验");
    await expect(preview(page)).not.toContainText("真实数据 · 完整");
    await expect(preview(page)).not.toContainText("样例预览");
    await expect(preview(page).locator("[data-milestone]")).toHaveCount(0);
  });
}

for (const failure of ["503", "offline"] as const) {
  test(`U21 ${failure} 失败明确降级合成样例，重试可恢复真实数据`, async ({ page }, info) => {
    await open(page, (r, count) =>
      count > 1
        ? r.fulfill({ json: dataset() })
        : failure === "offline"
          ? r.abort()
          : r.fulfill({ status: 503, json: {} }),
    );
    await expect(preview(page)).toContainText("样例预览（合成）");
    await expect(preview(page)).toContainText("未保存草稿");
    await expect(preview(page)).not.toContainText("真实数据 · 完整");
    await screenshot(page, failure, info.project.name);
    await preview(page).getByRole("button", { name: "刷新预览数据" }).click();
    await ready(page);
    await expect(preview(page)).not.toContainText("样例活动");
  });
}

test("U21 超限和来源过期显示不完整；unknownTime 不占条目上限", async ({ page }) => {
  const unknown = Array.from({ length: FEED_BASE_NODE_MAX + 1 }, (_, i) =>
    node(`unknown-${i}`, { precision: "unknown", time_basis: "unresolved" }),
  );
  const fresh = dataset([node("exact"), ...unknown]);
  const stale = dataset();
  stale.sources.forEach((s) => {
    s.lastSuccessAt = now - FEED_MAX_STALE * 1000 - 1;
  });
  const limit = dataset(
    Array.from({ length: FEED_BASE_NODE_MAX + 1 }, (_, i) => node(`limit-${i}`)),
  );
  await open(page, (r, count) =>
    r.fulfill({ json: count === 1 ? fresh : count === 2 ? stale : limit }),
  );
  await ready(page);
  await expect(preview(page)).toContainText(`时间待定 ${unknown.length} 条`);
  await expect(preview(page).locator("[data-milestone]")).toHaveCount(1);
  await preview(page).getByRole("button", { name: "刷新预览数据" }).click();
  await expect(preview(page)).toContainText("成功核验水位已过期");
  await expect(preview(page)).not.toContainText("真实数据 · 完整");
  await preview(page).getByRole("button", { name: "刷新预览数据" }).click();
  await expect(preview(page)).toContainText("基础节点超过上限");
});

test("U07 U21 下载期间改变草稿只按新配置计算，不重复请求", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await open(page, async (r) => {
    await gate;
    await r.fulfill({ json: dataset() });
  });
  await expect(preview(page)).toContainText("正在更新");
  await page.locator('input[name="alarms_enabled"]').uncheck();
  await page.locator('input[name="node_types"][value="end"]').uncheck();
  release();
  await ready(page);
  await expect(item(page)).toHaveCount(0);
  expect(mock.count()).toBe(1);
});

test("U21 已保存与草稿区分，保存后更新；读取公开数据不带会话，不启用通道", async ({ page }) => {
  const mock = await open(page, (r) => r.fulfill({ json: dataset() }), true);
  await ready(page);
  await expect(preview(page)).toContainText("已保存设置 · 版本 1");
  await page.locator('input[name="node_types"][value="end"]').uncheck();
  await expect(preview(page)).toContainText("未保存草稿");
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await expect(preview(page)).toContainText("已保存设置 · 版本 2");
  expect(mock.privateWrites).toEqual(["/api/v2/me/subscription"]);
  expect(mock.count()).toBe(1);
});

test("U21 身份失效清除已保存预览，迟到的旧请求不能恢复旧内容", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await open(
    page,
    async (r, count) => {
      if (count === 1) {
        await gate;
        await r.fulfill({ json: dataset([node("old")]) });
      } else await r.fulfill({ json: dataset([node("new")], 2) });
    },
    true,
  );
  await expect(preview(page)).toContainText("已保存设置");
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
    ),
  );
  await expect(preview(page)).toContainText("身份待确认");
  release();
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", {
        detail: { status: "confirmed", userId: "synthetic-b" },
      }),
    ),
  );
  await ready(page);
  await expect(item(page, "new")).toHaveCount(1);
  await expect(item(page, "old")).toHaveCount(0);
  expect(mock.privateWrites).toEqual([]);
});

test("U21 成功读取全部页后才展示全量；真实零匹配才能显示空日历", async ({ page }) => {
  const first = dataset([node("first")]);
  first.totals.nodes = 2;
  first.nextCursor = "synthetic-next";
  const second = dataset([node("second")]);
  second.totals.nodes = 2;
  const mock = await open(page, (r, count) =>
    r.fulfill({ json: count === 1 ? first : count === 2 ? second : dataset([]) }),
  );
  await ready(page);
  await expect(preview(page).locator("[data-milestone]")).toHaveCount(2);
  expect(mock.count()).toBe(2);
  await preview(page).getByRole("button", { name: "刷新预览数据" }).click();
  await expect(preview(page)).toContainText("真实数据中没有符合这份设置");
  await expect(preview(page)).toContainText("真实数据 · 完整");
  await expect(preview(page)).toContainText("未经验证的客户端不保证提醒可用");
});

test("U21 连续跨代中止重试，诊断不冒充样例或空日历", async ({ page }) => {
  const mock = await open(page, (r) => r.fulfill({ status: 409, json: {} }));
  await expect(preview(page)).toContainText("未通过完整性校验");
  await expect(preview(page)).not.toContainText("样例预览");
  expect(mock.count()).toBe(2);
});

test("U21 不跟随公开节点 API 重定向", async ({ page }) => {
  const redirected: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("unexpected-redirect")) redirected.push(request.url());
  });
  const mock = await open(page, (r) =>
    r.fulfill({ status: 302, headers: { location: "/api/unexpected-redirect" } }),
  );
  await expect(preview(page)).toContainText("真实数据暂时取不到");
  expect(mock.count()).toBe(1);
  expect(mock.privateWrites).toEqual([]);
  expect(redirected).toEqual([]);
});

test("U21 更新期间旧结果标记不完整，新代整份替换", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(page, async (r, count) => {
    if (count > 1) await gate;
    await r.fulfill({ json: dataset([node(count === 1 ? "old" : "new")], count) });
  });
  await ready(page);
  await preview(page).getByRole("button", { name: "刷新预览数据" }).click();
  await expect(preview(page)).toContainText("不完整 · 正在更新");
  await expect(item(page, "old")).toHaveCount(1);
  await expect(preview(page)).not.toContainText("真实数据 · 完整");
  release();
  await ready(page);
  await expect(item(page, "old")).toHaveCount(0);
  await expect(item(page, "new")).toHaveCount(1);
});

test("U21 无法取消的旧身份响应晚于新身份返回，仍不得覆盖新预览", async ({ page }) => {
  await page.addInitScript(() => {
    AbortController.prototype.abort = () => {};
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(
    page,
    async (route, count) => {
      if (count === 1) await gate;
      await route.fulfill({ json: dataset([node(count === 1 ? "old" : "new")], count) });
    },
    true,
  );
  await expect(preview(page)).toContainText("已保存设置");
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", {
        detail: { status: "confirmed", userId: "synthetic-b" },
      }),
    ),
  );
  await ready(page);
  await expect(item(page, "new")).toHaveCount(1);
  const consumed = page.waitForResponse((response) =>
    response.url().endsWith("/api/v2/calendar/nodes"),
  );
  release();
  const response = await consumed;
  await response.finished();
  // Let the released response's promise continuations and rendering finish before negative assertions.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(item(page, "old")).toHaveCount(0);
  await expect(item(page, "new")).toHaveCount(1);
  await expect(preview(page)).toContainText("发布代次 2");
});

test("U21 到达注册表新鲜期后重新获取整份数据", async ({ page }) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const mock = await open(page, async (r, count) => {
    const data = dataset([node(count === 1 ? "old" : "new")], count);
    if (count > 1) {
      data.asOf = now + PUBLIC_CACHE_FRESH * 1000;
      data.window = feedWindow(data.asOf);
      data.cache.generatedAt = data.asOf;
      data.cache.freshUntil = data.asOf + PUBLIC_CACHE_FRESH * 1000;
    }
    await r.fulfill({ json: data });
  });
  await ready(page);
  await page.clock.setSystemTime(now);
  await page.clock.runFor(PUBLIC_CACHE_FRESH * 1000);
  await expect(item(page, "new")).toHaveCount(1);
  await expect(item(page, "old")).toHaveCount(0);
  expect(mock.count()).toBe(2);
});
