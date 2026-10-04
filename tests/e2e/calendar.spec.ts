import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  syntheticAccount,
  syntheticConfig,
  syntheticPreview,
  syntheticView,
} from "../../apps/web/src/features/channels/calendar/testing/fixtures";
import { buildApiErrorBody, CalendarPreviewResponseSchema } from "../../packages/contracts/src";

test.use({ trace: "off" }); // Never retain private API response URLs in traces.
const part = (page: Page, name: string) => page.locator(`[data-calendar="${name}"]`);
const channel = (page: Page) => page.locator("#calendar-channel");
async function open(
  page: Page,
  options: {
    account?: ReturnType<typeof syntheticAccount>;
    view?: ReturnType<typeof syntheticView>;
    preview?: (route: Route, calls: number) => Promise<void>;
    write?: (route: Route, calls: number) => Promise<void>;
  } = {},
) {
  let config = structuredClone(syntheticConfig);
  const account = options.account ?? syntheticAccount();
  const view = options.view ?? syntheticView();
  const writes: { body: Record<string, unknown>; key: string; action: string }[] = [];
  let previews = 0,
    saves = 0,
    renewals = 0;
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/v2/me", (route) => route.fulfill({ json: account }));
  await page.route("**/api/v2/auth/renew", (route) => {
    renewals++;
    return route.fulfill({ json: { renewed: false } });
  });
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "PATCH") {
      saves++;
      const body = route.request().postDataJSON();
      config = { ...body.config, revision: config.revision + 1 };
      view.configuration.revision = config.revision;
      view.configuration.alarms_enabled = config.calendar.alarms_enabled;
    }
    await route.fulfill({
      json: {
        state: "initialized",
        revision: config.revision,
        config,
        ...(route.request().method() === "PATCH" ? { saved: true } : {}),
      },
    });
  });
  await page.route("**/api/v2/me/calendar", (route) => route.fulfill({ json: view }));
  await page.route("**/api/v2/me/calendar/preview*", (route) => {
    previews++;
    return options.preview
      ? options.preview(route, previews)
      : route.fulfill({ json: syntheticPreview(config) });
  });
  await page.route(/\/api\/v2\/me\/calendar\/(enable|disable|reset)$/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1) as string;
    writes.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
      action,
    });
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-csrf");
    if (options.write) return options.write(route, writes.length);
    view.token_generation++;
    view.address_state = action === "disable" ? "disabled" : "enabled";
    await route.fulfill({
      json: {
        changed: true,
        token_generation: view.token_generation,
        address_state: view.address_state,
      },
    });
  });
  await page.goto("/subscription");
  // 面板挂载即只读读取 /me、/me/calendar（及公开 /status），不再需要先点刷新；
  // 链接状态只会在读取成功、忙碌结束后从「未知」变为具体状态。
  await expect(part(page, "address")).toHaveText(/^(未启用|有效|已停用)/);
  await expect(channel(page)).toHaveAttribute("aria-busy", "false");
  return {
    view,
    writes,
    account,
    previews: () => previews,
    saves: () => saves,
    renewals: () => renewals,
  };
}
async function confirm(page: Page) {
  // 同意勾选框已移除：完整服务端预览后出现的「确认启用」，必须由用户显式点击。
  await expect(part(page, "confirm")).toBeVisible();
  await part(page, "confirm").click();
}
async function openManage(page: Page) {
  await part(page, "manage").locator("summary").click();
  await expect(part(page, "manage")).toHaveAttribute("open", "");
}
/** 身份失效后整个面板卸载：不再有任何日历钩子（预览、确认、地址事实）。 */
async function expectPanelCleared(page: Page) {
  await expect(channel(page).locator("[data-calendar]")).toHaveCount(0);
  await expect(channel(page)).not.toContainText("合成活动");
}
/** 让迟到响应的后续 Promise 与渲染跑完，再做否定断言。 */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function evidence(page: Page, name: string) {
  const target =
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? path.join("tests/e2e/evidence/f3-04", `${test.info().project.name}-${name}.png`)
      : test.info().outputPath(`${name}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  await page.locator("#calendar-channel").screenshot({ path: target });
}
test("U20 首次完整服务端预览、关联节点、三个版本与显式续期", async ({ page }) => {
  const run = await open(page);
  expect(run.previews()).toBe(0);
  expect(run.renewals()).toBe(0);
  await part(page, "begin").click();
  await expect(part(page, "preview")).toContainText("完整预览");
  await expect(part(page, "preview")).toContainText("提醒关联节点");
  await expect(part(page, "preview")).toContainText("事件类型已隐藏、节点类型已隐藏");
  expect(run.writes).toHaveLength(0);
  await evidence(page, "saved-confirmation");
  await confirm(page);
  await expect(part(page, "address")).toContainText("日历订阅地址已创建");
  expect(run.writes[0].body).toEqual({
    confirmed: true,
    expected_generation: 7,
    expected_revision: 4,
    publication_generation: 31,
  });
  await expect.poll(run.renewals).toBe(1);
  // 原四个状态分区改为一组事实（dl）；启用成功也不冒充日历应用已拉取。
  const facts = channel(page).locator("dl");
  for (const label of ["链接状态", "使用的设置", "内容输出", "日历应用拉取"])
    await expect(facts.getByText(label, { exact: true })).toBeVisible();
  await expect(part(page, "polling")).toHaveText("还没有日历应用拉取过");
  await evidence(page, "enabled-states");
});
for (const save of [false, true])
  test(`U11 未保存草稿：${save ? "保存后继续" : "使用已保存设置"}`, async ({ page }) => {
    const run = await open(page);
    await page.locator('input[name="games"][value="hsr"]').check();
    await part(page, "begin").click();
    await expect(part(page, "draft")).toBeVisible();
    expect(run.previews()).toBe(0);
    await part(page, save ? "save" : "saved").click();
    await expect(part(page, "preview")).toContainText(`已保存的第 ${save ? 5 : 4} 版设置`);
    await expect.poll(run.renewals).toBe(save ? 1 : 0);
    await confirm(page);
    await expect(part(page, "address")).toContainText("有效");
    expect(run.saves()).toBe(save ? 1 : 0);
    expect(run.writes[0].body.expected_revision).toBe(save ? 5 : 4);
    await expect.poll(run.renewals).toBe(save ? 2 : 1);
  });
test("U20 续页先429后恢复，取全之前不允许启用", async ({ page }) => {
  const preview = syntheticPreview();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await open(page, {
    preview: async (route, calls) => {
      if (calls === 1)
        return route.fulfill({
          json: {
            ...preview,
            totals: { ...preview.totals, items: 2 },
            nextCursor: "synthetic-cursor",
          },
        });
      expect(new URL(route.request().url()).searchParams.get("cursor")).toBe("synthetic-cursor");
      if (calls === 2)
        return route.fulfill({
          status: 429,
          json: buildApiErrorBody("rate_limited", { code: "rate_limited", retry_after_ms: 80 }),
        });
      await held;
      await route.fulfill({
        json: {
          ...preview,
          totals: { ...preview.totals, items: 2 },
          items: preview.items.map((item) => ({ ...item, milestoneId: "synthetic-second" })),
        },
      });
    },
  });
  await part(page, "begin").click();
  await expect(part(page, "message")).toContainText("请求频率受限");
  await expect(part(page, "confirmation")).toBeHidden();
  await expect(part(page, "confirm")).toBeHidden();
  expect(run.writes).toHaveLength(0);
  release?.();
  await expect(part(page, "preview")).toContainText("完整预览");
  await confirm(page);
  await expect(part(page, "address")).toContainText("有效");
  expect(run.previews()).toBe(3);
});
test("U20 preview_outdated 丢弃整轮且再次确认，不自动启用", async ({ page }) => {
  const run = await open(page, {
    write: async (route) =>
      route.fulfill({
        status: 409,
        json: buildApiErrorBody("conflict", { code: "conflict", reason: "preview_outdated" }),
      }),
  });
  await part(page, "begin").click();
  await confirm(page);
  await expect.poll(run.previews).toBe(2);
  // 没有同意勾选框可清空：整轮重新预览后只回到「待用户再次点击确认」，不自动启用。
  await expect(part(page, "preview")).toContainText("完整预览");
  await expect(channel(page)).toHaveAttribute("aria-busy", "false");
  await expect(part(page, "message")).toContainText("请确认下面的日历内容");
  await expect(part(page, "confirm")).toBeVisible();
  expect(run.writes).toHaveLength(1);
});
test("U20 ADR-0008 巨大blocked重复过期停止自动刷新并提示缩小范围", async ({ page }) => {
  const preview = syntheticPreview();
  const run = await open(page, {
    preview: async (route, calls) => {
      if (calls % 2)
        return route.fulfill({
          json: {
            ...preview,
            outcome: "blocked",
            diagnostic: "base_node_limit",
            totals: { ...preview.totals, items: 999999 },
            nextCursor: "synthetic-cursor",
          },
        });
      return route.fulfill({
        status: 409,
        json: buildApiErrorBody("conflict", { code: "conflict", reason: "preview_outdated" }),
      });
    },
  });
  await part(page, "begin").click();
  await expect(part(page, "message")).toContainText("已停止自动重取");
  await expect(part(page, "message")).toContainText("缩小范围");
  expect(run.previews()).toBe(4);
  await expect(part(page, "confirmation")).toBeHidden();
  await expect(part(page, "confirm")).toBeHidden();
  await expect(part(page, "preview")).not.toContainText("完整预览");
});
for (const shape of ["blocked", "missing", "empty_cursor"] as const)
  test(`U20 不完整预览拒绝启用：${shape}`, async ({ page }) => {
    const preview = syntheticPreview();
    await open(page, {
      preview: async (route) =>
        route.fulfill({
          json:
            shape === "blocked"
              ? { ...preview, outcome: "blocked", diagnostic: "source_stale" }
              : shape === "missing"
                ? { ...preview, items: [] }
                : { ...preview, items: [], nextCursor: "same" },
        }),
    });
    await part(page, "begin").click();
    await expect(page.locator("#calendar-channel")).toHaveAttribute("aria-busy", "false");
    await expect(part(page, "confirmation")).toBeHidden();
    await expect(part(page, "confirm")).toBeHidden();
    await expect(part(page, "confirm")).toBeDisabled();
  });
test("U21a 守卫拦截保留地址，显示上次成功输出及联系重试", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  view.output = {
    state: "integrity_blocked",
    diagnostic: "shrink_guard",
    last_output_at: 1900000001000,
    last_served_at: 1900000000000,
    last_served_node_count: 48,
    last_guard_blocked_at: 1900000001000,
  };
  const run = await open(page, { view });
  await expect(part(page, "output")).toContainText("已暂停更新以保护你现有的日历内容");
  await expect(part(page, "last-output")).toContainText("48");
  await expect(part(page, "address")).toContainText("有效");
  await expect(part(page, "guard")).toBeVisible();
  await expect(part(page, "guard")).toContainText("不要重置链接或重新订阅");
  await expect(
    part(page, "guard").getByRole("link", { name: "反馈问题", exact: false }),
  ).toBeVisible();
  await part(page, "refresh").click();
  await expect(part(page, "message")).toContainText("已刷新日历状态");
  expect(run.writes).toHaveLength(0);
  expect(run.renewals()).toBe(0);
  await evidence(page, "integrity-blocked");
});
test("U20 重置响应丢失保留原键与代次，不生成第二次重置", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  const run = await open(page, {
    view,
    write: async (route, calls) => {
      if (calls === 1) {
        view.token_generation++;
        return route.abort();
      }
      return route.fulfill({
        json: { changed: true, address_state: "enabled", token_generation: view.token_generation },
      });
    },
  });
  page.on("dialog", (dialog) => dialog.accept());
  await openManage(page);
  await part(page, "reset").click();
  await expect(part(page, "message")).toContainText("操作结果暂时不确定");
  await expect(part(page, "reset")).toBeDisabled();
  await part(page, "retry").click();
  await expect(part(page, "message")).toContainText("已生成新的订阅链接");
  expect(run.writes[0]).toEqual(run.writes[1]);
  expect(view.token_generation).toBe(8);
  await expect.poll(run.renewals).toBe(1);
});
test("U20 停用不受草稿阻挡，再启用必须重新预览", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  const run = await open(page, { view });
  await page.locator('input[name="games"][value="hsr"]').check();
  page.on("dialog", (dialog) => dialog.accept());
  await openManage(page);
  await part(page, "disable").click();
  await expect(part(page, "address")).toContainText("已停用");
  expect(run.saves()).toBe(0);
  await part(page, "begin").click();
  await part(page, "saved").click();
  await confirm(page);
  await expect(part(page, "address")).toContainText("有效");
  expect(run.previews()).toBe(1);
  expect(run.writes[1].body.expected_generation).toBe(8);
});
for (const reason of ["unsaved-code", "restricted"])
  test(`U20 恢复码准入 ${reason}`, async ({ page }) => {
    const account = syntheticAccount();
    account.recovery_code_saved = false;
    account.session.recovery_code_required = reason === "restricted";
    const run = await open(page, { account });
    await expect(part(page, "begin")).toBeDisabled();
    await expect(part(page, "recovery")).toBeVisible();
    expect(run.previews()).toBe(0);
  });
test("U20 身份失效清除预览并丢弃迟到响应", async ({ page }) => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let responded: Promise<void> | undefined;
  const run = await open(page, {
    preview: (route) => {
      responded = wait.then(() => route.fulfill({ json: syntheticPreview() }).catch(() => {}));
      return responded;
    },
  });
  await part(page, "begin").click();
  await expect.poll(run.previews).toBe(1);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
    ),
  );
  await expectPanelCleared(page);
  release?.();
  await responded;
  await settle(page);
  // 迟到的预览响应不能把已卸载的面板、预览或确认按钮恢复出来。
  await expectPanelCleared(page);
  expect(run.renewals()).toBe(0);
  expect(run.writes).toHaveLength(0);
});
test("U20 关闭日历提醒走保存状态机，地址不变且不清规则", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  const run = await open(page, { view });
  page.on("dialog", (dialog) => dialog.accept());
  await openManage(page);
  await part(page, "alarms").click();
  await expect(part(page, "config")).toContainText("日历提醒已关闭");
  await expect(page.locator("#save-result")).toContainText("链接保持不变");
  await expect(page.locator('input[name="rule_ids"][value="limited_end_1d"]')).toBeChecked();
  expect(run.writes).toHaveLength(0);
  expect(run.saves()).toBe(1);
  await expect.poll(run.renewals).toBe(1);
  await part(page, "refresh").click();
  // 刷新文案不再写「没有提交变更」；改由网络计数证明刷新只读。
  await expect(part(page, "message")).toContainText("已刷新日历状态");
  expect(run.renewals()).toBe(1);
  expect(run.saves()).toBe(1);
  expect(run.writes).toHaveLength(0);
});

test("U20 按需复制地址，不入页面和偏好、不续期、不冒充客户端已添加", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  view.url = `https://example.invalid/feeds/u/${crypto.randomUUID()}.ics`;
  const run = await open(page, { view });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
    });
  });
  await part(page, "copy").click();
  await expect(part(page, "message")).toContainText("链接已复制");
  // 新文案不再附「不等于外部客户端已添加」；改为确认复制不改写客户端拉取事实、也不声称已添加。
  await expect(part(page, "message")).not.toContainText("已添加");
  await expect(part(page, "polling")).toHaveText("还没有日历应用拉取过");
  // 复制成功时手动复制框保持隐藏且为空，地址不落入页面。
  await expect(part(page, "manual")).toBeHidden();
  await expect(part(page, "manual-input")).toHaveValue("");
  expect(await page.evaluate(() => document.body.innerHTML.includes("/feeds/u/"))).toBe(false);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("/feeds/u/")),
  ).toBe(false);
  expect(run.renewals()).toBe(0);
  expect(run.writes).toHaveLength(0);
});

