import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  type AccountSummary,
  AUTH_COMPLETION_TTL,
  buildApiErrorBody,
  OTP_DIGITS,
  RECENT_AUTH_TTL,
  recentAuthTurnstileAction,
  SESSION_ABSOLUTE_TTL,
  SESSION_IDLE_TTL,
  SESSION_PENDING_TTL,
} from "../../packages/contracts/src/index";
import { manualTurnstile, widgetState } from "./turnstile-support";

// Synthetic E2 facts only. The real built /account page handles all interactions.
const time = Date.UTC(2030, 0, 1);
const target = "synthetic-new@example.invalid";
const code = "1".repeat(OTP_DIGITS);
async function setup(page: Page, widget = true) {
  const facts: AccountSummary = {
    user_id: "synthetic-owner",
    server_time: time,
    email: { masked: "s***@example.invalid", email_version: 1 },
    recovery_code_saved: true,
    recovery_code_generation: 1,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: time + SESSION_IDLE_TTL * 1000,
      absolute_expires_at: time + SESSION_ABSOLUTE_TTL * 1000,
      recovery_code_required: false,
      recovery_login_at: null,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "enabled", routine_enabled: true },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: { email_change: null, account_delete: null, recovery_code_rotate: null },
  };
  const state = {
    facts,
    mode: "success",
    challengeMode: "success",
    verifyMode: "success",
    ended: false,
    hold: "",
    release: () => {},
    arrived: false,
    reads: 0,
    writes: [] as {
      path: string;
      body: Record<string, unknown>;
      csrf: string;
      invalidated: boolean;
    }[],
  };
  await page.addInitScript((enabled) => {
    // Supply only a public test sitekey; never replace the built page or its modules.
    new MutationObserver(() => {
      const root = document.getElementById("account-page");
      if (root && enabled) root.dataset.sitekey = "synthetic-sitekey";
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener("hoyo:draft-identity", () => {
      document.documentElement.dataset.identityInvalidated = "true";
    });
  }, widget);
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
    if (req.method() === "POST")
      state.writes.push({
        path,
        body,
        csrf: req.headers()["x-csrf-token"] ?? "",
        invalidated: await page.evaluate(
          () => document.documentElement.dataset.identityInvalidated === "true",
        ),
      });
    if (state.hold === path) {
      state.arrived = true;
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    }
    const rejected = () =>
      route.fulfill({
        status: 401,
        json: buildApiErrorBody("unauthorized", {
          code: "unauthorized",
          reason: "recent_auth_required",
        }),
      });
    if (path === "me") {
      state.reads++;
      return state.ended
        ? route.fulfill({
            status: 401,
            json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" }),
          })
        : route.fulfill({ json: facts });
    }
    if (path === "me/sessions")
      return route.fulfill({
        headers: {
          "set-cookie": "__Host-hoyo_csrf=synthetic-maintenance-csrf; Secure; SameSite=Lax; Path=/",
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
    if (path === "me/recent-auth/challenges") {
      if (state.challengeMode === "reject")
        return route.fulfill({
          status: 400,
          json: buildApiErrorBody("validation", {
            code: "validation",
            fields: [{ path: "turnstile_token", reason: "verification_failed" }],
          }),
        });
      if (state.challengeMode === "timeout") return route.abort("timedout");
      return route.fulfill({ status: 202, json: { challenge_id: `${body.action}-${body.role}` } });
    }
    if (path === "me/recent-auth/challenges/verify" || path === "me/recent-auth/recovery") {
      if (state.verifyMode === "reject") return rejected();
      if (state.verifyMode === "timeout") return route.abort("timedout");
      const action = String(body.action ?? body.challenge_id);
      facts.recent_auth[action.startsWith("account_delete") ? "account_delete" : "email_change"] =
        time + RECENT_AUTH_TTL * 1000;
      return route.fulfill({ json: { proof_id: `proof-${body.challenge_id ?? "recovery"}` } });
    }
    if (path === "me/email-change" || path === "me/delete") {
      if (state.mode === "reject") return rejected();
      if (state.mode === "timeout") return route.abort("timedout");
      if (state.mode === "malformed") return route.fulfill({ json: {} });
      state.ended = true;
      return route.fulfill({
        json:
          path === "me/delete"
            ? { state: "deleting" }
            : { email_version: 2, pending_session_id: "synthetic-new-session" },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/account");
  await expect(page.locator("#account-logout")).toBeEnabled();
  await page.locator("#email-maintenance > summary").click();
  await page.locator("#email-target").fill(target);
  await page.locator("#email-start").click();
}
/** The redesign tucks the recovery-code proof behind a disclosure in the current-email card. */
async function recoveryProof(page: Page) {
  await page.locator("#email-proofs summary", { hasText: "改用恢复码证明" }).click();
  await expect(page.locator("#email-recovery-form")).toBeVisible();
}
async function prove(page: Page, id: string) {
  await expect(page.locator(`#${id}-turnstile-status`)).toContainText("已完成");
  await page.locator(`#${id}-send`).click();
  await expect(page.locator(`#${id}-verify`)).toBeEnabled();
  await page.locator(`#${id}-code`).fill(code);
  await page.locator(`#${id}-verify`).click();
  await expect(page.locator(`#${id}-status`)).toContainText("验证已完成");
}
async function both(page: Page) {
  await prove(page, "email-current");
  await prove(page, "email-new");
}
async function invalidate(page: Page) {
  await page.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  });
  await expect(page.locator("#account-email")).toHaveText("未知");
}

test("U29 双 OTP 绑定同一目标与两种角色，先清身份再换邮箱，不复制配置或重开通道", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await expect(page.locator("#email-confirm")).toBeDisabled();
  await prove(page, "email-current");
  await expect(page.locator("#email-confirm")).toBeDisabled();
  await prove(page, "email-new");
  await page.locator("#email-confirm").click();
  await expect(page.locator("#email-change-result")).toContainText("邮箱已更换");
  await expect(page.locator("#email-change-result")).toContainText("新邮箱的邮件通知需要重新开启");
  // F4-05: this browser holds a pending session to confirm, not a forced re-login.
  await expect(page.locator("#email-change-result")).toContainText(
    `待确认的新会话，请在约 ${Math.min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL) / 60} 分钟内`,
  );
  await expect(page.locator("#email-change-result")).not.toContainText("重新登录");
  await expect(page.locator("#email-activate")).toHaveText("继续激活新会话");
  await expect(page.locator("#email-activate")).toHaveAttribute(
    "href",
    "/login?returnTo=%2Faccount",
  );
  const requests = state.writes;
  expect(requests.map((w) => w.path)).toEqual([
    "me/recent-auth/challenges",
    "me/recent-auth/challenges/verify",
    "me/recent-auth/challenges",
    "me/recent-auth/challenges/verify",
    "me/email-change",
  ]);
  for (const [index, role] of [
    [0, "current"],
    [2, "new_address"],
  ] as const) {
    expect(requests[index].body).toMatchObject({
      action: "email_change",
      role,
      target_email: target,
    });
    expect(requests[index].body.turnstile_token).toBeTruthy();
    expect(requests[index].body.idempotency_key).toBeTruthy();
  }
  expect(requests.at(-1)).toMatchObject({
    invalidated: true,
    body: {
      target_email: target,
      current_proof_id: "proof-email_change-current",
      new_proof_id: "proof-email_change-new_address",
    },
  });
  expect(requests.every((w) => w.csrf === "synthetic-maintenance-csrf")).toBe(true);
  await expect(page.locator("#email-target")).toHaveValue("");
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain("proof-");
});

test("U29 恢复码可证明当前账号，新邮箱仍必须单独验证", async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await recoveryProof(page);
  await page.locator("#email-recovery-id").fill("synthetic-recovery-id");
  await page.locator("#email-recovery-secret").fill("synthetic-secret");
  await page.locator("#email-recovery-prove").click();
  await expect(page.locator("#email-current-status")).toContainText("仍需验证新邮箱");
  await expect(page.locator("#email-confirm")).toBeDisabled();
  await expect(page.locator("#email-recovery-secret")).toHaveValue("");
  await prove(page, "email-new");
  await page.locator("#email-confirm").click();
  await expect(page.locator("#email-change-result")).toContainText("邮箱已更换");
  expect(state.writes[0].body).toMatchObject({ action: "email_change", target_email: target });
  expect(state.writes.at(-1)?.body.current_proof_id).toBe("proof-recovery");
});

for (const mode of ["reject", "timeout", "malformed"])
  test(`U29 换邮箱 ${mode} 保留真实反馈并读取核对，不自动重试`, async ({ page }) => {
    const state = await setup(page);
    state.mode = mode;
    await open(page);
    await both(page);
    const reads = state.reads;
    await page.locator("#email-confirm").click();
    await expect(page.locator("#email-change-result")).toContainText(
      mode === "reject" ? "未执行" : "结果未知",
    );
    expect(state.reads).toBeGreaterThan(reads);
    expect(state.writes.filter((w) => w.path === "me/email-change")).toHaveLength(1);
    await expect(page.locator("#email-activate")).toBeHidden();
    await expect(page.locator("#email-confirm")).toBeDisabled();
  });

for (const mode of ["reject", "timeout"])
  test(`U29 两个地址角色挑战 ${mode} 不产生证明，未知申请复用键`, async ({ page }) => {
    const state = await setup(page);
    state.challengeMode = mode;
    await open(page);
    for (const id of ["email-current", "email-new"]) {
      await expect(page.locator(`#${id}-turnstile-status`)).toContainText("已完成");
      await page.locator(`#${id}-send`).click();
      await expect(page.locator(`#${id}-status`)).toContainText(
        mode === "reject" ? "未执行" : "结果未知",
      );
      await expect(page.locator(`#${id}-verify`)).toBeDisabled();
      await page.locator(`#${id}-send`).click();
      await expect(page.locator(`#${id}-send`)).toBeEnabled();
    }
    expect(state.writes).toHaveLength(4);
    for (const i of [0, 2]) {
      if (mode === "timeout")
        expect(state.writes[i].body.idempotency_key).toBe(state.writes[i + 1].body.idempotency_key);
      expect(state.writes[i].body.turnstile_token).toBeTruthy();
    }
    await expect(page.locator("#email-confirm")).toBeDisabled();
  });

for (const mode of ["reject", "timeout"])
  test(`U29 验证 ${mode} 不把验证码消费当作完成`, async ({ page }) => {
    const state = await setup(page);
    state.verifyMode = mode;
    await open(page);
    await expect(page.locator("#email-current-turnstile-status")).toContainText("已完成");
    await page.locator("#email-current-send").click();
    await expect(page.locator("#email-current-verify")).toBeEnabled();
    await page.locator("#email-current-code").fill(code);
    await page.locator("#email-current-verify").click();
    await expect(page.locator("#email-current-status")).toContainText("验证未确认");
    await expect(page.locator("#email-target")).toHaveValue(target);
    await expect(page.locator("#email-current-code")).toHaveValue("");
    await expect(page.locator("#email-confirm")).toBeDisabled();
    expect(state.writes.filter((w) => w.path.endsWith("/verify"))).toHaveLength(1);
  });

test("U29 缺少 Turnstile 时两种地址角色都不申请验证码", async ({ page }) => {
  const state = await setup(page, false);
  await open(page);
  for (const id of ["email-current", "email-new"]) {
    await page.locator(`#${id}-send`).click();
    await expect(page.locator(`#${id}-status`)).toContainText("先完成人机验证");
  }
  expect(state.writes).toHaveLength(0);
});

for (const path of [
  "me/recent-auth/challenges",
  "me/recent-auth/challenges/verify",
  "me/recent-auth/recovery",
  "me/email-change",
])
  test(`U29 身份失效后 ${path} 迟到响应不恢复旧账号`, async ({ page }) => {
    const state = await setup(page);
    await open(page);
    if (path === "me/email-change") await both(page);
    if (path.endsWith("/verify")) {
      await expect(page.locator("#email-current-turnstile-status")).toContainText("已完成");
      await page.locator("#email-current-send").click();
      await expect(page.locator("#email-current-verify")).toBeEnabled();
      await page.locator("#email-current-code").fill(code);
    }
    state.hold = path;
    if (path.endsWith("/recovery")) {
      await recoveryProof(page);
      await page.locator("#email-recovery-id").fill("synthetic-id");
      await page.locator("#email-recovery-secret").fill("synthetic-secret");
      await page.locator("#email-recovery-prove").click();
    } else
      await page
        .locator(
          path === "me/email-change"
            ? "#email-confirm"
            : path.endsWith("/verify")
              ? "#email-current-verify"
              : "#email-current-send",
        )
        .click();
    await expect.poll(() => state.arrived).toBe(true);
    await invalidate(page);
    state.release();
    await expect(page.locator("#account-refresh")).toBeEnabled();
    await expect(page.locator("#email-proofs")).toBeHidden();
    await expect(page.locator("#email-target")).toHaveValue("");
    await expect(page.locator("#email-change-result")).not.toContainText("邮箱已更换");
    await expect(page.locator("#email-activate")).toBeHidden();
    await expect(page.locator("#email-confirm")).toBeDisabled();
  });

test("U29 取消并修改目标时必须重新取得两份证明", async ({ page }) => {
  await setup(page);
  await open(page);
  await both(page);
  await expect(page.locator("#email-target")).toHaveAttribute("readonly", "");
  await page.locator("#email-cancel").click();
  await page.locator("#email-target").fill("synthetic-other@example.invalid");
  await page.locator("#email-start").click();
  await expect(page.locator("#email-confirm")).toBeDisabled();
  await expect(page.locator("#email-current-status")).toHaveText("尚未验证。");
  await expect(page.locator("#email-new-status")).toHaveText("尚未验证。");
});

test("U29 恢复受限账号由 contracts 阻止换邮箱但保留删除例外", async ({ page }) => {
  const state = await setup(page);
  state.facts.session.recovery_code_required = true;
  state.facts.session.recovery_login_at = time;
  await page.goto("/account");
  await expect(page.locator("#account-logout")).toBeEnabled();
  await page.locator("#email-maintenance > summary").click();
  await expect(page.locator("#email-start")).toBeDisabled();
  await page.locator("#account-delete-open").click();
  await expect(page.locator("#delete-confirm")).toBeEnabled();
});

for (const mode of ["success", "reject", "timeout", "malformed"])
  test(`U29 复用删除 OTP 流程 ${mode}，只有确认 deleting 才说明仍在清理`, async ({
    page,
  }, testInfo) => {
    const state = await setup(page);
    state.mode = mode;
    await page.goto("/account");
    await expect(page.locator("#account-delete-open")).toBeEnabled();
    await page.locator("#account-delete-open").click();
    await prove(page, "delete-current");
    await page.locator("#delete-confirm").click();
    await expect(page.locator("#account-deletion")).toContainText(
      mode === "success" ? "数据仍在清理" : mode === "reject" ? "未执行" : "结果未知",
    );
    expect(state.writes.at(-1)).toMatchObject({
      path: "me/delete",
      invalidated: true,
      body: { confirm: true, proof_id: "proof-account_delete-current" },
    });
    expect(state.writes[0].body).toMatchObject({ action: "account_delete", role: "current" });
    expect(state.writes[0].body).not.toHaveProperty("target_email");
    if (mode === "success") {
      const dir =
        process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
          ? "tests/e2e/evidence/f4-04"
          : testInfo.outputPath("evidence");
      await mkdir(dir, { recursive: true });
      await page.screenshot({
        path: `${dir}/${testInfo.project.name}-deleting.png`,
        fullPage: true,
      });
    }
  });

for (const signal of ["local", "broadcast", "read-new-user", "read-new-session"])
  test(`U29 ${signal} 清除已取得证明及秘密输入，不能迁移到下一身份`, async ({ page }) => {
    const state = await setup(page);
    await open(page);
    await both(page);
    await recoveryProof(page);
    await page.locator("#email-recovery-secret").fill("synthetic-unused-secret");
    if (signal === "local")
      await page.evaluate(() =>
        document.dispatchEvent(
          new CustomEvent("hoyo:draft-identity", { detail: { status: "unknown" } }),
        ),
      );
    else if (signal === "broadcast") await invalidate(page);
    else {
      if (signal === "read-new-user") state.facts.user_id = "synthetic-next-owner";
      else
        await page.route("**/api/v2/me/sessions", (route) =>
          route.fulfill({
            json: {
              current_session_state: "active",
              sessions: [
                {
                  id: "synthetic-next-session",
                  label: "新会话",
                  is_current: true,
                  state: "active",
                  created_at: time,
                  renewed_at: time,
                },
              ],
            },
          }),
        );
      await page.locator("#account-refresh").click();
      await expect(page.locator("#account-refresh")).toBeEnabled();
    }
    await expect(page.locator("#email-proofs")).toBeHidden();
    await expect(page.locator("#email-target")).toHaveValue("");
    await expect(page.locator("#email-recovery-secret")).toHaveValue("");
    await expect(page.locator("#email-confirm")).toBeDisabled();
  });

test("U29 取消后迟到验证码证明不能恢复目标或证明", async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await expect(page.locator("#email-current-turnstile-status")).toContainText("已完成");
  await page.locator("#email-current-send").click();
  await expect(page.locator("#email-current-verify")).toBeEnabled();
  state.hold = "me/recent-auth/challenges/verify";
  await page.locator("#email-current-code").fill(code);
  await page.locator("#email-current-verify").click();
  await expect.poll(() => state.arrived).toBe(true);
  await page.locator("#email-cancel").click();
  state.release();
  await expect(page.locator("#account-refresh")).toBeEnabled();
  await expect(page.locator("#email-current-status")).toHaveText("尚未验证。");
  await expect(page.locator("#email-proofs")).toBeHidden();
  expect(state.writes.some((w) => w.path === "me/email-change")).toBe(false);
});

test("U29 删除请求等待期间不声称完成，外部身份失效后迟到 deleting 不回填", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/account");
  await expect(page.locator("#account-delete-open")).toBeEnabled();
  await page.locator("#account-delete-open").click();
  await prove(page, "delete-current");
  state.hold = "me/delete";
  await page.locator("#delete-confirm").click();
  await expect.poll(() => state.arrived).toBe(true);
  await expect(page.locator("#account-deletion")).toContainText("尚未确认");
  await expect(page.locator("#account-email")).toHaveText("未知");
  await invalidate(page);
  state.release();
  await expect(page.locator("#account-refresh")).toBeEnabled();
  await expect(page.locator("#account-deletion")).toHaveText("");
});

test("U29 证明有效期由 contracts 事实判定，过期后不能提交", async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await both(page);
  state.facts.recent_auth.email_change = time;
  await page.locator("#account-refresh").click();
  await expect(page.locator("#account-refresh")).toBeEnabled();
  await expect(page.locator("#email-confirm")).toBeDisabled();
});

