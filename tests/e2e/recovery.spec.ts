import { expect, type Page, test } from "@playwright/test";
import {
  AccountFacts,
  RECEIPT_KEY,
  readReceipt,
  saveReceipt,
} from "../../apps/web/src/features/auth/recovery/model";
import {
  type AccountSummary,
  buildApiErrorBody,
  RECENT_AUTH_TTL,
  SESSION_RENEW_INTERVAL,
  type UnauthorizedReason,
} from "../../packages/contracts/src/index";

test.use({ trace: "off", screenshot: "off", video: "off" });

// E2 only: all credentials/accounts and every API response are synthetic. No production mail.
const stamp = 1_700_000_000_000;
function summary(required = true, saved = false): AccountSummary {
  return {
    user_id: "synthetic-user",
    server_time: stamp,
    email: { masked: "s***@example.invalid", email_version: 1 },
    recovery_code_saved: saved,
    recovery_code_generation: saved ? 1 : null,
    subscription: { state: "initialized" },
    session: {
      state: "active",
      expires_at: stamp + RECENT_AUTH_TTL * 1000,
      absolute_expires_at: stamp + RECENT_AUTH_TTL * 1000,
      recovery_code_required: required,
      recovery_login_at: required ? stamp : null,
    },
    channels: {
      calendar: { state: "unknown" },
      email: { state: "disabled", routine_enabled: false },
      push: { state: "unknown" },
    },
    reclaim_grace_until: null,
    recent_auth: { email_change: null, recovery_code_rotate: null, account_delete: null },
  };
}
type Call = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  key?: string;
  csrf?: string;
};
async function setup(
  page: Page,
  initial: "public" | "pending" | "active" = "public",
  required = true,
  saved = false,
) {
  const state = {
    session: initial,
    facts: summary(required, saved),
    calls: [] as Call[],
    lostRecovery: false,
    lostGenerate: false,
    lostConfirm: false,
    rejectGenerate: false,
    badSummary: false,
    selection: false,
    stopped: false,
    mailFailure: false,
    generation: saved ? 1 : 0,
    renewal: 0,
    conflictStop: false,
    denied: {} as Partial<Record<string, UnauthorizedReason>>,
  };
  await page.route("**/recover", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        /data-sitekey(?:="[^"]*")?/,
        'data-sitekey="synthetic-sitekey"',
      ),
    });
  });
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `let options;window.turnstile={render:(el,v)=>{options=v;v.callback('synthetic-token');return 'synthetic-widget'},reset:()=>options.callback('synthetic-token')};`,
      }),
  );
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v2/", "");
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    state.calls.push({
      path,
      method: req.method(),
      body,
      key: req.headers()["idempotency-key"],
      csrf: req.headers()["x-csrf-token"],
    });
    const reply = (value: unknown, status = 200, csrf?: string) =>
      route.fulfill({
        status,
        json: value,
        headers: {
          "cache-control": "no-store",
          ...(csrf
            ? { "set-cookie": `__Host-hoyo_csrf=${csrf}; Secure; SameSite=Lax; Path=/` }
            : {}),
        },
      });
    const failure = (reason: UnauthorizedReason = "no_session") =>
      reply(buildApiErrorBody("unauthorized", { code: "unauthorized", reason }), 401);
    const denied = state.denied[path];
    if (denied) return failure(denied);
    if (path === "auth/preauth")
      return reply({ csrf_token: "synthetic-preauth" }, 200, "synthetic-preauth");
    if (path === "me/sessions") {
      if (state.session === "public") return failure();
      return reply(
        { sessions: [], current_session_state: state.session, csrf_token: "synthetic-session" },
        200,
        "synthetic-session",
      );
    }
    if (path === "me") {
      if (state.session !== "active") return failure();
      return reply(state.badSummary ? { recovery_code_saved: true } : state.facts);
    }
    if (path === "auth/recovery") {
      if (body.action === "emergency_stop") {
        if (state.conflictStop) {
          state.conflictStop = false;
          return reply(buildApiErrorBody("conflict", { code: "conflict" }), 409);
        }
        state.stopped = true;
        state.session = "public";
        return reply({ stopped: true, ignored_private_data: "must-never-render" });
      }
      if (state.renewal > 0) {
        state.renewal--;
        return reply({ completed: false, preauth_renewal_required: true }, 409);
      }
      state.session = "pending";
      if (state.lostRecovery) {
        state.lostRecovery = false;
        return route.abort("failed");
      }
      return reply({ completed: true, pending_session_id: "synthetic-pending" });
    }
    if (path === "auth/complete") {
      state.session = "pending";
      return reply({ completed: true, pending_session_id: "synthetic-pending" });
    }
    if (path === "auth/activate") {
      if (state.selection && body.revoke_session_ids !== "synthetic-old") {
        return reply(
          {
            selection_required: true,
            sessions: [
              {
                id: "synthetic-old",
                label: "合成旧设备",
                state: "active",
                created_at: stamp,
                renewed_at: stamp,
                is_current: false,
              },
            ],
            renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * 1000,
          },
          409,
        );
      }
      state.session = "active";
      return reply({ activated: true }, 200, "synthetic-active");
    }
    if (path === "auth/recovery/code") {
      if (body.action === "generate") {
        if (state.rejectGenerate) return failure("recent_auth_required");
        state.generation++;
        state.facts.recovery_code_generation = state.generation;
        if (state.lostGenerate) {
          state.lostGenerate = false;
          return route.abort("failed");
        }
        return reply({
          recovery_id: `synthetic-code-${state.generation}`,
          secret: `synthetic-secret-${state.generation}`,
          saved_confirmed: false,
        });
      }
      state.facts.recovery_code_saved = true;
      state.facts.session.recovery_code_required = false;
      if (state.lostConfirm) {
        state.lostConfirm = false;
        return route.abort("failed");
      }
      return reply({ saved_confirmed: true });
    }
    if (path === "me/recent-auth/challenges") {
      if (state.mailFailure)
        return reply(
          buildApiErrorBody("temporarily_unavailable", { code: "temporarily_unavailable" }),
          503,
        );
      return reply({ challenge_id: "synthetic-challenge" }, 202);
    }
    if (path === "me/recent-auth/challenges/verify") {
      state.facts.recent_auth.recovery_code_rotate = stamp + RECENT_AUTH_TTL * 1000;
      return reply({ proof_id: "synthetic-proof" });
    }
    if (path === "me/recovery-code") {
      if (body.action === "start")
        return reply({
          rotation_id: "synthetic-rotation",
          recovery_id: "synthetic-rotated-id",
          secret: "synthetic-rotated-secret",
          saved_confirmed: false,
        });
      state.facts.recovery_code_generation = 2;
      return reply({ saved_confirmed: true });
    }
    if (path === "me/export")
      return reply({
        format: "hoyo-preferences",
        subscription: { state: "uninitialized", config: null },
        secret: "synthetic-must-not-export",
      });
    if (path === "auth/renew") return reply({ renewed: false });
    if (path === "me/delete") return reply({ state: "deleting" });
    return reply({}, 404);
  });
  return state;
}
async function enter(page: Page, action: "stop" | "login") {
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await page.locator(`#choose-${action}`).click();
  await page.locator("#recovery-id").fill("synthetic-original-id");
  await page.locator("#recovery-secret").fill("synthetic-original-secret");
  await page.locator("#submit-recovery").click();
}