test("U20 剪贴板不可用时给出手动复制框：点击后才填入、聚焦全选，不入存储、身份失效即清除", async ({
  page,
}) => {
  const view = syntheticView();
  view.address_state = "enabled";
  view.url = `https://example.invalid/feeds/u/${crypto.randomUUID()}.ics`;
  const run = await open(page, { view });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => Promise.reject(new Error("synthetic clipboard denied")) },
      configurable: true,
    });
  });
  await expect(part(page, "manual")).toBeHidden();
  await expect(part(page, "manual-input")).toHaveValue("");
  await part(page, "copy").click();
  await expect(part(page, "message")).toContainText("无法自动复制");
  await expect(part(page, "manual")).toBeVisible();
  await expect(part(page, "manual-input")).toHaveValue(view.url);
  await expect(part(page, "manual-input")).toBeFocused();
  expect(
    await part(page, "manual-input").evaluate(
      (input: HTMLInputElement) =>
        input.selectionStart === 0 && input.selectionEnd === input.value.length,
    ),
  ).toBe(true);
  // 地址只作为输入框的值，不写进标记、本机存储或偏好；也不冒充复制成功。
  await expect(part(page, "message")).not.toContainText("已复制");
  expect(await page.evaluate(() => document.body.innerHTML.includes("/feeds/u/"))).toBe(false);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("/feeds/u/")),
  ).toBe(false);
  expect(run.renewals()).toBe(0);
  expect(run.writes).toHaveLength(0);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
    ),
  );
  await expectPanelCleared(page);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll("input")].some((input) => input.value.includes("/feeds/u/")),
    ),
  ).toBe(false);
});
test("U20 首屏429也按错误体等待重试，不把空白当完整", async ({ page }) => {
  const run = await open(page, {
    preview: (route, calls) =>
      calls === 1
        ? route.fulfill({
            status: 429,
            json: buildApiErrorBody("rate_limited", { code: "rate_limited", retry_after_ms: 80 }),
          })
        : route.fulfill({ json: syntheticPreview() }),
  });
  await part(page, "begin").click();
  await expect(part(page, "preview")).toContainText("完整预览");
  expect(run.previews()).toBe(2);
  expect(run.writes).toHaveLength(0);
});
test("U20 服务端身份失效清除私人状态，不续期", async ({ page }) => {
  const run = await open(page);
  await page.route("**/api/v2/me/calendar/preview", (route) =>
    route.fulfill({
      status: 401,
      json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "session_expired" }),
    }),
  );
  await part(page, "begin").click();
  await expectPanelCleared(page);
  expect(run.renewals()).toBe(0);
  expect(run.writes).toHaveLength(0);
});
test("U20 旧重置被后续操作替代时只核对状态，不重新换证", async ({ page }) => {
  const view = syntheticView();
  view.address_state = "enabled";
  const run = await open(page, {
    view,
    write: (route) => {
      view.token_generation += 2;
      return route.fulfill({ status: 409, json: buildApiErrorBody("conflict") });
    },
  });
  page.on("dialog", (dialog) => dialog.accept());
  await openManage(page);
  await part(page, "reset").click();
  await expect(page.locator("#calendar-channel")).toHaveAttribute("aria-busy", "false");
  await expect(part(page, "retry")).toBeHidden();
  expect(run.writes).toHaveLength(1);
  expect(run.renewals()).toBe(0);
});

