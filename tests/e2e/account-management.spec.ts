import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  type AccountSummary,
  buildApiErrorBody,
  RECENT_AUTH_TTL,
  SESSION_ABSOLUTE_TTL,
  SESSION_IDLE_TTL,
  SESSION_RENEW_INTERVAL,
} from "../../packages/contracts/src/index";

// All account facts, identifiers, CSRF values and proof inputs are synthetic E2 fixtures.
const serverTime = Date.UTC(2030, 0, 1);
const second = 1_000;
const facts = (): AccountSummary => ({
  user_id: "synthetic-account",
  server_time: serverTime,
  email: { masked: "s***@example.invalid", email_version: 1 },
  recovery_code_saved: true,
  recovery_code_generation: 1,
  subscription: { state: "initialized" },
  session: {
    state: "active",
    expires_at: serverTime + SESSION_IDLE_TTL * second,
    absolute_expires_at: serverTime + SESSION_ABSOLUTE_TTL * second,
    recovery_code_required: false,
    recovery_login_at: null,
  },
  channels: {
    calendar: { state: "unknown" },
    email: { state: "enabled", routine_enabled: false },
    push: { state: "unknown" },
  },
  reclaim_grace_until: null,
  recent_auth: { email_change: null, recovery_code_rotate: null, account_delete: null },
});
const fixtureSessions = () => [
  {
    id: "synthetic-current",
    label: "当前测试设备",
    created_at: serverTime - SESSION_IDLE_TTL * second,
    renewed_at: serverTime - SESSION_RENEW_INTERVAL * second,
    is_current: true,
    state: "active",
  },
  {
    id: "synthetic-other",
    label: "其他测试设备",
    created_at: serverTime - SESSION_IDLE_TTL * second,
    renewed_at: serverTime - SESSION_RENEW_INTERVAL * second,
    is_current: false,
    state: "active",
  },
];