test("U29 换邮箱成功页面证据只含合成脱敏数据", async ({ page }, testInfo) => {
  await setup(page);
  await open(page);
  await both(page);
  await page.locator("#email-confirm").click();
  await expect(page.locator("#email-change-result")).toContainText("待确认的新会话");
  const dir =
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f4-04"
      : testInfo.outputPath("evidence");
  await mkdir(dir, { recursive: true });
  await page.screenshot({
    path: `${dir}/${testInfo.project.name}-email-changed.png`,
    fullPage: true,
  });
});

test("U29 换邮箱后沿用真实登录页显式激活新会话，仍不写订阅或通道", async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await both(page);
  await page.locator("#email-confirm").click();
  await expect(page.locator("#email-activate")).toBeVisible();
  let activated = false;
  await page.route("**/api/v2/me/sessions", (route) =>
    route.fulfill({
      headers: {
        "set-cookie": "__Host-hoyo_csrf=synthetic-pending-csrf; Secure; SameSite=Lax; Path=/",
      },
      json: {
        current_session_state: activated ? "active" : "pending",
        csrf_token: "synthetic-pending-csrf",
        sessions: [
          {
            id: "synthetic-new-session",
            label: "合成新设备",
            is_current: true,
            state: activated ? "active" : "pending",
            created_at: time,
            renewed_at: time,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v2/auth/activate", (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-pending-csrf");
    activated = true;
    return route.fulfill({ json: { activated: true } });
  });
  await page.locator("#email-activate").click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
  await expect(page.locator("#auth-result")).toContainText("未完成的登录");
  await expect(page.locator("#activate")).toBeEnabled();
  expect(activated).toBe(false);
  await page.locator("#activate").click();
  // With returnTo the login page reports success and goes straight back to /account.
  await expect(page).toHaveURL(/\/account$/);
  expect(activated).toBe(true);
  // Confirming the delivered session never asks for another code.
  expect(state.writes.some((w) => w.path.startsWith("auth/challenges"))).toBe(false);
  expect(state.writes.some((w) => /subscription|email-channel|calendar|push/.test(w.path))).toBe(
    false,
  );
});

test("U29 新会话确认超时（session_expired）时登录页说明已失效并给出换邮箱登录入口，不显示登录完成", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await both(page);
  await page.locator("#email-confirm").click();
  await expect(page.locator("#email-activate")).toBeVisible();
  await page.route("**/api/v2/me/sessions", (route) =>
    route.fulfill({
      headers: {
        "set-cookie": "__Host-hoyo_csrf=synthetic-pending-csrf; Secure; SameSite=Lax; Path=/",
      },
      json: {
        current_session_state: "pending",
        csrf_token: "synthetic-pending-csrf",
        sessions: [
          {
            id: "synthetic-new-session",
            label: "合成新设备",
            is_current: true,
            state: "pending",
            created_at: time,
            renewed_at: time,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v2/auth/activate", (route) =>
    route.fulfill({
      status: 401,
      json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "session_expired" }),
    }),
  );
  await page.locator("#email-activate").click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
  await page.locator("#activate").click();
  await expect(page.locator("#auth-result")).toHaveText("登录已过期，请点「重新开始」再登录一次。");
  await expect(page.locator("#login-done")).toBeHidden();
  await expect(page.locator("#activate")).toBeDisabled();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
  // Only a fresh login with the new address continues, starting from the email step.
  await expect(page.locator("#restart-auth")).toHaveText("重新开始 / 更换邮箱");
  await page.locator("#restart-auth").click();
  await expect(page.locator("#email-form")).toBeVisible();
  expect(state.writes.some((w) => /subscription|email-channel|calendar|push/.test(w.path))).toBe(
    false,
  );
});

for (const reason of ["no_session", "session_expired"] as const) {
  for (const path of [
    "me/recent-auth/challenges",
    "me/recent-auth/challenges/verify",
    "me/recent-auth/recovery",
  ]) {
    test(`U29 服务端身份失效 ${reason} ${path} 立即清除旧证明和私密输入`, async ({ page }) => {
      await setup(page);
      await open(page);
      if (path.endsWith("/verify")) {
        await expect(page.locator("#email-current-turnstile-status")).toContainText("已完成");
        await page.locator("#email-current-send").click();
        await expect(page.locator("#email-current-verify")).toBeEnabled();
        await page.locator("#email-current-code").fill(code);
      }
      await recoveryProof(page);
      await page.locator("#email-recovery-id").fill("synthetic-unsent-id");
      await page.locator("#email-recovery-secret").fill("synthetic-unsent-secret");
      await page.route(`**/api/v2/${path}`, (route) =>
        route.fulfill({
          status: 401,
          json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason }),
        }),
      );
      await page
        .locator(
          path.endsWith("/recovery")
            ? "#email-recovery-prove"
            : path.endsWith("/verify")
              ? "#email-current-verify"
              : "#email-current-send",
        )
        .click();
      await expect(page.locator("#account-email")).toHaveText("未知");
      await expect(page.locator("#email-target")).toHaveValue("");
      await expect(page.locator("#email-recovery-id")).toHaveValue("");
      await expect(page.locator("#email-recovery-secret")).toHaveValue("");
      await expect(page.locator("#email-proofs")).toBeHidden();
      await expect(page.locator("#email-confirm")).toBeDisabled();
    });
  }
}

for (const mode of ["success", "reject", "timeout"])
  test(`A-P2-PREAUTH U29 四个账号组件 action 与 ${mode} 后独立清理/reset`, async ({ page }) => {
    const state = await setup(page);
    state.challengeMode = mode;
    await manualTurnstile(page);
    await open(page);
    // ADR-0026：恢复码的更换在账号设置里，用同一套最近认证组件。
    for (const [id, action, role] of [
      ["email-current", "email_change", "current"],
      ["email-new", "email_change", "new_address"],
      ["recovery-current", "recovery_code_rotate", "current"],
      ["delete-current", "account_delete", "current"],
    ] as const) {
      if (id === "recovery-current") await page.locator("#recovery-rotate").click();
      if (id === "delete-current") await page.locator("#account-delete-open").click();
      // 每个组件各自加载脚本后渲染；轮询直到本组件渲染完成。
      await expect
        .poll(() => widgetState(page, `${id}-turnstile`))
        .toMatchObject({
          action: recentAuthTurnstileAction(action, role),
          sitekey: "synthetic-sitekey",
        });
      await page.locator(`#${id}-send`).click();
      await expect.poll(() => widgetState(page, `${id}-turnstile`)).toMatchObject({ resets: 1 });
      expect(state.writes.at(-1)?.body).toMatchObject({
        action,
        role,
        turnstile_token: `synthetic-first-${id}-turnstile`,
      });
      const count = state.writes.length;
      await page.locator(`#${id}-send`).click();
      await expect(page.locator(`#${id}-status`)).toContainText("请先完成人机验证");
      expect(state.writes).toHaveLength(count);
    }
  });