test("U15 时钟以 server_time 校正，最近认证在边界后置灰，缺事实拒绝推导", () => {
  let monotonic = 10;
  const facts = new AccountFacts(() => monotonic);
  const data = summary(false, true);
  data.recent_auth.recovery_code_rotate = stamp + 50;
  facts.accept(data);
  expect(facts.now).toBe(stamp);
  expect(facts.actions?.recovery_code_rotate.allowed).toBe(true);
  monotonic += 50;
  expect(facts.actions?.recovery_code_rotate).toEqual({
    allowed: false,
    reason: "recent_auth_required",
  });
  expect(() => facts.accept({ recovery_code_saved: true })).toThrow();
  facts.clear();
  expect(facts.actions).toBeNull();
});

test("U25 先选择目的，紧急停用按钮旁说明不消费，只显示结果且不读取私人摘要", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/recover");
  await expect(page.locator("#credential-section")).toBeHidden();
  await enter(page, "stop");
  await expect(page.locator("#recovery-result")).toContainText("恢复码仍然有效");
  expect(state.calls.some((call) => call.path === "me")).toBe(false);
  expect(state.calls.some((call) => call.path === "auth/activate")).toBe(false);
  await expect(page.locator("#save-section")).toBeHidden();
  await expect(page.locator("body")).not.toContainText("must-never-render");
  await expect(page.locator("#recovery-secret")).toHaveValue("");
});