test("U20 管理返回畸形成功体保持未知且不续期", async ({ page }) => {
  const run = await open(page, {
    write: (route) =>
      route.fulfill({ json: { token_generation: "invalid", address_state: "enabled" } }),
  });
  await part(page, "begin").click();
  await confirm(page);
  await expect(part(page, "message")).toContainText("操作结果暂时不确定");
  await expect(part(page, "retry")).toBeVisible();
  expect(run.renewals()).toBe(0);
});
test("U11 保存冲突不续期、不预览、不启用", async ({ page }) => {
  const run = await open(page);
  const config = { ...syntheticConfig, revision: syntheticConfig.revision + 1 };
  await page.route("**/api/v2/me/subscription", (route) =>
    route.fulfill({
      status: 409,
      json: {
        ...buildApiErrorBody("conflict"),
        current: { state: "initialized", revision: config.revision, config },
      },
    }),
  );
  await page.locator('input[name="games"][value="hsr"]').check();
  await part(page, "begin").click();
  await part(page, "save").click();
  await expect(part(page, "message")).toContainText("请先处理保存结果");
  expect(run.renewals()).toBe(0);
  expect(run.previews()).toBe(0);
  expect(run.writes).toHaveLength(0);
});
test("U20 窄屏无横向溢出，日历操作满足触控尺寸", async ({ page }) => {
  await open(page);
  await part(page, "begin").click();
  await expect(part(page, "preview")).toContainText("完整预览");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const minimum = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tap-target-min"),
    ),
  );
  const box = await part(page, "confirm").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(minimum);
});

