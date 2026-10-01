// F2-04：U18/U19 浏览器验收；返工新增真实 /me 形状的身份启动路径，旧事件用例仅验证 F3 生命周期接线。
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  exportPreferences,
  importPreferences,
} from "../../apps/web/src/features/subscription/draft/preferences";
import { mayCachePublicResource } from "../../apps/web/src/lib/storage/public-cache";
import {
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  DEFAULT_SCOPE_GAMES,
  SESSION_ABSOLUTE_TTL,
  SESSION_IDLE_TTL,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
} from "../../packages/contracts/src";

const base: SubscriptionConfig = {
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
const snapshot = (config = base) => ({ state: "initialized", revision: config.revision, config });
const preferences = (config: unknown = base) => ({
  format: "hoyo-preferences",
  subscription: { state: "initialized", config },
});

async function session(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "__Host-hoyo_csrf",
      value: "synthetic-csrf",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    },
  ]);
}
async function identity(page: Page, userId: string | null): Promise<void> {
  await page.evaluate(
    (userId) =>
      document.dispatchEvent(
        new CustomEvent("hoyo:draft-identity", {
          detail: userId ? { status: "confirmed", userId } : { status: "unknown" },
        }),
      ),
    userId,
  );
}
async function change(page: Page): Promise<void> {
  if (!(await page.locator("#change-settings").getAttribute("open"))) {
    // details.open 的空属性也是开启状态。
    await page.locator("#change-settings").evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
  }
  await page.getByRole("checkbox", { name: "新事件公布" }).check();
}
async function upload(page: Page, value: unknown): Promise<void> {
  await page.getByLabel("导入偏好 JSON").setInputFiles({
    name: "synthetic-preferences.json",
    mimeType: "application/json",
    buffer: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  });
}
async function rows(page: Page): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return page.evaluate(
    async () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("hoyo-local-drafts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("drafts");
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("drafts");
          const store = transaction.objectStore("drafts");
          const keys = store.getAllKeys();
          const values = store.getAll();
          transaction.oncomplete = () => {
            db.close();
            resolve(keys.result.map((key, index) => ({ key, value: values.result[index] })));
          };
          transaction.onerror = () => reject(new Error("test_storage_failed"));
        };
        request.onerror = () => reject(new Error("test_storage_failed"));
      }),
  );
}

// 统计所有变更请求和权限调用，避免只断言 PATCH 而漏掉通道/续期副作用。
async function watchEffects(page: Page): Promise<string[]> {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method());
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "draftPermissionCalls", { value: 0, writable: true });
    Notification.requestPermission = async () => {
      const target = window as unknown as { draftPermissionCalls: number };
      target.draftPermissionCalls += 1;
      return "denied";
    };
  });
  return writes;
}

test("U18 游客离线修改持久化，联网只提示，刷新后比较草稿", async ({ page, context }, info) => {
  const writes = await watchEffects(page);
  await page.goto("/subscription");
  await expect(page.locator("#local-draft-status")).toContainText("本机草稿就绪");
  await context.setOffline(true);
  await change(page);
  await expect(page.locator("#local-draft-status")).toHaveText("离线：仅保存在本机，尚未同步。");
  expect((await rows(page)).map((row) => row.key)).toEqual(["guest"]);
  await page.getByRole("button", { name: "保存订阅" }).click();
  await context.setOffline(false);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { draftPermissionCalls: number }).draftPermissionCalls,
    ),
  ).toBe(0);
  await page.reload();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  await page.screenshot({ path: info.outputPath("offline-draft-restored.png"), fullPage: true });
});

test("U18 未确认身份不读私人缓存，A/B/游客互不串草稿，确认原身份才恢复", async ({ page }) => {
  await session(page);
  await page.route("**/api/v2/me/subscription", (route) => route.fulfill({ json: snapshot() }));
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await identity(page, "synthetic-user-a");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await change(page);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  expect((await rows(page)).map((row) => row.key)).toEqual(["user:synthetic-user-a"]);
  await page.reload();
  await expect(page.locator("#local-draft-status")).toContainText("尚未确认账号身份");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await identity(page, "synthetic-user-b");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await identity(page, "synthetic-user-a");
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  await page.context().clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#cloud-state")).toHaveText("身份待确认");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator("#channel-saved-summary")).not.toContainText("版本 1");
});