test("U25 紧急停用并发冲突可显式重试，不误报成功", async ({ page }) => {
  const state = await setup(page);
  state.conflictStop = true;
  await page.goto("/recover");
  await enter(page, "stop");
  await expect(page.locator("#recovery-result")).not.toContainText("紧急停用已完成");
  await page.locator("#retry-recovery").click();
  await expect(page.locator("#recovery-result")).toContainText("恢复码仍然有效");
  expect(state.calls.filter((call) => call.path === "auth/recovery")).toHaveLength(2);
});

test("U15 U25 激活后立即交付新码，明确保存前禁止通道与换邮箱，不自动重开", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/recover");
  await enter(page, "login");
  await expect(page.locator("#pending-section")).toBeVisible();
  expect(state.calls.some((call) => call.path === "auth/activate")).toBe(false);
  await page.locator("#activate-recovery").click();
  await expect(page.locator("#code-output")).toHaveValue("synthetic-code-1\nsynthetic-secret-1");
  await expect(page.locator("#confirm-code")).toBeDisabled();
  for (const button of await page.locator("#restricted-actions button").all())
    await expect(button).toBeDisabled();
  await expect(page.locator("#recovery-pause")).toContainText("订阅设置仍然保留");
  expect(state.calls.find((call) => call.path === "auth/recovery")?.csrf).toBe("synthetic-preauth");
  expect(state.calls.find((call) => call.path === "auth/activate")?.csrf).toBe("synthetic-session");
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  expect(storage).not.toContain("synthetic-secret");
  expect(storage).not.toContain("synthetic-original");
  await page.locator("#saved-check").check();
  await page.locator("#confirm-code").click();
  await expect(page.locator("#recovery-result")).toContainText("已确认保存");
  await expect(page.locator("#restricted-actions")).toBeHidden();
  await expect(page.locator("#code-output")).toHaveValue("");
  expect(state.calls.some((call) => /calendar|email-change|push/.test(call.path))).toBe(false);
});

test("U25 恢复响应丢失后刷新，用同键完成回执核对，不再消费旧码", async ({ page }) => {
  const state = await setup(page);
  state.lostRecovery = true;
  await page.goto("/recover");
  await enter(page, "login");
  await expect(page.locator("#retry-recovery")).toBeVisible();
  const recovery = state.calls.find((call) => call.path === "auth/recovery");
  expect(recovery?.key).toBeTruthy();
  await page.reload();
  await expect(page.locator("#pending-section")).toBeVisible();
  expect(state.calls.filter((call) => call.path === "auth/recovery")).toHaveLength(1);
  expect(state.calls.find((call) => call.path === "auth/complete")?.key).toBe(recovery?.key);
  expect(await page.evaluate((key) => localStorage.getItem(key), RECEIPT_KEY)).toBeNull();
});

test("U25 续接预认证只重试一次，仍失败时不消费也不循环", async ({ page }) => {
  const state = await setup(page);
  state.renewal = 3;
  await page.goto("/recover");
  await enter(page, "login");
  await expect(page.locator("#recovery-result")).toContainText("恢复码尚未因此消费");
  expect(state.calls.filter((call) => call.path === "auth/recovery")).toHaveLength(2);
  expect(state.calls.some((call) => call.path === "auth/complete")).toBe(false);
});