test("U20 非身份失效401保留账号，服务端错误详情决定下一步", async ({ page }) => {
  const run = await open(page, {
    write: (route) =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "csrf_mismatch" }),
      }),
  });
  await part(page, "begin").click();
  await confirm(page);
  await expect(part(page, "message")).toContainText("页面验证已失效");
  await expect(part(page, "address")).toContainText("未启用");
  await expect(part(page, "begin")).toBeEnabled();
  expect(run.renewals()).toBe(0);
});

for (const status of [500, 503])
  test(`U20 结构化${status}提交后失败保留原重置操作并同键恢复`, async ({ page }) => {
    const view = syntheticView();
    view.address_state = "enabled";
    const run = await open(page, {
      view,
      write: async (route, calls) => {
        if (calls === 1) {
          view.token_generation++;
          return route.fulfill({ status, json: buildApiErrorBody("temporarily_unavailable") });
        }
        return route.fulfill({
          json: {
            changed: false,
            address_state: "enabled",
            token_generation: view.token_generation,
          },
        });
      },
    });
    let readsAfterWrite = 0;
    await page.route("**/api/v2/me/calendar", (route) => {
      if (run.writes.length) readsAfterWrite++;
      return route.fulfill({ json: view });
    });
    page.on("dialog", (dialog) => dialog.accept());
    await openManage(page);
    await part(page, "reset").click();
    await expect(part(page, "retry")).toBeVisible();
    await expect(page.locator("#calendar-channel")).toHaveAttribute("aria-busy", "false");
    await expect(part(page, "message")).toContainText("操作结果暂时不确定");
    await expect(part(page, "reset")).toBeDisabled();
    expect(readsAfterWrite).toBe(1);
    expect(run.renewals()).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0].action).toBe("reset");
    expect(run.writes[0].body).toEqual({ confirmed: true, expected_generation: 7 });
    expect(run.writes[0].key).toBeTruthy();
    await part(page, "refresh").click();
    await expect(part(page, "message")).toContainText("原操作的结果仍需用同一操作核对");
    await expect(part(page, "reset")).toBeDisabled();
    expect(run.renewals()).toBe(0);
    await part(page, "retry").click();
    await expect(part(page, "retry")).toBeHidden();
    await expect(part(page, "message")).toContainText("已生成新的订阅链接");
    expect(run.writes).toHaveLength(2);
    expect(run.writes[1]).toEqual(run.writes[0]);
    expect(view.token_generation).toBe(8);
    await expect.poll(run.renewals).toBe(1);
  });