async function setup(page: Page, summary: Record<string, unknown> = facts()) {
  const state = {
    summary,
    rows: fixtureSessions(),
    ended: false,
    meReads: 0,
    sessionReads: 0,
    writes: [] as {
      path: string;
      method: string;
      body: Record<string, unknown>;
      csrf: string;
      invalidated: boolean;
    }[],
    logout: "success",
    revoke: "success",
    deletion: "success",
    exportHeld: false,
  };
  await page.addInitScript(() => {
    document.addEventListener("hoyo:draft-identity", () => {
      document.documentElement.dataset.identityInvalidated = "true";
    });
  });
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v2/", "");
    const unauthorized = () =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" }),
      });
    if (req.method() !== "GET") {
      state.writes.push({
        path,
        method: req.method(),
        body: req.postDataJSON() as Record<string, unknown>,
        csrf: req.headers()["x-csrf-token"] ?? "",
        invalidated: await page.evaluate(
          () => document.documentElement.dataset.identityInvalidated === "true",
        ),
      });
    }
    if (path === "me") {
      state.meReads += 1;
      return state.ended ? unauthorized() : route.fulfill({ json: state.summary });
    }
    if (path === "me/sessions") {
      state.sessionReads += 1;
      return state.ended
        ? unauthorized()
        : route.fulfill({
            headers: {
              "set-cookie": "__Host-hoyo_csrf=synthetic-session-csrf; Secure; SameSite=Lax; Path=/",
            },
            json: {
              sessions: state.rows,
              current_session_state: "active",
              current_needs_reverification: false,
              renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * second,
              csrf_token: "synthetic-session-csrf",
            },
          });
    }
    if (path === "me/email-channel")
      return route.fulfill({
        json: {
          lease: {
            expires_at: serverTime + SESSION_IDLE_TTL * second,
            background_processing: "unknown",
          },
        },
      });
    if (path === "auth/logout") {
      if (state.logout === "reject")
        return route.fulfill({ status: 503, json: buildApiErrorBody("temporarily_unavailable") });
      if (state.logout !== "unknown") state.ended = true;
      if (state.logout === "lost" || state.logout === "unknown") return route.abort();
      if (state.logout === "malformed") {
        state.ended = false;
        return route.fulfill({ json: {} });
      }
      return route.fulfill({ json: { logged_out: true } });
    }
    if (path.startsWith("me/sessions/") && req.method() === "DELETE") {
      if (state.revoke === "reject")
        return route.fulfill({
          status: 401,
          json: buildApiErrorBody("unauthorized", {
            code: "unauthorized",
            reason: "csrf_mismatch",
          }),
        });
      const id = path.split("/").at(-1);
      state.rows = state.rows.filter((row) => row.id !== id);
      if (id === "synthetic-current") state.ended = true;
      return state.revoke === "lost" ? route.abort() : route.fulfill({ json: { revoked: true } });
    }
    if (path === "me/recent-auth/recovery") {
      (state.summary.recent_auth as AccountSummary["recent_auth"]).account_delete =
        serverTime + RECENT_AUTH_TTL * second;
      return route.fulfill({ json: { proof_id: "synthetic-delete-proof" } });
    }
    if (path === "me/delete") {
      if (state.deletion === "reject") {
        (state.summary.recent_auth as AccountSummary["recent_auth"]).account_delete = null;
        return route.fulfill({
          status: 401,
          json: buildApiErrorBody("unauthorized", {
            code: "unauthorized",
            reason: "recent_auth_required",
          }),
        });
      }
      state.ended = true;
      return state.deletion === "lost"
        ? route.abort()
        : route.fulfill({ json: { state: "deleting" } });
    }
    if (path === "me/export")
      return route.fulfill({
        json: {
          format: "hoyo-preferences",
          subscription: { state: "uninitialized", config: null },
          // Synthetic sentinels: the browser must not download the entire API response.
          recovery_code: "synthetic-export-private-code",
          feed_url: "https://example.invalid/synthetic-private-feed",
          account: { user_id: "synthetic-export-private-owner" },
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/account");
  await expect(page.getByRole("button", { name: "退出当前账号", exact: true })).toBeEnabled();
}
async function chooseLogout(page: Page, pause = false) {
  await page.getByRole("button", { name: "退出当前账号", exact: true }).click();
  await page
    .getByRole("button", { name: pause ? "退出并暂停本浏览器通知" : "仅退出账号", exact: true })
    .click();
}
async function proof(page: Page) {
  await page.getByRole("button", { name: "准备删除账号" }).click();
  await page.getByLabel("恢复码 ID", { exact: true }).fill("synthetic-recovery-id");
  await page.getByLabel("恢复码秘密", { exact: true }).fill("synthetic-recovery-secret");
  await page.getByRole("button", { name: "验证本次删除用途" }).click();
  await expect(page.getByRole("button", { name: "确认删除账号", exact: true })).toBeEnabled();
}

test("U14a 账号事实、会话滞后与 Push 分组，加载和等待不续期", async ({ page }, testInfo) => {
  const state = await setup(page);
  await open(page);
  await expect(page.locator("#account-email")).toContainText("s***@example.invalid");
  await expect(page.locator("#account-lag")).toContainText(
    `${SESSION_RENEW_INTERVAL / (24 * 60 * 60)} 天`,
  );
  await expect(page.locator("#account-reclaim")).toContainText("不据网页登录频率判断");
  await expect(page.locator("#account-lease")).toContainText("后台续租状态未知");
  await expect(page.getByRole("heading", { name: "Push 绑定", exact: true })).toBeVisible();
  await expect(page.locator("#account-sessions li")).toHaveCount(2);
  await expect(page.locator("#account-result")).toContainText("已读取账号事实");
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("account.png"), fullPage: true });
});

test("U14a 回收期限仅来自摘要；远古设备续期不导致账号被判不活跃", async ({ page }) => {
  const summary = facts();
  summary.reclaim_grace_until = serverTime + SESSION_IDLE_TTL * second;
  const state = await setup(page, summary);
  state.rows[1].renewed_at = 0;
  await open(page);
  await expect(page.locator("#account-reclaim")).toContainText("服务端记录的回收宽限期限");
  await expect(page.locator("#account-sessions")).toContainText("1970");
  await expect(page.locator("#account-sessions")).not.toContainText("账号不活跃");
});

for (const missing of ["user_id", "server_time", "recent_auth"] as const) {
  test(`U14a 缺失 ${missing} 保持未知、动作关闭`, async ({ page }) => {
    const summary: Record<string, unknown> = { ...facts() };
    delete summary[missing];
    await setup(page, summary);
    await page.goto("/account");
    await expect(page.locator("#account-result")).toContainText("账号状态尚未确认");
    await expect(page.locator("#account-email")).toHaveText("未知");
    await expect(page.locator("#account-logout")).toBeDisabled();
  });
}

test("U24 两个独立退出按钮、取消与键盘焦点，不用预勾选", async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await page.locator("#account-logout").click();
  await expect(page.getByRole("dialog", { name: "选择退出方式" })).toBeVisible();
  await expect(page.locator("#logout-only")).toBeFocused();
  await expect(page.locator("#logout-dialog input")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#account-logout")).toBeFocused();
  expect(state.writes).toEqual([]);
});