test("U25 激活冲突不自动踢设备，手动选择后按逗号字符串提交", async ({ page }) => {
  const state = await setup(page, "pending");
  state.selection = true;
  await page.goto("/recover");
  await page.locator("#activate-recovery").click();
  await expect(page.locator("#activate-recovery")).toBeDisabled();
  await page.getByRole("checkbox", { name: /合成旧设备/ }).check();
  await page.locator("#activate-recovery").click();
  await expect(page.locator("#delivered-code")).toBeVisible();
  const writes = state.calls.filter((call) => call.path === "auth/activate");
  expect(writes[0]?.body).toEqual({});
  expect(writes[1]?.body.revoke_session_ids).toBe("synthetic-old");
});

test("U15 受限会话的新码单独下载，复制失败保留明文，不把码放进 URL 或存储", async ({ page }) => {
  const state = await setup(page, "active");
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("synthetic-denied")) },
    }),
  );
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await page.locator("#copy-code").click();
  await expect(page.locator("#recovery-result")).toContainText("复制失败");
  const download = page.waitForEvent("download");
  await page.locator("#download-code").click();
  expect((await download).suggestedFilename()).toBe("hoyo-recovery-code.txt");
  await expect(page.locator("#confirm-code")).toBeDisabled();
  expect(page.url()).not.toContain("synthetic");
  expect(state.calls.some((call) => call.path === "auth/renew")).toBe(false);
});

test("U15 U25 新码响应丢失或刷新后保留受限入口，重新生成后可保存", async ({ page }) => {
  const state = await setup(page, "active");
  state.lostGenerate = true;
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await expect(page.locator("#retry-recovery")).toBeVisible();
  await page.locator("#retry-recovery").click();
  await expect(page.locator("#generate-code")).toBeEnabled();
  await page.locator("#generate-code").click();
  await expect(page.locator("#delivered-code")).toBeVisible();
  await page.reload();
  await expect(page.locator("#code-output")).toHaveValue("");
  await expect(page.locator("#restricted-actions")).toBeVisible();
  expect(state.calls.filter((call) => call.body.action === "generate")).toHaveLength(2);
  await page.locator("#generate-code").click();
  await expect(page.locator("#code-output")).toHaveValue("synthetic-code-3\nsynthetic-secret-3");
});

test("U15 保存确认响应丢失后读取摘要核对，不谎报失败或重复生成", async ({ page }) => {
  const state = await setup(page, "active");
  state.lostConfirm = true;
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await page.locator("#saved-check").check();
  await page.locator("#confirm-code").click();
  await expect(page.locator("#retry-recovery")).toBeVisible();
  await page.locator("#retry-recovery").click();
  await expect(page.locator("#recovery-result")).toContainText("已核对：当前恢复码已确认保存");
  expect(state.calls.filter((call) => call.body.action === "generate")).toHaveLength(1);
  expect(state.calls.filter((call) => call.body.action === "confirm")).toHaveLength(1);
});

test("U15 写入拒绝重新读取事实，最近认证提示重新验证邮箱", async ({ page }) => {
  const state = await setup(page, "active");
  state.rejectGenerate = true;
  await page.goto("/recover#save");
  const reads = state.calls.filter((call) => call.path === "me").length;
  await page.locator("#generate-code").click();
  await expect(page.locator("#reauth-link")).toBeVisible();
  expect(state.calls.filter((call) => call.path === "me").length).toBeGreaterThan(reads);
  await expect(page.locator("#delivered-code")).toBeHidden();
});

test("U15 摘要缺字段保持未知，不按 saved=true 放行", async ({ page }) => {
  const state = await setup(page, "active");
  state.badSummary = true;
  await page.goto("/recover#save");
  await expect(page.locator("#code-state")).toContainText("未知");
  await expect(page.locator("#generate-code")).toBeDisabled();
  await expect(page.locator("#confirmed-next")).toBeHidden();
});

