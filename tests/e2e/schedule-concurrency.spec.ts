import { expect, test } from "@playwright/test";
import { catalogFixture, clock, eventsFixture, mockPublicApi } from "./fixtures/public-schedule";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const ignoreAbort of [false, true]) {
  for (const selection of ["range", "games"] as const) {
    test(`U05 U06 限流期间切换 ${selection} 隔离旧${selection === "range" ? "首屏" : "续页"}，AbortSignal ${ignoreAbort ? "无法中止" : "正常中止"}`, async ({
      page,
    }) => {
      await mockPublicApi(page);
      // 假时钟 install 后会走动；从 clock 起装时负载高会让 pauseAt(clock) 落在过去而抛错。
      // 页面尚未加载、没有计时器，提前一分钟起装再停在 clock，之后状态与原写法相同。
      await page.clock.install({ time: clock.getTime() - 60_000 });
      await page.clock.pauseAt(clock);
      if (ignoreAbort)
        await page.addInitScript(() => {
          // 模拟无法取消的底层请求；必须由筛选 revision 隔离旧成功响应。
          AbortController.prototype.abort = () => {};
        });
      const old = deferred();
      const metadata = deferred();
      const eventCalls: { range: string | null; games: string | null; cursor: string | null }[] =
        [];
      let pending = false;
      let released = false;
      let catalogCalls = 0;
      const apiCalls: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url());
      });
      await page.route("**/api/v2/catalog", async (route) => {
        catalogCalls++;
        if (catalogCalls > 1) return route.fulfill({ json: catalogFixture() });
        await metadata.promise;
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
      });
      await page.route("**/api/v2/events?**", async (route) => {
        const params = new URL(route.request().url()).searchParams;
        eventCalls.push({
          range: params.get("range"),
          games: params.get("games"),
          cursor: params.get("cursor"),
        });
        const data = eventsFixture(params);
        const newSelection =
          selection === "range"
            ? params.get("range") === "7d"
            : !params.get("games")?.split(",").includes("genshin");
        if (newSelection) return route.fulfill({ json: data });
        if (selection === "games" && !params.has("cursor"))
          return route.fulfill({
            json: { ...data, nodes: [data.nodes[0]], nextCursor: "pending-old-page" },
          });
        pending = true;
        await old.promise;
        await route
          .fulfill({
            json: { ...data, nextCursor: selection === "range" ? null : "must-not-follow" },
          })
          .catch(() => {});
        released = true;
      });
      try {
        await page.goto("/");
        await expect.poll(() => pending).toBe(true);
        metadata.release();
        await expect(page.locator("#schedule-results")).toContainText("至少等待 2 秒");
        if (selection === "range") {
          // 时间范围在「筛选」弹层里（ADR-0017）。
          await page.locator("#more-filters-toggle").click();
          await page.getByRole("radio", { name: "近7天", exact: true }).check();
          await page.keyboard.press("Escape");
        } else await page.locator(".game-option").filter({ hasText: "原神" }).click();
        const callsAtSwitch = apiCalls.length;
        old.release();
        await expect.poll(() => released).toBe(true);
        // 等待已释放响应的消费与一次页面绘制，不能用过早的否定断言掩盖旧结果。
        await page.clock.runFor(32);
        await expect(page.locator(".load-row", { hasText: "已显示完" })).toHaveCount(0);
        await expect(page.locator("[data-node]")).toHaveCount(0);
        await expect(page.locator("#schedule-results")).toHaveAttribute("aria-busy", "false");
        const retry = page.getByRole("button", { name: "重试加载" });
        await expect(retry).toBeDisabled();
        expect(apiCalls).toHaveLength(callsAtSwitch);
        expect(eventCalls.some((call) => call.cursor === "must-not-follow")).toBe(false);
        await page.clock.fastForward(1235);
        await expect(retry).toBeEnabled();
        expect(apiCalls).toHaveLength(callsAtSwitch);
        await retry.click();
        await expect(page.locator(".load-row")).toContainText("已显示完");
        expect(eventCalls.at(-1)?.cursor).toBeNull();
        if (selection === "range") {
          expect(eventCalls.at(-1)?.range).toBe("7d");
          await expect(page.locator('[data-node="later"]')).toBeVisible();
        } else {
          expect(eventCalls.at(-1)?.games?.split(",")).not.toContain("genshin");
          await expect(page.locator('[data-node="morning"]')).toHaveCount(0);
          await expect(page.locator('[data-node="reward"]')).toBeVisible();
        }
      } finally {
        old.release();
        metadata.release();
      }
    });
  }
}

for (const mismatch of ["generation", "window"] as const) {
  test(`U05 HTTP 200 续页 ${mismatch} 不一致时清空并从首游标重读`, async ({ page }) => {
    await mockPublicApi(page);
    const restart = deferred();
    let firstCalls = 0;
    const cursors: (string | null)[] = [];
    await page.route("**/api/v2/events?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const data = eventsFixture(params);
      cursors.push(params.get("cursor"));
      if (params.has("cursor"))
        return route.fulfill({
          json: {
            ...data,
            publication: {
              ...data.publication,
              generation: data.publication.generation + (mismatch === "generation" ? 1 : 0),
            },
            window:
              mismatch === "window"
                ? { ...data.window, end: (data.window.end ?? data.window.start) + 1 }
                : data.window,
            nodes: [{ ...data.nodes[0], id: "must-drop" }],
          },
        });
      firstCalls++;
      if (firstCalls === 1)
        return route.fulfill({
          json: {
            ...data,
            nodes: [{ ...data.nodes[0], id: "old-first" }],
            nextCursor: "next",
          },
        });
      await restart.promise;
      return route.fulfill({ json: { ...data, nodes: [{ ...data.nodes[0], id: "current" }] } });
    });
    try {
      await page.goto("/");
      await expect.poll(() => firstCalls).toBe(2);
      await expect(page.locator('[data-node="old-first"], [data-node="must-drop"]')).toHaveCount(0);
      await expect(page.locator(".load-row", { hasText: "已显示完" })).toHaveCount(0);
      restart.release();
      await expect(page.locator(".load-row")).toContainText("已显示完");
      await expect(page.locator('[data-node="current"]')).toBeVisible();
      await expect(page.locator('[data-node="old-first"], [data-node="must-drop"]')).toHaveCount(0);
      expect(cursors).toEqual([null, "next", null]);
    } finally {
      restart.release();
    }
  });
}
