import { expect, type Page, test } from "@playwright/test";
import {
  type AccountSummary,
  buildApiErrorBody,
  OTP_DIGITS,
  RECENT_AUTH_TTL,
  recentAuthTurnstileAction,
  SESSION_ABSOLUTE_TTL,
  SESSION_IDLE_TTL,
} from "../../packages/contracts/src/index";

// ADR-0026：恢复码可选，只在账号设置里创建、确认与更换。全部数据为合成，不发真实邮件。
test.use({ trace: "off", screenshot: "off", video: "off" });

const time = Date.UTC(2030, 0, 1);
const code = "1".repeat(OTP_DIGITS);
type Call = { path: string; method: string; body: Record<string, unknown>; csrf: string };

async function setup(
  page: Page,
  options: { saved?: boolean; restricted?: boolean; recentSession?: boolean } = {},
) {
  const facts: AccountSummary = {
    user_id: "synthetic-owner",
    server_time: time,
    email: { masked: "s***@example.invalid", email_version: 1 },
    recovery_code_saved: options.saved ?? false,
    recovery_code_generation: options.saved ? 1 : null,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: time + SESSION_IDLE_TTL * 1000,
      absolute_expires_at: time + SESSION_ABSOLUTE_TTL * 1000,
      recovery_code_required: options.restricted ?? false,
      recovery_login_at: options.restricted ? time : null,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "unknown" },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: { email_change: null, account_delete: null, recovery_code_rotate: null },
  };
  const state = {
    facts,
    // 会话是否仍在最近激活窗口：不在时，首次生成必须带本会话的轮换用途证明。
    recentSession: options.recentSession ?? true,
    mailFailure: false,
    usedProofs: new Set<string>(),
    generation: options.saved ? 1 : 0,
    calls: [] as Call[],
  };
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const root = document.getElementById("account-page");
      if (root) root.dataset.sitekey = "synthetic-sitekey";
    }).observe(document, { childList: true, subtree: true });
  });
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.syntheticWidgets ??= {}; window.turnstile = {
      render(el, options) { window.syntheticWidgets[el.id] = options; options.callback('synthetic-token-' + el.id); return el.id; },
      reset(id) { window.syntheticWidgets[id]?.callback('synthetic-token-' + id); }
    };`,
    }),
  );
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v2/", "");
    const body = req.method() === "POST" ? (req.postDataJSON() as Record<string, unknown>) : {};
    state.calls.push({
      path,
      method: req.method(),
      body,
      csrf: req.headers()["x-csrf-token"] ?? "",
    });
    const denied = (reason: "recent_auth_required" | "no_session") =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason }),
      });
    const proofUsable = (proof: unknown) =>
      typeof proof === "string" &&
      proof.startsWith("synthetic-proof") &&
      !state.usedProofs.has(proof);
    if (path === "me") return route.fulfill({ json: facts });
    if (path === "me/sessions")
      return route.fulfill({
        headers: {
          "set-cookie": "__Host-hoyo_csrf=synthetic-recovery-csrf; Secure; SameSite=Lax; Path=/",
        },
        json: {
          current_session_state: "active",
          sessions: [
            {
              id: "synthetic-session",
              label: "合成设备",
              is_current: true,
              state: "active",
              created_at: time,
              renewed_at: time,
            },
          ],
        },
      });
    if (path === "me/email-channel")
      return route.fulfill({ json: { lease: { expires_at: null } } });
    if (path === "auth/renew") return route.fulfill({ json: { renewed: false, expires_at: time } });
    if (path === "me/recent-auth/challenges") {
      if (state.mailFailure)
        return route.fulfill({
          status: 503,
          json: buildApiErrorBody("temporarily_unavailable", { code: "temporarily_unavailable" }),
        });
      return route.fulfill({ status: 202, json: { challenge_id: "synthetic-challenge" } });
    }
    if (path === "me/recent-auth/challenges/verify") {
      facts.recent_auth.recovery_code_rotate = time + RECENT_AUTH_TTL * 1000;
      return route.fulfill({ json: { proof_id: `synthetic-proof-${state.calls.length}` } });
    }
    if (path === "auth/recovery/code" && body.action === "generate") {
      if (facts.recovery_code_saved && !facts.session.recovery_code_required)
        return route.fulfill({ status: 409, json: buildApiErrorBody("conflict") });
      if (!state.recentSession && !proofUsable(body.proof_id))
        return denied("recent_auth_required");
      if (typeof body.proof_id === "string") state.usedProofs.add(body.proof_id);
      state.generation++;
      facts.recovery_code_generation = state.generation;
      return route.fulfill({
        json: {
          recovery_id: `synthetic-id-${state.generation}`,
          secret: `synthetic-secret-${state.generation}`,
          saved_confirmed: false,
        },
      });
    }
    if (path === "auth/recovery/code" && body.action === "confirm") {
      facts.recovery_code_saved = true;
      facts.session.recovery_code_required = false;
      return route.fulfill({ json: { saved_confirmed: true } });
    }
    if (path === "me/recovery-code" && body.action === "start") {
      if (typeof body.proof_id !== "string" || !body.proof_id)
        return denied("recent_auth_required");
      return route.fulfill({
        json: {
          rotation_id: "synthetic-rotation",
          recovery_id: "synthetic-rotated-id",
          secret: "synthetic-rotated-secret",
          saved_confirmed: false,
        },
      });
    }
    if (path === "me/recovery-code" && body.action === "confirm") {
      state.generation++;
      facts.recovery_code_generation = state.generation;
      return route.fulfill({ json: { saved_confirmed: true } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}
const section = (page: Page) => page.locator("#account-security");
async function open(page: Page) {
  await page.goto("/account");
  await expect(page.locator("#account-logout")).toBeEnabled();
}
async function verifyEmail(page: Page) {
  await expect(page.locator("#recovery-verify")).toBeVisible();
  await expect(page.locator("#recovery-current-turnstile-status")).toContainText("已完成");
  await page.locator("#recovery-current-send").click();
  await expect(page.locator("#recovery-current-verify")).toBeEnabled();
  await page.locator("#recovery-current-code").fill(code);
  await page.locator("#recovery-current-verify").click();
}
const writes = (state: Awaited<ReturnType<typeof setup>>, path: string) =>
  state.calls.filter((call) => call.method === "POST" && call.path === path);

test("ADR-0026 恢复码是可选项：没有恢复码时只给说明与「创建恢复码」，不是警告", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await expect(section(page).locator(".card-header")).toContainText("可选");
  await expect(page.locator(".account-nav")).toContainText("可选");
  await expect(page.locator("#account-recovery")).toContainText("还没有恢复码");
  await expect(page.locator("#account-recovery")).toHaveClass(/callout--info/);
  await expect(page.locator("#recovery-create")).toBeVisible();
  await expect(page.locator("#recovery-rotate")).toBeHidden();
  await expect(page.locator("#recovery-restricted-link")).toBeHidden();
  // 账号页不再链到恢复页去「管理恢复码」。
  await expect(section(page).locator('a[href="/recover#save"]')).toBeHidden();
  // 读取页面不生成任何恢复码。
  expect(writes(state, "auth/recovery/code")).toEqual([]);
});

test("ADR-0026 刚登录直接创建：复制失败保留明文，单独下载，勾选后才能确认；不进 URL 或存储", async ({
  page,
}) => {
  const state = await setup(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("synthetic-denied")) },
    }),
  );
  await open(page);
  await page.locator("#recovery-create").click();
  await expect(page.locator("#recovery-output")).toHaveValue("synthetic-id-1\nsynthetic-secret-1");
  expect(writes(state, "auth/recovery/code")[0]?.body).toEqual({ action: "generate" });
  await page.locator("#recovery-copy").click();
  await expect(page.locator("#recovery-result")).toContainText("复制失败");
  await expect(page.locator("#recovery-output")).toHaveValue("synthetic-id-1\nsynthetic-secret-1");
  const download = page.waitForEvent("download");
  await page.locator("#recovery-download").click();
  expect((await download).suggestedFilename()).toBe("hoyo-recovery-code.txt");
  await expect(page.locator("#recovery-confirm")).toBeDisabled();
  expect(page.url()).not.toContain("synthetic");
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  expect(storage).not.toContain("synthetic-secret");
  await page.locator("#recovery-saved-check").check();
  await page.locator("#recovery-confirm").click();
  await expect(page.locator("#recovery-result")).toContainText("恢复码已确认保存");
  await expect(page.locator("#recovery-output")).toHaveValue("");
  await expect(page.locator("#recovery-delivered")).toBeHidden();
  await expect(page.locator("#account-recovery")).toContainText("已保存恢复码");
  await expect(page.locator("#recovery-rotate")).toBeVisible();
  expect(writes(state, "auth/recovery/code").map((call) => call.body.action)).toEqual([
    "generate",
    "confirm",
  ]);
  expect(writes(state, "auth/recovery/code")[1]?.csrf).toBe("synthetic-recovery-csrf");
  // 首次创建与恢复页一样不续期。
  expect(writes(state, "auth/renew")).toEqual([]);
});

test("ADR-0026 登录较久先验证当前邮箱：人机验证用途为轮换恢复码，验证后自动带证明创建", async ({
  page,
}) => {
  const state = await setup(page, { recentSession: false });
  await open(page);
  await page.locator("#recovery-create").click();
  await expect(page.locator("#recovery-verify")).toBeVisible();
  await expect(page.locator("#recovery-verify-hint")).toContainText(
    `登录超过 ${RECENT_AUTH_TTL / 60} 分钟`,
  );
  await expect(page.locator("#recovery-delivered")).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { syntheticWidgets: Record<string, { action: string }> })
          .syntheticWidgets["recovery-current-turnstile"]?.action,
    ),
  ).toBe(recentAuthTurnstileAction("recovery_code_rotate", "current"));
  await verifyEmail(page);
  await expect(page.locator("#recovery-output")).toHaveValue("synthetic-id-1\nsynthetic-secret-1");
  await expect(page.locator("#recovery-verify")).toBeHidden();
  const challenge = writes(state, "me/recent-auth/challenges")[0]?.body;
  expect(challenge).toMatchObject({ action: "recovery_code_rotate", role: "current" });
  const generates = writes(state, "auth/recovery/code");
  expect(generates.map((call) => call.body)).toEqual([
    { action: "generate" },
    { action: "generate", proof_id: expect.stringMatching(/^synthetic-proof/) },
  ]);
  await page.locator("#recovery-saved-check").check();
  await page.locator("#recovery-confirm").click();
  await expect(page.locator("#account-recovery")).toContainText("已保存恢复码");
});

test("ADR-0026 已保存的恢复码只能更换：验证邮箱后两步轮换，确认前旧码有效，确认后续期一次", async ({
  page,
}) => {
  const state = await setup(page, { saved: true });
  await open(page);
  await expect(page.locator("#recovery-create")).toBeHidden();
  await page.locator("#recovery-rotate").click();
  await expect(page.locator("#recovery-verify-hint")).toContainText("旧码仍然有效");
  // 只是打开验证不会开始轮换。
  expect(state.calls.some((call) => call.path === "me/recovery-code")).toBe(false);
  await verifyEmail(page);
  await expect(page.locator("#recovery-output")).toHaveValue(
    "synthetic-rotated-id\nsynthetic-rotated-secret",
  );
  const start = writes(state, "me/recovery-code")[0]?.body;
  expect(start).toMatchObject({
    action: "start",
    proof_id: expect.stringMatching(/^synthetic-proof/),
  });
  expect(typeof start?.operation_key).toBe("string");
  expect(state.facts.recovery_code_generation).toBe(1);
  await page.locator("#recovery-saved-check").check();
  await page.locator("#recovery-confirm").click();
  await expect(page.locator("#recovery-result")).toContainText("恢复码已确认保存");
  expect(writes(state, "me/recovery-code")[1]?.body).toEqual({
    action: "confirm",
    rotation_id: "synthetic-rotation",
    secret: "synthetic-rotated-secret",
  });
  expect(state.facts.recovery_code_generation).toBe(2);
  await expect.poll(() => writes(state, "auth/renew").length).toBe(1);
  // 普通恢复码管理不调用生成端点。
  expect(writes(state, "auth/recovery/code")).toEqual([]);
});

test("ADR-0026 邮件全局故障不伪造证明，可以取消回到原状态", async ({ page }) => {
  const state = await setup(page, { saved: true });
  state.mailFailure = true;
  await open(page);
  await page.locator("#recovery-rotate").click();
  await expect(page.locator("#recovery-current-turnstile-status")).toContainText("已完成");
  await page.locator("#recovery-current-send").click();
  await expect(page.locator("#recovery-current-status")).toContainText("未执行");
  await expect(page.locator("#recovery-current-verify")).toBeDisabled();
  expect(state.calls.some((call) => call.path === "me/recovery-code")).toBe(false);
  await page.locator("#recovery-verify-cancel").click();
  await expect(page.locator("#recovery-verify")).toBeHidden();
  await expect(page.locator("#recovery-rotate")).toBeVisible();
  await expect(page.locator("#recovery-result")).toContainText("已取消");
});

test("ADR-0026 恢复登录受限会话：不提供创建或更换，引导到恢复页保存新码", async ({ page }) => {
  const state = await setup(page, { restricted: true });
  await open(page);
  await expect(page.locator("#account-recovery")).toContainText("恢复登录后还没有保存新码");
  await expect(page.locator("#account-recovery")).toHaveClass(/callout--warning/);
  await expect(page.locator("#recovery-create")).toBeHidden();
  await expect(page.locator("#recovery-rotate")).toBeHidden();
  await expect(page.locator("#recovery-restricted-link")).toBeVisible();
  await expect(page.locator("#recovery-restricted-link")).toHaveAttribute("href", "/recover#save");
  expect(writes(state, "auth/recovery/code")).toEqual([]);
});

test("ADR-0026 身份变化立即清除已交付的恢复码与验证状态", async ({ page }) => {
  await setup(page);
  await open(page);
  await page.locator("#recovery-create").click();
  await expect(page.locator("#recovery-delivered")).toBeVisible();
  await page.locator("#recovery-saved-check").check();
  await page.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  });
  await expect(page.locator("#account-result")).toContainText("身份已变化");
  await expect(page.locator("#recovery-output")).toHaveValue("");
  await expect(page.locator("#recovery-delivered")).toBeHidden();
  await expect(page.locator("#recovery-saved-check")).not.toBeChecked();
  await expect(page.locator("#recovery-verify")).toBeHidden();
});