for (const saved of [false, true])
  test(`ADR-0026 普通会话打开恢复页保存分区（${saved ? "已" : "未"}保存）转到账号设置，不生成也不轮换`, async ({
    page,
  }) => {
    const state = await setup(page, "active", false, saved);
    await page.goto("/recover#save");
    await expect(page).toHaveURL(/\/account#account-security$/);
    expect(state.calls.some((call) => call.body.action === "generate")).toBe(false);
    expect(state.calls.some((call) => call.path === "me/recovery-code")).toBe(false);
    expect(state.calls.some((call) => call.path === "me/recent-auth/challenges")).toBe(false);
  });

test("U25 受限恢复会话可显式删除，状态只到清理中", async ({ page }) => {
  await setup(page, "active");
  await page.goto("/recover#save");
  await page.getByText("删除账号", { exact: true }).click();
  await page.locator("#delete-check").check();
  await expect(page.locator("#delete-account")).toBeEnabled();
  await page.locator("#delete-account").click();
  await expect(page.locator("#recovery-result")).toContainText("数据仍在清理");
  await expect(page.locator("#save-section")).toBeHidden();
});

test("U25 恢复响应丢失后关闭标签页，新标签页以短期非秘密操作键取回回执", async ({
  page,
  context,
}) => {
  const state = await setup(page);
  state.lostRecovery = true;
  await page.goto("/recover");
  await enter(page, "login");
  await expect(page.locator("#retry-recovery")).toBeVisible();
  const key = state.calls.find((call) => call.path === "auth/recovery")?.key;
  await page.close();
  const reopened = await context.newPage();
  const resumed = await setup(reopened);
  await reopened.goto("/recover");
  await expect(reopened.locator("#pending-section")).toBeVisible();
  expect(resumed.calls.find((call) => call.path === "auth/complete")?.key).toBe(key);
  expect(resumed.calls.some((call) => call.path === "auth/recovery")).toBe(false);
});

test("U25 完成回执上下文按注册表期限清理，不包含恢复秘密", async ({ page }) => {
  await setup(page);
  await page.goto("/recover");
  const storage = new Map<string, string>();
  const adapter = {
    setItem: (k: string, v: string) => storage.set(k, v),
    getItem: (k: string) => storage.get(k) ?? null,
    removeItem: (k: string) => storage.delete(k),
  };
  saveReceipt(adapter, "synthetic-operation", stamp);
  expect(readReceipt(adapter, stamp)).toBe("synthetic-operation");
  const stored = JSON.parse(storage.get(RECEIPT_KEY) ?? "{}");
  expect(Object.keys(stored).sort()).toEqual(["expiresAt", "key"]);
  expect(readReceipt(adapter, stored.expiresAt)).toBe("");
  expect(storage.size).toBe(0);
});

test("U25 已登录普通会话仍可明确选择紧急停用，结果不留私人内容", async ({ page }) => {
  await setup(page, "active", false, true);
  await page.goto("/recover");
  // ADR-0026：普通会话直接看到选择目的，恢复码管理在账号设置里。
  await expect(page.locator("#purpose-section")).toBeVisible();
  await expect(page.locator("#save-section")).toBeHidden();
  await expect(page.locator("#recovery-result")).toContainText("账号设置");
  await enter(page, "stop");
  await expect(page.locator("#save-section")).toBeHidden();
  await expect(page.locator("#recovery-result")).toContainText("恢复码仍然有效");
});

test("U15 U25 恢复入口窄屏不横向溢出，留存无凭证的界面证据", async ({ page }) => {
  await setup(page);
  await page.goto("/recover");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  // 移动端模拟下内容溢出会把 innerWidth（布局视口）一起撑宽；clientWidth 才保持设备宽度。
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("public-entry.png"), fullPage: true });
});

test("U25 浏览器拒绝存储时不消费恢复码，仍可改选紧急停用", async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("synthetic-storage-denied");
    };
  });
  await page.goto("/recover");
  await enter(page, "login");
  await expect(page.locator("#recovery-result")).toContainText("恢复登录尚未提交");
  expect(state.calls.some((call) => call.path === "auth/recovery")).toBe(false);
  await page.locator("#change-purpose").click();
  await enter(page, "stop");
  await expect(page.locator("#recovery-result")).toContainText("恢复码仍然有效");
});