for (const pause of [false, true]) {
  test(`U24 ${pause ? "组合退出展示暂停未接入" : "仅退出不触碰通道"}，请求前失效身份`, async ({
    page,
  }, testInfo) => {
    const state = await setup(page);
    await open(page);
    await chooseLogout(page, pause);
    await expect(page.locator("#account-result")).toContainText("退出已确认");
    await expect(page.locator("#account-result")).toContainText(
      pause ? "暂停未执行（能力尚未接入）" : "未请求暂停",
    );
    await expect(page.locator("#account-email")).toHaveText("未知");
    expect(state.writes.map((write) => write.path)).toEqual(["auth/logout"]);
    expect(state.writes[0].invalidated).toBe(true);
    expect(state.writes[0].csrf).toBe("synthetic-session-csrf");
    await page.screenshot({ path: testInfo.outputPath("logout-result.png"), fullPage: true });
  });
}

for (const mode of ["reject", "lost", "unknown", "malformed"]) {
  test(`U24 退出 ${mode} 独立核对会话并重读摘要`, async ({ page }) => {
    const state = await setup(page);
    state.logout = mode;
    await open(page);
    await chooseLogout(page, true);
    await expect(page.locator("#account-result")).toContainText(
      mode === "lost"
        ? "核对确认当前会话已失效"
        : mode === "reject"
          ? "退出未执行"
          : "退出结果未知",
    );
    await expect(page.locator("#account-result")).toContainText("暂停未执行");
    expect(state.sessionReads).toBeGreaterThan(1);
    expect(state.meReads).toBeGreaterThan(1);
    expect(state.writes).toHaveLength(1);
  });
}

test("U24 跨标签页广播失效，退出等待期间不重复提交", async ({ page, context }) => {
  const state = await setup(page);
  await open(page);
  const observer = await context.newPage();
  await observer.goto("/help");
  await observer.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.onmessage = (event) => {
      document.body.dataset.identitySignal = String(event.data);
    };
  });
  let release: (() => void) | undefined;
  await page.route("**/api/v2/auth/logout", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  await chooseLogout(page);
  await expect(observer.locator("body")).toHaveAttribute("data-identity-signal", "invalidate");
  await expect(page.locator("#account-logout")).toBeDisabled();
  release?.();
  await expect(page.locator("#account-result")).toContainText("退出已确认");
  expect(state.writes).toHaveLength(1);
});