for (const method of ["GET", "PATCH"]) {
  test(`U18 换账号后丢弃旧 ${method} 响应，不写新账号页面或缓存`, async ({ page }) => {
    await session(page);
    let hold = false;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    await page.route("**/api/v2/me/subscription", async (route) => {
      if (hold && route.request().method() === method) {
        hold = false;
        began?.();
        await pending;
        await route.fulfill({
          json: snapshot({
            ...base,
            revision: 99,
            notifications: { ...base.notifications, new_event: true },
          }),
        });
      } else await route.fulfill({ json: snapshot() });
    });
    await page.goto("/subscription");
    await expect(page.locator("#cloud-state")).toContainText("版本 1");
    await identity(page, "synthetic-user-a");
    await expect(page.locator("#cloud-state")).toContainText("版本 1");
    await change(page);
    await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
    hold = true;
    await page.locator(method === "GET" ? "#recheck-save" : "#save-subscription").click();
    await started;
    await identity(page, "synthetic-user-b");
    await expect(page.locator("#cloud-state")).toContainText("版本 1");
    const late = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v2/me/subscription") &&
        response.request().method() === method,
    );
    release?.();
    await late;
    // 排空响应 JSON / finally 微任务之后再检查。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator("#cloud-state")).not.toContainText("99");
    await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
    expect((await rows(page)).map((row) => row.key)).toEqual(["user:synthetic-user-a"]);
  });
}

test("U18 存储失败不伪称已落盘，清空必选项的中间草稿可恢复", async ({ page }) => {
  await page.goto("/subscription");
  for (const checkbox of await page.locator('input[name="games"]').all()) await checkbox.uncheck();
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  await page.reload();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="games"]:checked')).toHaveCount(0);
  await page.getByRole("button", { name: "保留草稿，返回编辑" }).click();
  await page.evaluate(() => {
    indexedDB.open = () => {
      throw new Error("synthetic-storage-failure");
    };
  });
  await change(page);
  await expect(page.locator("#local-draft-status")).toContainText("无法保存本机草稿");
  await expect(page.locator("#local-draft-status")).not.toContainText("仅保存在本机");
});

test("U18 公开离线提示使用真实样例缓存时间，没有已注册的 Service Worker", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const before = await page.locator(".data-freshness").textContent();
  await context.setOffline(true);
  const warning = page.locator(".data-warning");
  await expect(warning).toContainText("实际缓存时间");
  const timestamp = (await warning.textContent())?.split("实际缓存时间 ")[1]?.split(" · UTC+8")[0];
  expect(before).toContain(timestamp);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
});

test("U18 缓存策略仅接受精确白名单公开资源，拒绝私人请求", () => {
  const origin = "https://synthetic.invalid";
  const paths = [
    "/api/v2/me",
    "/api/v2/me/subscription",
    "/api/v2/auth/challenges",
    "/feeds/u/synthetic.ics",
    "/unsubscribe/synthetic",
    "/auth",
    "/_astro/public.js?secret=synthetic",
  ];
  for (const path of paths) {
    const url = `${origin}${path}`;
    expect(mayCachePublicResource(new Request(url), origin, [url])).toBe(false);
  }
  const url = `${origin}/_astro/public.js`;
  expect(mayCachePublicResource(new Request(url), origin, [url])).toBe(true);
  expect(mayCachePublicResource(new Request(url), origin, [])).toBe(false);
  expect(mayCachePublicResource(new Request(url, { method: "POST" }), origin, [url])).toBe(false);
  expect(mayCachePublicResource(new Request(url), "https://another.invalid", [url])).toBe(false);
});