test("U15 受限会话可导出偏好，排除恢复码，只有显式导出后才续期", async ({ page }) => {
  const state = await setup(page, "active");
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  expect(state.calls.some((call) => call.path === "auth/renew")).toBe(false);
  await expect(page.locator("#delivered-code")).toBeVisible();
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "导出偏好" })).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出偏好" }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe("hoyo-preferences.json");
  const stream = await file.createReadStream();
  let content = "";
  for await (const chunk of stream) content += chunk.toString();
  expect(JSON.parse(content)).toEqual({
    format: "hoyo-preferences",
    subscription: { state: "uninitialized", config: null },
  });
  await expect(page.locator("#recovery-result")).toContainText("不包含恢复码");
  expect(state.calls.filter((call) => call.path === "auth/renew")).toHaveLength(1);
});

// Hold an already received synthetic response in memory, deliberately ignoring abort.
// This exercises stale continuations, not just cancellation of a network request.
type ProbeWindow = Window & {
  recoveryProbe?: { waiting: boolean; release: () => void };
  previousRelease?: () => void;
};
async function holdNext(page: Page, path: string) {
  await page.evaluate((path) => {
    delete (window as ProbeWindow).recoveryProbe;
    const original = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url) !== `/api/v2/${path}`) return original(url, init);
      window.fetch = original;
      const response = await original(url, { ...init, signal: undefined });
      return new Promise<Response>((resolve) => {
        (window as ProbeWindow).recoveryProbe = {
          waiting: true,
          release: () => resolve(response),
        };
      });
    };
  }, path);
}
async function held(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).recoveryProbe?.waiting))
    .toBe(true);
}
async function release(page: Page, previous = false) {
  await page.evaluate(async (previous) => {
    if (previous) (window as ProbeWindow).previousRelease?.();
    else (window as ProbeWindow).recoveryProbe?.release();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, previous);
}
async function externalInvalidate(page: Page) {
  const other = await page.context().newPage();
  await other.route("**/identity-probe", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Identity probe</title>",
    }),
  );
  await other.goto("/identity-probe");
  await other.evaluate(() => {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  });
  await other.close();
}
async function expectCleared(page: Page) {
  await expect(page.locator("#code-output")).toHaveValue("");
  await expect(page.locator("#save-section")).toBeHidden();
  await expect(page.locator("#retry-recovery")).toBeHidden();
  await expect(page.locator("#recovery-result")).toContainText("身份已变化");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
}

test("U15 身份隔离：外部标签页失效立即清除已交付码及输入", async ({ page }) => {
  await setup(page, "active");
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await expect(page.locator("#delivered-code")).toBeVisible();
  await page.locator("#saved-check").check();
  await externalInvalidate(page);
  await expectCleared(page);
  await expect(page.locator("#saved-check")).not.toBeChecked();
  await page.locator("#refresh-recovery").click();
  // 受限会话可以重新领取新码，但已交付的旧明文不会回来。
  await expect(page.locator("#generate-code")).toBeEnabled();
  await expect(page.locator("#code-output")).toHaveValue("");
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toMatch(/synthetic-(?:proof|secret|challenge)/);
});

test("U15 身份隔离：生成挂起后失效，忽略不能中止的旧响应", async ({ page }) => {
  const state = await setup(page, "active");
  await page.goto("/recover#save");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await holdNext(page, "auth/recovery/code");
  await page.locator("#generate-code").click();
  await held(page);
  await externalInvalidate(page);
  await release(page);
  await expectCleared(page);
  expect(state.calls.filter((call) => call.path === "me")).toHaveLength(1);
});

test("U15 身份隔离：重新读取 me 确认不同 user_id 后清除旧码", async ({ page }) => {
  const state = await setup(page, "active");
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await expect(page.locator("#delivered-code")).toBeVisible();
  state.facts.user_id = "synthetic-other-user";
  await page.locator("#refresh-recovery").click();
  await expectCleared(page);
  await page.locator("#refresh-recovery").click();
  await expect(page.locator("#generate-code")).toBeEnabled();
  await expect(page.locator("#delivered-code")).toBeHidden();
});