for (const current of [false, true]) {
  test(`U24 撤销${current ? "当前" : "其他"}会话丢响应按列表核对、CSRF 现读`, async ({
    page,
    context,
  }) => {
    const state = await setup(page);
    state.revoke = "lost";
    await open(page);
    await context.addCookies([
      {
        name: "__Host-hoyo_csrf",
        value: "synthetic-new-csrf",
        url: "https://127.0.0.1",
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await page
      .getByRole("button", { name: current ? "撤销当前会话" : "撤销 其他测试设备", exact: true })
      .click();
    await expect(page.locator("#account-result")).toContainText(
      current ? "当前会话已失效" : "目标会话已不在有效列表",
    );
    expect(state.writes[0].method).toBe("DELETE");
    expect(state.writes[0].csrf).toBe("synthetic-new-csrf");
    expect(state.writes[0].invalidated).toBe(current);
    expect(state.writes).toHaveLength(1);
  });
}

test("U24 撤销写入被拒后重读摘要且不能把 CSRF 401 当退出成功", async ({ page }) => {
  const state = await setup(page);
  state.revoke = "reject";
  await open(page);
  await page.getByRole("button", { name: "撤销当前会话", exact: true }).click();
  await expect(page.locator("#account-result")).toContainText("撤销未执行");
  await expect(page.locator("#account-result")).not.toContainText("当前会话已失效");
  expect(state.meReads).toBeGreaterThan(1);
});

test("U29 server_time 校正、用途证明和明确确认，deleting 不是清理完成", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2000-01-01T00:00:00Z") });
  const state = await setup(page);
  await open(page);
  await proof(page);
  await expect(page.getByLabel("恢复码秘密", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "确认删除账号", exact: true }).click();
  await expect(page.locator("#account-deletion")).toContainText("权限与发送已停止。数据仍在清理");
  await expect(page.locator("#account-deletion")).toContainText("尚无清理完成的证据");
  const write = state.writes.find((item) => item.path === "me/delete");
  expect(write?.invalidated).toBe(true);
  expect(write?.body).toEqual({ confirm: true, proof_id: "synthetic-delete-proof" });
  expect(state.writes[0].body.action).toBe("account_delete");
  await page.screenshot({ path: testInfo.outputPath("deleting.png"), fullPage: true });
});

test("U29 校正时钟经过证明有效期后自动置灰，不重发请求", async ({ page }) => {
  await page.clock.install({ time: new Date("2000-01-01T00:00:00Z") });
  const state = await setup(page);
  await open(page);
  await proof(page);
  await page.clock.runFor(RECENT_AUTH_TTL * second + second);
  await expect(page.locator("#delete-confirm")).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

for (const mode of ["reject", "lost"]) {
  test(`U29 删除 ${mode} 不重放，重读摘要且 401 不证明清理完成`, async ({ page }) => {
    const state = await setup(page);
    state.deletion = mode;
    await open(page);
    await proof(page);
    const reads = state.meReads;
    await page.locator("#delete-confirm").click();
    await expect(page.locator("#account-deletion")).toContainText(
      mode === "lost" ? "删除结果未知" : "删除未执行",
    );
    await expect(page.locator("#account-deletion")).not.toContainText("权限与发送已停止");
    expect(state.meReads).toBeGreaterThan(reads);
    expect(state.writes.filter((item) => item.path === "me/delete")).toHaveLength(1);
    if (mode === "reject") {
      await page.locator("#account-delete-open").click();
      await expect(page.locator("#delete-confirm")).toBeDisabled();
    }
  });
}

test("U29 受限恢复会话按 contracts 删除例外直接确认，导出仍可用", async ({ page }) => {
  const summary = facts();
  summary.session.recovery_code_required = true;
  summary.session.recovery_login_at = serverTime;
  const state = await setup(page, summary);
  await open(page);
  await expect(page.locator("#account-export")).toBeEnabled();
  await page.locator("#account-delete-open").click();
  await expect(page.locator("#delete-proof-form")).toBeHidden();
  await page.locator("#delete-confirm").click();
  await expect(page.locator("#account-deletion")).toContainText("数据仍在清理");
  expect(state.writes[0].body).toEqual({ confirm: true });
});

test("U14a 身份变化丢弃迟到的账号摘要，不恢复旧用户私人视图", async ({ page }) => {
  await setup(page);
  let release: (() => void) | undefined;
  await page.route("**/api/v2/me", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  await page.goto("/account");
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  });
  await expect(page.locator("#account-result")).toContainText("身份已变化");
  release?.();
  await expect(page.locator("#account-refresh")).toBeEnabled();
  await expect(page.locator("#account-email")).toHaveText("未知");
});

test("U14a 导出从专用端点下载，不写本地账号或凭据缓存", async ({ page }, testInfo) => {
  await setup(page);
  await open(page);
  const download = page.waitForEvent("download");
  await page.locator("#account-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("hoyo-preferences.json");
  const savedPath = testInfo.outputPath("hoyo-preferences.json");
  await file.saveAs(savedPath);
  expect(JSON.parse(await readFile(savedPath, "utf8"))).toEqual({
    format: "hoyo-preferences",
    subscription: { state: "uninitialized", config: null },
  });
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});

for (const [name, path] of [
  ["设备列表", "me/sessions"],
  ["邮件租期", "me/email-channel"],
  ["导出", "me/export"],
] as const) {
  test(`U14a U24 身份失效后的迟到${name}响应不恢复私人视图或触发下载`, async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob | MediaSource) => {
        document.documentElement.dataset.createdDownload = "true";
        return createObjectURL(blob);
      };
    });
    if (path === "me/export") await open(page);
    let entered = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v2/${path}`, async (route) => {
      entered = true;
      await held;
      await route.fallback();
    });
    if (path === "me/export") await page.locator("#account-export").click();
    else await page.goto("/account");
    await expect.poll(() => entered).toBe(true);
    await page.evaluate(() => {
      const channel = new BroadcastChannel("hoyo-draft-identity");
      channel.postMessage("invalidate");
      channel.close();
    });
    await expect(page.locator("#account-result")).toContainText("身份已变化");
    release();
    // The operation releases its busy state only after the delayed response has been processed.
    await expect(page.locator("#account-refresh")).toBeEnabled();
    await expect(page.locator("#account-email")).toHaveText("未知");
    await expect(page.locator("#account-lease")).toHaveText("未知");
    await expect(page.locator("#account-sessions li")).toHaveCount(0);
    await expect(page.locator("#account-result")).toContainText("身份已变化");
    await expect(page.locator("#account-export")).toBeDisabled();
    await expect(page.locator("html")).not.toHaveAttribute("data-created-download", "true");
  });
}