test("U19 P2-07 导入生成四组比较草稿，空提醒合法，显式保存使用当前云端版本", async ({
  page,
}, info) => {
  const writes = await watchEffects(page);
  await session(page);
  const bodies: Array<{ expected_revision: number; config: object }> = [];
  await page.route("**/api/v2/me/subscription", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: snapshot() });
    else {
      const body = route.request().postDataJSON();
      bodies.push(body);
      await route.fulfill({
        json: { state: "initialized", revision: 2, config: { ...body.config, revision: 2 } },
      });
    }
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await upload(
    page,
    preferences({
      ...base,
      revision: 99,
      notifications: { ...base.notifications, rule_ids: [], new_event: true },
    }),
  );
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator("#save-differences h3")).toHaveCount(4);
  await expect(page.locator('input[name="rule_ids"]:checked')).toHaveCount(0);
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { draftPermissionCalls: number }).draftPermissionCalls,
    ),
  ).toBe(0);
  await expect(page.getByRole("button", { name: "保存订阅" })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("import-comparison.png"), fullPage: true });
  await page.getByRole("button", { name: "保留草稿，返回编辑" }).click();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  expect(bodies).toHaveLength(1);
  expect(bodies[0].expected_revision).toBe(1);
  expect(bodies[0].config).not.toHaveProperty("revision");
});

test("U19 错误文件与秘密字段拒绝，uninitialized 不制造默认配置，原草稿保持", async ({ page }) => {
  await page.goto("/subscription");
  await change(page);
  for (const value of [
    "{invalid",
    { ...preferences(), email: "synthetic" },
    preferences({ ...base, feed_url: "synthetic" }),
    preferences({ ...base, notifications: { ...base.notifications, routine_enabled: true } }),
    preferences({ ...base, scope: { ...base.scope, games: ["invalid"] } }),
    preferences({ ...base, schema_version: -1 }),
  ]) {
    await upload(page, value);
    await expect(page.locator("#preference-result")).toContainText("校验失败");
    await expect(page.locator('input[name="new_event"]')).toBeChecked();
    await expect(page.locator("#save-comparison")).toBeHidden();
  }
  await upload(page, {
    format: "hoyo-preferences",
    subscription: { state: "uninitialized", config: null },
  });
  await expect(page.locator("#preference-result")).toContainText("没有可导入的偏好");
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
});

test("U19 导出下载只含白名单，规范化后可回读，无身份和通道字段", async ({ page }) => {
  await page.goto("/subscription");
  await change(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前偏好" }).click();
  const path = await (await download).path();
  expect(path).not.toBeNull();
  const text = await readFile(path as string, "utf8");
  const value = JSON.parse(text);
  expect(Object.keys(value).sort()).toEqual(["format", "subscription"]);
  expect(importPreferences(text)?.notifications.new_event).toBe(true);
  const { revision: _revision, ...draft } = base;
  const extra = {
    ...draft,
    email: "synthetic",
    user_id: "synthetic",
    session: "synthetic",
    recovery_code: "synthetic",
    feed_url: "synthetic",
    unsubscribe_url: "synthetic",
    push: "synthetic",
    consent: true,
  };
  const exported = exportPreferences(extra);
  expect(exported).not.toContain("synthetic");
  expect(importPreferences(exported)).toEqual(importPreferences(JSON.stringify(preferences())));
});

test("U18 身份切换广播只使其他标签失效，不传身份或自动读取缓存", async ({ page, context }) => {
  await session(page);
  let reads = 0;
  await context.route("**/api/v2/me/subscription", (route) => {
    reads += 1;
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await identity(page, "synthetic-user-a");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await change(page);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  const second = await context.newPage();
  await second.goto("/subscription");
  await expect(second.locator("#cloud-state")).toContainText("版本 1");
  const before = reads;
  await identity(second, null);
  await expect(page.locator("#cloud-state")).toHaveText("身份待确认");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await expect(page.locator("#local-draft-status")).toContainText("尚未确认账号身份");
  expect(reads).toBe(before);
});

test("U19 导入文件的迟到读取在身份切换后丢弃", async ({ page }) => {
  await session(page);
  await page.route("**/api/v2/me/subscription", (route) => route.fulfill({ json: snapshot() }));
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await identity(page, "synthetic-user-a");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      const text = await original.call(this);
      await new Promise<void>((resolve) => {
        (window as unknown as { releaseDraftFile: () => void }).releaseDraftFile = resolve;
      });
      return text;
    };
  });
  await upload(
    page,
    preferences({ ...base, notifications: { ...base.notifications, new_event: true } }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { releaseDraftFile?: () => void }).releaseDraftFile,
      ),
    )
    .toBe("function");
  await identity(page, "synthetic-user-b");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.evaluate(() =>
    (window as unknown as { releaseDraftFile: () => void }).releaseDraftFile(),
  );
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await expect(page.locator("#save-comparison")).toBeHidden();
  await expect(page.locator("#preference-result")).not.toContainText("已生成可比较草稿");
  expect(await rows(page)).toEqual([]);
});