for (const operation of ["summary", "confirmation", "activation"] as const) {
  test(`U15 身份隔离：${operation} 迟到结果不能恢复旧身份或权限`, async ({ page }) => {
    const state = await setup(page, operation === "activation" ? "pending" : "active");
    await page.goto("/recover#save");
    await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
    if (operation === "confirmation") {
      await page.locator("#generate-code").click();
      await page.locator("#saved-check").check();
      await holdNext(page, "auth/recovery/code");
      await page.locator("#confirm-code").click();
    } else {
      await holdNext(page, operation === "activation" ? "auth/activate" : "me");
      await page
        .locator(operation === "activation" ? "#activate-recovery" : "#refresh-recovery")
        .click();
    }
    await held(page);
    const calls = state.calls.length;
    await externalInvalidate(page);
    await release(page);
    await expectCleared(page);
    expect(state.calls).toHaveLength(calls);
  });
}

test("U15 生成忙碌时导出明确禁用，交付结束后方可下载白名单 JSON", async ({ page }) => {
  await setup(page, "active");
  await page.goto("/recover#save");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await holdNext(page, "auth/recovery/code");
  await page.locator("#generate-code").click();
  await held(page);
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "导出偏好" })).toBeDisabled();
  await expect(page.locator("#recovery-result")).toContainText("正在交付");
  await release(page);
  await expect(page.locator("#delivered-code")).toBeVisible();
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "导出偏好" })).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出偏好" }).click();
  const stream = await (await downloading).createReadStream();
  let content = "";
  for await (const chunk of stream) content += chunk.toString();
  expect(JSON.parse(content)).toEqual({
    format: "hoyo-preferences",
    subscription: { state: "uninitialized", config: null },
  });
});

test("U15 身份隔离：同页外部身份事件清除凭证，不接受事件授予身份", async ({ page }) => {
  await setup(page, "active");
  await page.goto("/recover#save");
  await page.locator("#generate-code").click();
  await expect(page.locator("#delivered-code")).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("hoyo:draft-identity", {
        detail: { status: "confirmed", userId: "synthetic-other-user" },
      }),
    ),
  );
  await expectCleared(page);
});

test("U15 身份隔离：旧写入拒绝不能触发摘要重读或恢复错误动作", async ({ page }) => {
  const state = await setup(page, "active");
  state.rejectGenerate = true;
  await page.goto("/recover#save");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await holdNext(page, "auth/recovery/code");
  await page.locator("#generate-code").click();
  await held(page);
  await externalInvalidate(page);
  await release(page);
  await expectCleared(page);
  await expect(page.locator("#reauth-link")).toBeHidden();
  expect(state.calls.filter((call) => call.path === "me")).toHaveLength(1);
});

test("U15 身份隔离：旧请求结束不能清除新身份请求的忙碌状态", async ({ page }) => {
  const state = await setup(page, "active");
  await page.goto("/recover#save");
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await holdNext(page, "auth/recovery/code");
  await page.locator("#generate-code").click();
  await held(page);
  await page.evaluate(() => {
    (window as ProbeWindow).previousRelease = (window as ProbeWindow).recoveryProbe?.release;
  });
  await externalInvalidate(page);
  await expectCleared(page);
  state.facts.user_id = "synthetic-other-user";
  await holdNext(page, "me");
  await page.locator("#refresh-recovery").click();
  await held(page);
  await release(page, true);
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#code-output")).toHaveValue("");
  await expect(page.locator("#generate-code")).toBeDisabled();
  await release(page);
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#generate-code")).toBeEnabled();
  await expect(page.locator("#delivered-code")).toBeHidden();
});