for (const mismatch of ["publication", "subscription"] as const)
  test(`U20 合法非空跨页${mismatch}不一致丢弃整轮并重新确认`, async ({ page }) => {
    const original = syntheticPreview();
    const first = CalendarPreviewResponseSchema.parse({
      ...original,
      totals: { ...original.totals, items: 2 },
      nextCursor: "synthetic-page-two",
    });
    const second = CalendarPreviewResponseSchema.parse({
      ...first,
      nextCursor: null,
      items: first.items.map((item) => ({ ...item, milestoneId: "synthetic-other-node" })),
      ...(mismatch === "publication"
        ? { publication: { ...first.publication, generation: first.publication.generation + 1 } }
        : { subscription: { revision: first.subscription.revision + 1 } }),
    });
    expect(first.items.length).toBeGreaterThan(0);
    expect(second.items.length).toBeGreaterThan(0);
    expect(first.items[0].milestoneId).not.toBe(second.items[0].milestoneId);
    expect(first.totals).toEqual(second.totals);
    const fresh = CalendarPreviewResponseSchema.parse({
      ...second,
      totals: original.totals,
      items: original.items.map((item) => ({
        ...item,
        milestoneId: "synthetic-fresh-node",
        eventTitle: "整轮重取的新活动",
      })),
    });
    const run = await open(page, {
      preview: async (route, calls) => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor");
        expect(cursor).toBe(calls === 3 ? "synthetic-page-two" : null);
        return route.fulfill({
          json: calls === 1 ? original : calls === 2 ? first : calls === 3 ? second : fresh,
        });
      },
      write: async (route, calls) =>
        route.fulfill(
          calls === 1
            ? {
                status: 409,
                json: buildApiErrorBody("conflict", {
                  code: "conflict",
                  reason: "preview_outdated",
                }),
              }
            : { json: { changed: true, address_state: "enabled", token_generation: 8 } },
        ),
    });
    await part(page, "begin").click();
    await confirm(page);
    await expect.poll(run.previews).toBe(4);
    await expect(part(page, "preview")).toContainText("整轮重取的新活动");
    await expect(part(page, "preview").locator("li")).toHaveCount(1);
    await expect(part(page, "preview")).not.toContainText("合成活动");
    // 没有同意勾选框：整轮重取后停在「确认启用」，必须再次显式点击，不自动提交。
    await expect(page.locator("#calendar-channel")).toHaveAttribute("aria-busy", "false");
    await expect(part(page, "confirm")).toBeVisible();
    expect(run.writes).toHaveLength(1);
    expect(run.renewals()).toBe(0);
    await confirm(page);
    await expect.poll(() => run.writes.length).toBe(2);
    expect(run.writes[1].body).toEqual({
      confirmed: true,
      expected_generation: 7,
      expected_revision: fresh.subscription.revision,
      publication_generation: fresh.publication.generation,
    });
    expect(run.writes[1].key).toBeTruthy();
    expect(run.writes[1].key).not.toBe(run.writes[0].key);
  });