// 与 readAccountSummary 返回值对齐；仅 user_id 是草稿模块实际消费的字段。
function accountSummary(userId: string) {
  const now = Date.now();
  return {
    user_id: userId,
    server_time: now,
    email: { masked: "s***@example.invalid", email_version: 1 },
    recovery_code_saved: true,
    recovery_code_generation: 1,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: now + SESSION_IDLE_TTL * 1000,
      absolute_expires_at: now + SESSION_ABSOLUTE_TTL * 1000,
      recovery_login_at: null,
      recovery_code_required: false,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "unknown" },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: {
      email_change: null,
      recovery_code_rotate: null,
      account_delete: null,
    },
  };
}

async function drainBrowser(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("U18 返工：已登录离线草稿按 /me 身份落盘，联网只提示且显式保存仍可用", async ({
  page,
  context,
}) => {
  const writes = await watchEffects(page);
  await session(page);
  const reads: string[] = [];
  await page.route("**/api/v2/me", (route) => {
    reads.push("me");
    return route.fulfill({ json: accountSummary("synthetic-account-a") });
  });
  await page.route("**/api/v2/me/subscription", (route) => {
    reads.push("subscription");
    if (route.request().method() === "GET") return route.fulfill({ json: snapshot() });
    const body = route.request().postDataJSON();
    return route.fulfill({ json: snapshot({ ...body.config, revision: 2 }) });
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  expect(reads).toEqual(["me", "subscription"]);
  await context.setOffline(true);
  await change(page);
  await expect(page.locator("#local-draft-status")).toHaveText("离线：仅保存在本机，尚未同步。");
  const stored = await rows(page);
  expect(stored.map((row) => row.key)).toEqual(["user:synthetic-account-a"]);
  expect(JSON.stringify(stored[0].value)).not.toContain("synthetic-account-a");
  await context.setOffline(false);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  await drainBrowser(page);
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { draftPermissionCalls: number }).draftPermissionCalls,
    ),
  ).toBe(0);
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  await page.getByRole("button", { name: "保存订阅" }).click();
  await expect(page.locator("#cloud-state")).toContainText("版本 2");
  expect(writes).toEqual(["PATCH"]);
  await expect.poll(() => rows(page)).toEqual([]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前偏好" }).click();
  const path = await (await download).path();
  const exported = await readFile(path as string, "utf8");
  expect(exported).not.toContain("user_id");
  expect(exported).not.toContain("synthetic-account-a");
  expect(page.url()).not.toContain("synthetic-account-a");
});

for (const failure of ["503", "network", "invalid-user-id"] as const) {
  test(`U18 返工：/me ${failure} 保持 unknown，编辑不落盘也不带入游客空间`, async ({ page }) => {
    const writes = await watchEffects(page);
    await session(page);
    await page.route("**/api/v2/me", (route) => {
      if (failure === "network") return route.abort("failed");
      if (failure === "invalid-user-id")
        return route.fulfill({ json: { ...accountSummary("synthetic-account-a"), user_id: null } });
      return route.fulfill({ status: 503, json: { error: { code: "temporarily_unavailable" } } });
    });
    await page.route("**/api/v2/me/subscription", (route) => route.fulfill({ json: snapshot() }));
    await page.goto("/subscription");
    await expect(page.locator("#cloud-state")).toContainText("版本 1");
    await change(page);
    await expect(page.locator("#local-draft-status")).toContainText("尚未确认账号身份");
    await drainBrowser(page);
    expect(await rows(page)).toEqual([]);
    await page.context().clearCookies();
    await page.reload();
    await expect(page.locator("#local-draft-status")).toContainText("本机草稿就绪");
    await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
    await expect(page.locator("#save-comparison")).toBeHidden();
    expect(await rows(page)).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test("U18 返工：账号本机读取迟到不覆盖读取期间的新编辑", async ({ page }) => {
  await session(page);
  await page.route("**/api/v2/me", (route) =>
    route.fulfill({ json: accountSummary("synthetic-account-a") }),
  );
  await page.route("**/api/v2/me/subscription", (route) => route.fulfill({ json: snapshot() }));
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await change(page);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  // 延迟真实 IndexedDB get 的成功回调，保留真实事务、记录与写入顺序。
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      if (this.name === "drafts") {
        Object.defineProperty(request, "onsuccess", {
          set(handler: (this: IDBRequest, event: Event) => void) {
            request.addEventListener("success", (event) => {
              (window as unknown as { releaseDraftRead: () => void }).releaseDraftRead = () =>
                handler.call(request, event);
            });
          },
        });
      }
      return request;
    };
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { releaseDraftRead?: () => void }).releaseDraftRead,
      ),
    )
    .toBe("function");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await page.locator("#calendar-settings summary").click();
  await page.getByRole("checkbox", { name: "日历提醒" }).uncheck();
  await page.evaluate(() =>
    (window as unknown as { releaseDraftRead: () => void }).releaseDraftRead(),
  );
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  await drainBrowser(page);
  await expect(page.getByRole("checkbox", { name: "日历提醒" })).not.toBeChecked();
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  await expect(page.locator("#save-comparison")).toBeHidden();
  expect((await rows(page))[0].value).toMatchObject({
    config: { calendar: { alarms_enabled: false }, notifications: { new_event: false } },
  });
});