// The response is observed before waiting for aria-busy=false: assertions must run
// after the error handler (including any summary reread), not during the request.
async function denyAndFinish(page: Page, path: string, trigger: string) {
  const response = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === `/api/v2/${path}` && reply.status() === 401,
  );
  await page.locator(trigger).click();
  await response;
  await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
}
async function sessionCleared(page: Page) {
  await expect(page.locator("#purpose-section")).toBeVisible();
  await expect(page.locator("#code-output")).toHaveValue("");
  await expect(page.locator("#delivered-code")).toBeHidden();
  await expect(page.locator("#save-section")).toBeHidden();
  await expect(page.locator("#pending-section")).toBeHidden();
  await expect(page.locator("#recovery-id")).toHaveValue("");
  await expect(page.locator("#recovery-secret")).toHaveValue("");
  await expect(page.locator("#saved-check")).not.toBeChecked();
  await expect(page.locator("#retry-recovery")).toBeHidden();
  await expect(page.locator("#reauth-link")).toBeVisible();
}
for (const reason of ["no_session", "session_expired"] as const) {
  for (const endpoint of ["both", "summary", "confirmation"] as const) {
    test(`U15 服务端失效：${reason} ${endpoint} 完成处理后清明文、证明、输入和重试`, async ({
      page,
    }) => {
      const state = await setup(page, "active");
      await page.goto("/recover#save");
      await page.locator("#generate-code").click();
      await expect(page.locator("#delivered-code")).toBeVisible();
      await page.locator("#saved-check").check();
      // Include hidden credential inputs, so hiding sections alone cannot pass.
      await page.evaluate(() => {
        for (const id of ["recovery-id", "recovery-secret"])
          (document.getElementById(id) as HTMLInputElement).value = "synthetic-obsolete";
      });
      const path =
        endpoint === "both" ? "me/sessions" : endpoint === "summary" ? "me" : "auth/recovery/code";
      state.denied[path] = reason;
      if (endpoint === "both") state.denied.me = reason;
      await denyAndFinish(
        page,
        path,
        endpoint === "confirmation" ? "#confirm-code" : "#refresh-recovery",
      );
      await sessionCleared(page);
      state.denied = {};
      await page.locator("#refresh-recovery").click();
      await expect(page.locator("#save-section")).toBeVisible();
      await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
      // The restricted session may fetch a new code, but the old delivery closure is gone.
      await expect(page.locator("#generate-code")).toBeEnabled();
      await expect(page.locator("#code-output")).toHaveValue("");
      await expect(page.locator("#retry-recovery")).toBeHidden();
    });
  }
  test(`U15 服务端失效：${reason} 清理后忽略旧生成响应`, async ({ page }) => {
    const state = await setup(page, "active");
    await page.goto("/recover#save");
    await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
    await holdNext(page, "auth/recovery/code");
    await page.locator("#generate-code").click();
    await held(page);
    // Allow a new foreground read while the original unabortable response is held.
    await externalInvalidate(page);
    await expectCleared(page);
    state.denied.me = reason;
    await denyAndFinish(page, "me", "#refresh-recovery");
    await release(page);
    await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
    await sessionCleared(page);
  });
}
for (const reason of ["recent_auth_required", "csrf_mismatch"] as const) {
  test(`U15 非退出 401：${reason} 保留交付码及保存能力`, async ({ page }) => {
    const state = await setup(page, "active");
    await page.goto("/recover#save");
    await page.locator("#generate-code").click();
    await page.locator("#saved-check").check();
    state.denied["auth/recovery/code"] = reason;
    const reads = state.calls.filter((call) => call.path === "me").length;
    await denyAndFinish(page, "auth/recovery/code", "#confirm-code");
    expect(state.calls.filter((call) => call.path === "me").length).toBeGreaterThan(reads);
    await expect(page.locator("#delivered-code")).toBeVisible();
    await expect(page.locator("#code-output")).toHaveValue("synthetic-code-1\nsynthetic-secret-1");
    await expect(page.locator("#confirm-code")).toBeEnabled();
    await expect(page.locator("#retry-recovery")).toBeVisible();
    state.denied = {};
    await page.locator("#retry-recovery").click();
    await expect(page.locator("#recovery-result")).toContainText("已确认保存");
    await expect(page.locator("#recovery")).toHaveAttribute("aria-busy", "false");
    expect(state.calls.filter((call) => call.body.action === "generate")).toHaveLength(1);
  });
}