for (const entry of ["save", "alarms"] as const)
  for (const outcome of [
    "validation",
    "conflict",
    "lost",
    "5xx",
    "malformed",
    "unsaved",
    "same-revision",
    "wrong-config",
    "skipped-revision",
    "old-identity",
  ] as const)
    test(`U11/U20 ${entry === "save" ? "保存后继续" : "关闭日历提醒并保存"} ${outcome} 不续期`, async ({
      page,
    }) => {
      const view = syntheticView();
      if (entry === "alarms") view.address_state = "enabled";
      const run = await open(page, { view });
      let cloud = structuredClone(syntheticConfig);
      let patches = 0;
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markResponded: () => void = () => {};
      const responded = new Promise<void>((resolve) => {
        markResponded = resolve;
      });
      let reads = 0;
      await page.route("**/api/v2/me/subscription", async (route) => {
        const snapshot = () => ({ state: "initialized", revision: cloud.revision, config: cloud });
        if (route.request().method() === "GET") {
          reads++;
          return route.fulfill({ json: snapshot() });
        }
        patches++;
        const submitted = route.request().postDataJSON();
        const next = { ...submitted.config, revision: submitted.expected_revision + 1 };
        if (outcome === "validation")
          return route.fulfill({ status: 400, json: buildApiErrorBody("validation") });
        if (outcome === "conflict")
          return route.fulfill({
            status: 409,
            json: { ...buildApiErrorBody("conflict"), current: snapshot() },
          });
        if (outcome === "5xx")
          return route.fulfill({ status: 503, json: buildApiErrorBody("temporarily_unavailable") });
        if (outcome === "malformed") return route.fulfill({ json: { saved: true } });
        if (outcome === "lost") {
          cloud = next;
          view.configuration.revision = cloud.revision;
          view.configuration.alarms_enabled = cloud.calendar.alarms_enabled;
          return route.abort();
        }
        if (outcome === "old-identity") await held;
        const config =
          outcome === "wrong-config"
            ? { ...cloud, revision: next.revision }
            : outcome === "same-revision"
              ? { ...next, revision: cloud.revision }
              : outcome === "skipped-revision"
                ? { ...next, revision: next.revision + 1 }
                : next;
        return route
          .fulfill({
            json: {
              state: "initialized",
              revision: config.revision,
              config,
              saved: outcome !== "unsaved",
            },
          })
          .catch(() => {})
          .finally(markResponded);
      });
      page.on("dialog", (dialog) => dialog.accept());
      if (entry === "save") {
        await page.locator('input[name="games"][value="hsr"]').check();
        await part(page, "begin").click();
      } else await openManage(page);
      await part(page, entry).click();
      await expect.poll(() => patches).toBe(1);
      if (outcome === "old-identity") {
        await page.evaluate(() =>
          document.dispatchEvent(
            new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
          ),
        );
        await expectPanelCleared(page);
        release?.();
        // 等旧身份的保存回执真正送达并处理完，再断言它没有触发续期或恢复面板。
        await responded;
        await settle(page);
        await expectPanelCleared(page);
      } else {
        await expect(page.locator("#calendar-channel")).toHaveAttribute("aria-busy", "false");
        if (outcome === "lost") {
          await expect(page.locator("#save-result")).toContainText("已从云端确认");
          // 新界面在云端确认保存后隐藏「重新读取」按钮；回到标签页会走同一条只读路径
          // （machine.refresh → GET），用它再读一次云端，确认再次读取也不续期。
          const before = reads;
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await expect.poll(() => reads).toBe(before + 1);
          await expect(page.locator("#save-result")).toContainText("已读取云端设置");
          // 已确认的云端版本显示在 #draft-state（#cloud-state 只显示保存阶段）。
          await expect(page.locator("#draft-state")).toHaveText(`云端版本 ${cloud.revision}`);
          await expect(page.locator("#cloud-state")).toHaveText("已保存到云端");
        }
      }
      expect(run.renewals()).toBe(0);
      expect(run.writes).toHaveLength(0);
    });