test("U18 返工：A 草稿对 B 与 401 游客不可见，/me 再次确认 A 后恢复", async ({ page }) => {
  await session(page);
  let currentId: string | null = "synthetic-account-a";
  await page.route("**/api/v2/me", (route) =>
    currentId
      ? route.fulfill({ json: accountSummary(currentId) })
      : route.fulfill({
          status: 401,
          json: { error: { code: "unauthorized", reason: "no_session" } },
        }),
  );
  let reads = 0;
  await page.route("**/api/v2/me/subscription", (route) => {
    reads += 1;
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/subscription");
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await change(page);
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  currentId = "synthetic-account-b";
  await page.reload();
  await expect(page.locator("#cloud-state")).toContainText("版本 1");
  await expect(page.locator("#local-draft-status")).toContainText("本机草稿就绪");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  currentId = null;
  const beforeGuest = reads;
  await page.reload();
  await expect(page.locator("#local-draft-status")).toContainText("本机草稿就绪");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
  expect(reads).toBe(beforeGuest);
  await expect(page.locator("#save-comparison")).toBeHidden();
  currentId = "synthetic-account-a";
  await page.reload();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  expect((await rows(page)).map((row) => row.key)).toEqual(["user:synthetic-account-a"]);
});

test("U18 返工：/me 确认期间的编辑保留且迟到身份不跨账号", async ({ page }) => {
  await session(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = true;
  await page.route("**/api/v2/me", async (route) => {
    if (hold) await pending;
    await route.fulfill({ json: accountSummary("synthetic-account-a") });
  });
  let reads = 0;
  await page.route("**/api/v2/me/subscription", (route) => {
    reads += 1;
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/subscription");
  await change(page);
  expect(reads).toBe(0);
  release?.();
  await expect(page.locator("#save-comparison")).toBeVisible();
  await expect(page.locator('input[name="new_event"]')).toBeChecked();
  await expect(page.locator("#local-draft-status")).toContainText("有待保存草稿");
  hold = false;
  // 另一条独立延迟响应覆盖未知身份的生命周期防线。
  await page.route("**/api/v2/me", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: accountSummary("synthetic-account-a") });
  });
  await page.reload();
  await identity(page, null);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/v2/me"));
  release?.();
  await response;
  await drainBrowser(page);
  await expect(page.locator("#local-draft-status")).toContainText("尚未确认账号身份");
  await expect(page.locator('input[name="new_event"]')).not.toBeChecked();
});
