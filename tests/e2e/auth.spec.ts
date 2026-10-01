import { expect, type Page, type Route, test } from "@playwright/test";
import {
  AUTH_INTENT_PUBLIC_BODY,
  AUTH_INTENT_PUBLIC_STATUS,
  buildApiErrorBody,
  OTP_ATTEMPTS,
  OTP_COOLDOWN,
  OTP_DIGITS,
  OTP_TTL,
  SESSION_RENEW_INTERVAL,
} from "../../packages/contracts/src/index";

// E2: every API and Turnstile response is synthetic; no mail or production auth is used.
const sampleEmail = "First.Last+tag@example.invalid";
const sampleCode = "1".repeat(OTP_DIGITS);
const csrf = (value: string) => ({
  "set-cookie": `__Host-hoyo_csrf=${value}; Secure; SameSite=Lax; Path=/`,
  "cache-control": "no-store",
});
const devices = [
  {
    id: "synthetic-old-a",
    label: "桌面设备 A",
    created_at: 1700000000000,
    renewed_at: 1700100000000,
    is_current: false,
    state: "active",
  },
  {
    id: "synthetic-old-b",
    label: "移动设备 B",
    created_at: 1700010000000,
    renewed_at: 1700110000000,
    is_current: false,
    state: "active",
  },
  {
    id: "synthetic-pending",
    label: "当前浏览器",
    created_at: 1700200000000,
    renewed_at: 1700200000000,
    is_current: true,
    state: "pending",
  },
];
const sessionBody = () => ({
  sessions: devices,
  current_session_state: "pending",
  current_needs_reverification: false,
  renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * 1000,
  renewed_at_note: "renewed_at 最多滞后一个续期间隔",
  csrf_token: "synthetic-session-csrf",
});
interface Call {
  path: string;
  body: Record<string, unknown>;
  key: string | undefined;
  csrf: string | undefined;
}
async function setup(
  page: Page,
  options: { registration?: boolean; mail?: boolean; key?: boolean; pending?: boolean } = {},
) {
  const calls: Call[] = [];
  let pending = options.pending ?? false;
  await page.route("**/login", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace(
        /data-sitekey(?:="[^"]*")?/,
        `data-sitekey="${options.key === false ? "" : "synthetic-sitekey"}"`,
      ),
    });
  });
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `let options; window.turnstile = { render: (el, value) => { options = value; options.callback('synthetic-widget-token'); return 'synthetic-widget'; }, reset: () => options.callback('synthetic-refreshed-token') };`,
      }),
  );
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v2/", "");
    const body = req.postDataJSON() as Record<string, unknown> | null;
    calls.push({
      path,
      body: body ?? {},
      key: req.headers()["idempotency-key"],
      csrf: req.headers()["x-csrf-token"],
    });
    if (path === "status")
      return route.fulfill({
        json: {
          registration_open: options.registration ?? true,
          mail_sending_available: options.mail ?? true,
          publication: null,
          cache: { generatedAt: 1700200000000, freshUntil: 1700200000000, stale: false },
          sources: [],
          reviewGaps: [],
          capabilities: {
            calendar: "unknown",
            email_seats: "unknown",
            routine_email: "unknown",
            push: "unknown",
          },
          calendarClients: [],
        },
      });
    if (path === "auth/preauth")
      return route.fulfill({
        json: { csrf_token: "synthetic-preauth-csrf" },
        headers: csrf("synthetic-preauth-csrf"),
      });
    if (path === "auth/challenges" || path === "auth/challenges/resend")
      return route.fulfill({ status: AUTH_INTENT_PUBLIC_STATUS, json: AUTH_INTENT_PUBLIC_BODY });
    if (path === "auth/challenges/verify") {
      pending = true;
      return route.fulfill({ json: { verified: true, pending_session_id: "synthetic-pending" } });
    }
    if (path === "auth/complete") {
      pending = true;
      return route.fulfill({ json: { completed: true, pending_session_id: "synthetic-pending" } });
    }
    if (path === "me/sessions")
      return pending
        ? route.fulfill({ json: sessionBody(), headers: csrf("synthetic-session-csrf") })
        : route.fulfill({
            status: 401,
            json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" }),
          });
    if (path === "auth/activate")
      return route.fulfill({
        json: { activated: true, csrf_token: "synthetic-active-csrf" },
        headers: csrf("synthetic-active-csrf"),
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/login");
  await expect(page.locator("#auth-service")).not.toContainText("正在读取");
  if (options.key !== false)
    await expect(page.locator("#turnstile-status")).toContainText("已完成");
  return {
    calls,
    pending: () => {
      pending = true;
    },
  };
}
async function apply(page: Page) {
  await page.getByLabel("邮箱地址", { exact: true }).fill(sampleEmail);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.locator("#code-section")).toBeVisible();
}
async function verify(page: Page) {
  await page.getByLabel("验证码", { exact: true }).fill(sampleCode);
  await page.getByRole("button", { name: "确认验证码", exact: true }).click();
}
function invalid(reason: string, path = "code") {
  return buildApiErrorBody("validation", { code: "validation", fields: [{ path, reason }] });
}
async function full(page: Page) {
  await apply(page);
  await verify(page);
  await expect(page.locator("#pending-section")).toBeVisible();
}

test("U13 真实接口形状、整段验证码、pending 确认激活及身份失效通知", async ({ page }) => {
  const { calls } = await setup(page);
  await page.evaluate(() => {
    (window as unknown as { identities: unknown[] }).identities = [];
    document.addEventListener("hoyo:draft-identity", (event) =>
      (window as unknown as { identities: unknown[] }).identities.push(
        (event as CustomEvent).detail,
      ),
    );
  });
  await expect(page.locator("#retry-auth")).toBeHidden();
  await expect(page.locator("#cancel-wait")).toBeHidden();
  await full(page);
  expect(calls.find((call) => call.path === "auth/challenges")?.body).toMatchObject({
    email: sampleEmail,
    turnstile_token: "synthetic-widget-token",
  });
  expect(calls.find((call) => call.path === "auth/challenges")?.csrf).toBe(
    "synthetic-preauth-csrf",
  );
  expect(calls.filter((call) => call.path === "auth/activate")).toHaveLength(0);
  expect(calls.find((call) => call.path === "auth/challenges/verify")?.key).toBeTruthy();
  await expect(page.locator("#pending-section")).toContainText("普通账号权限尚不可用");
  await page.getByLabel("当前设备名称（可选）").fill("我的桌面");
  await page.getByRole("button", { name: "激活当前浏览器", exact: true }).click();
  await expect(page.locator("#auth-result")).toContainText("登录已完成");
  expect(calls.find((call) => call.path === "auth/activate")).toMatchObject({
    body: { label: "我的桌面" },
    csrf: "synthetic-session-csrf",
  });
  expect(
    calls.some(
      (call) => call.path === "auth/renew" || call.path === "me" || call.path === "me/subscription",
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => (window as unknown as { identities: unknown[] }).identities),
  ).toEqual([{ status: "unknown" }, { status: "unknown" }, { status: "unknown" }]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(sampleEmail);
  await page.screenshot({ path: test.info().outputPath("login-complete.png"), fullPage: true });
});

test("U13 全局暂停注册仍用统一响应，不声明送达或剩余次数", async ({ page }) => {
  await setup(page, { registration: false });
  await apply(page);
  await expect(page.locator("#auth-service")).toContainText("全站暂停注册，已有账号仍可登录");
  await expect(page.locator("#auth-result")).toHaveText(AUTH_INTENT_PUBLIC_BODY.message);
  await expect(page.locator("#code-section")).toContainText(`${OTP_ATTEMPTS} 次错误尝试`);
  await expect(page.locator("#challenge-time")).toContainText("如果验证码已发出");
  await expect(page.locator("#code-section")).toContainText("代发");
  await expect(page.locator("#code-section")).toContainText("邮件可能晚到");
});

test("U13 邮件全局故障与缺站点密钥均不模拟发码", async ({ page }) => {
  let state = await setup(page, { mail: false });
  await page.getByLabel("邮箱地址", { exact: true }).fill(sampleEmail);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.locator("#auth-result")).toContainText("全局不可用");
  expect(state.calls.some((call) => call.path === "auth/challenges")).toBe(false);
  await page.unrouteAll({ behavior: "wait" });
  state = await setup(page, { key: false });
  await page.getByLabel("邮箱地址", { exact: true }).fill(sampleEmail);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.locator("#turnstile-status")).toContainText("尚未配置");
  expect(state.calls.some((call) => call.path === "auth/challenges")).toBe(false);
});

test("U13 明确重发保留最初期限及错误次数说明，参数全部来自注册表", async ({ page }) => {
  await page.clock.install();
  const { calls } = await setup(page);
  await apply(page);
  const deadline = await page.locator("#challenge-time").textContent();
  await expect(page.locator("#resend")).toBeDisabled();
  await page.route("**/auth/challenges/verify", (route) =>
    route.fulfill({ status: 400, json: invalid("mismatch") }),
  );
  await verify(page);
  await expect(page.locator("#auth-result")).toContainText("累计计算");
  await page.clock.fastForward(OTP_COOLDOWN * 1000);
  await page.locator("#resend").click();
  await expect(page.locator("#auth-result")).toHaveText(AUTH_INTENT_PUBLIC_BODY.message);
  await expect(page.locator("#challenge-time")).toHaveText(deadline ?? "");
  const sent = calls.filter((call) => call.path.startsWith("auth/challenges"));
  expect(sent[0]?.body.idempotency_key).not.toBe(sent[1]?.body.idempotency_key);
  await page.clock.fastForward(OTP_TTL * 1000);
  await expect(page.locator("#challenge-time")).toHaveText(deadline ?? "");
});

for (const intent of ["apply", "resend"] as const) {
  test(`U13 ${intent} 网络丢失重试保留幂等键与原始期限`, async ({ page }) => {
    await page.clock.install();
    const { calls } = await setup(page);
    if (intent === "resend") {
      await apply(page);
      await page.clock.fastForward(OTP_COOLDOWN * 1000);
    }
    const path = intent === "apply" ? "auth/challenges" : "auth/challenges/resend";
    let first: Record<string, unknown> | undefined;
    await page.route(`**/${path}`, async (route) => {
      first = route.request().postDataJSON();
      await route.abort("failed");
      await page.unroute(`**/${path}`);
    });
    if (intent === "apply") {
      await page.getByLabel("邮箱地址", { exact: true }).fill(sampleEmail);
      await page.locator("#login-request-otp").click();
    } else await page.locator("#resend").click();
    await expect(page.locator("#auth-result")).toContainText("结果未知");
    await page.locator("#retry-auth").click();
    await expect(page.locator("#auth-result")).toHaveText(AUTH_INTENT_PUBLIC_BODY.message);
    expect([...calls].reverse().find((call) => call.path === path)?.body.idempotency_key).toBe(
      first?.idempotency_key,
    );
    expect(calls.filter((call) => call.path === "auth/preauth")).toHaveLength(1);
  });
}

test("U13 preauth 续期只用同一码同一操作键自动重试一次", async ({ page }) => {
  const state = await setup(page);
  await apply(page);
  const tries: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/auth/challenges/verify", (route) => {
    tries.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (tries.length === 1)
      return route.fulfill({
        status: 409,
        json: { verified: false, preauth_renewal_required: true },
      });
    state.pending();
    return route.fulfill({ json: { verified: true, pending_session_id: "synthetic-pending" } });
  });
  await verify(page);
  await expect(page.locator("#activate")).toBeVisible();
  expect(tries).toHaveLength(2);
  expect(tries[0]).toEqual(tries[1]);
});

test("U13 连续续期要求停止自动重试并引导重建", async ({ page }) => {
  await setup(page);
  await apply(page);
  let tries = 0;
  await page.route("**/auth/challenges/verify", (route) => {
    tries++;
    return route.fulfill({
      status: 409,
      json: { verified: false, preauth_renewal_required: true },
    });
  });
  await verify(page);
  await expect(page.locator("#auth-result")).toContainText("仍无法续接");
  expect(tries).toBe(2);
});

test("U13 校验响应丢失只经同键 complete 取回 pending，绝不重复消费", async ({ page }) => {
  const { calls } = await setup(page);
  await apply(page);
  let key: string | undefined;
  let verifies = 0;
  await page.route("**/auth/challenges/verify", (route) => {
    key = route.request().headers()["idempotency-key"];
    verifies++;
    return route.abort("failed");
  });
  await verify(page);
  await expect(page.locator("#pending-section")).toBeVisible();
  expect(verifies).toBe(1);
  expect(calls.find((call) => call.path === "auth/complete")).toMatchObject({ key, body: {} });
});

test("U13 无结构 5xx 与回执丢失保持未知，手动核对也只用 complete", async ({ page }) => {
  const { calls } = await setup(page);
  await apply(page);
  await page.route("**/auth/challenges/verify", (route) =>
    route.fulfill({ status: 502, contentType: "text/plain", body: "unavailable" }),
  );
  await page.route("**/auth/complete", (route) => route.abort("failed"));
  await verify(page);
  await expect(page.locator("#auth-result")).toContainText("结果未知");
  await expect(page.locator("#verify")).toBeDisabled();
  await expect(page.locator("#login-done")).toBeHidden();
  await page.unroute("**/auth/complete");
  await page.locator("#retry-auth").click();
  await expect(page.locator("#pending-section")).toBeVisible();
  expect(calls.filter((call) => call.path === "auth/challenges")).toHaveLength(1);
});

for (const [reason, expected] of [
  ["mismatch", "验证码不匹配"],
  ["no_open_challenge", "没有可用"],
  ["attempts_exhausted", "错误尝试已用尽"],
  ["login_required", "重新走登录流程"],
] as const) {
  test(`U13 校验 ${reason} 保留输入并说明实际原因`, async ({ page }) => {
    await setup(page);
    await apply(page);
    await page.route("**/auth/challenges/verify", (route) =>
      route.fulfill({ status: 400, json: invalid(reason) }),
    );
    await verify(page);
    await expect(page.locator("#auth-result")).toContainText(expected);
    await expect(page.locator("#login-code")).toHaveValue(sampleCode);
  });
}

for (const kind of [
  "no_session",
  "conflict",
  "quota_paused",
  "temporarily_unavailable",
  "capacity_reached",
  "rate_limited",
] as const) {
  test(`U13 结构化 ${kind} 不误报验证码错误或成功`, async ({ page }) => {
    await setup(page);
    await apply(page);
    await page.route("**/auth/challenges/verify", (route) =>
      route.fulfill({
        status:
          kind === "no_session"
            ? 401
            : kind === "conflict"
              ? 409
              : kind === "rate_limited"
                ? 429
                : 503,
        json:
          kind === "no_session"
            ? buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" })
            : buildApiErrorBody(kind),
      }),
    );
    await verify(page);
    await expect(page.locator("#login-done")).toBeHidden();
    await expect(page.locator("#auth-result")).toContainText(
      kind === "no_session"
        ? "认证上下文"
        : kind === "conflict"
          ? "全站当日注册完成名额"
          : kind === "rate_limited"
            ? "过于频繁"
            : kind === "quota_paused"
              ? "额度已用尽"
              : kind === "capacity_reached"
                ? "暂无名额"
                : "暂不可用",
    );
  });
}

test("U14 满额展示服务端设备事实，选择后以逗号字符串撤销，409 更新列表不沿用旧选择", async ({
  page,
}) => {
  await setup(page);
  await full(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/auth/activate", (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length <= 2
      ? route.fulfill({
          status: 409,
          json: {
            ...buildApiErrorBody("conflict"),
            selection_required: true,
            sessions:
              bodies.length === 1 ? devices : devices.filter((row) => row.id !== "synthetic-old-a"),
            renewed_at_max_lag_ms: SESSION_RENEW_INTERVAL * 1000,
          },
        })
      : route.fulfill({ json: { activated: true, csrf_token: "synthetic-active" } });
  });
  await page.locator("#activate").click();
  await expect(page.locator("#device-selection")).toBeVisible();
  await expect(page.locator("#activate")).toBeDisabled();
  await expect(page.locator("#session-list")).toContainText("创建：");
  await expect(page.locator("#session-list")).toContainText("最近活动：");
  await expect(page.locator("#session-lag")).toContainText(`${SESSION_RENEW_INTERVAL / 60} 分钟`);
  expect(bodies).toEqual([{}]);
  await page.getByRole("checkbox", { name: /桌面设备 A/ }).check();
  await page.getByRole("checkbox", { name: /移动设备 B/ }).check();
  await page.locator("#activate").click();
  await expect(page.getByRole("checkbox", { name: /桌面设备 A/ })).toHaveCount(0);
  expect(bodies[1]?.revoke_session_ids).toBe("synthetic-old-a,synthetic-old-b");
  await expect(page.getByRole("checkbox", { name: /移动设备 B/ })).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath("device-selection.png"), fullPage: true });
  await page.getByRole("checkbox", { name: /移动设备 B/ }).check();
  await page.locator("#activate").click();
  await expect(page.locator("#login-done")).toBeVisible();
});

test("U14 激活响应丢失可重放，写请求使用最新 Cookie 中的 CSRF", async ({ page }) => {
  const { calls } = await setup(page);
  await full(page);
  await page.route("**/me/sessions", (route) =>
    route.fulfill({ json: sessionBody(), headers: csrf("synthetic-other-tab-csrf") }),
  );
  let first = true;
  await page.route("**/auth/activate", async (route) => {
    if (first) {
      first = false;
      await route.abort("failed");
    } else await route.fallback();
  });
  await page.locator("#activate").click();
  await expect(page.locator("#auth-result")).toContainText("结果未知");
  await page.locator("#retry-auth").click();
  await expect(page.locator("#login-done")).toBeVisible();
  expect(calls.find((call) => call.path === "auth/activate")?.csrf).toBe(
    "synthetic-other-tab-csrf",
  );
});

test("U14 激活会话过期提示重登，不当作名额问题", async ({ page }) => {
  await setup(page);
  await full(page);
  await page.route("**/auth/activate", (route) =>
    route.fulfill({
      status: 401,
      json: buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "session_expired" }),
    }),
  );
  await page.locator("#activate").click();
  await expect(page.locator("#auth-result")).toContainText("会话已失效");
  await expect(page.locator("#device-selection")).toBeHidden();
});

test("U14 刷新已有 pending 只恢复激活界面，不自动激活或续期", async ({ page }) => {
  const { calls } = await setup(page, { pending: true });
  await expect(page.locator("#pending-section")).toBeVisible();
  expect(calls.some((call) => call.path === "auth/activate" || call.path === "auth/renew")).toBe(
    false,
  );
});

test("U13 提交等待防重复点击；停止等待保持未知并可核对", async ({ page }) => {
  await setup(page);
  let count = 0;
  let held: Route | undefined;
  await page.route("**/auth/challenges", (route) => {
    count++;
    held = route;
  });
  await page.getByLabel("邮箱地址", { exact: true }).fill(sampleEmail);
  await page.locator("#login-request-otp").click();
  await expect(page.locator("#auth-result")).toContainText("正在申请");
  await expect(page.locator("#login-request-otp")).toBeDisabled();
  await page.locator("#cancel-wait").click();
  await expect(page.locator("#auth-result")).toContainText("结果未知");
  expect(count).toBe(1);
  await held?.abort().catch(() => {});
});

test("U13 登录开始让其他标签页失效，只广播无身份的通知", async ({ page }) => {
  await setup(page);
  const other = await page.context().newPage();
  await other.goto("/help");
  await other.evaluate(() => {
    const state = window as unknown as {
      identityMessages: unknown[];
      identityChannel: BroadcastChannel;
    };
    state.identityMessages = [];
    state.identityChannel = new BroadcastChannel("hoyo-draft-identity");
    state.identityChannel.onmessage = (event) => state.identityMessages.push(event.data);
  });
  await apply(page);
  await expect
    .poll(() =>
      other.evaluate(() => (window as unknown as { identityMessages: unknown[] }).identityMessages),
    )
    .toEqual(["invalidate"]);
  await other.close();
});

test("U13 缺失校验成功字段不能变成成功；核对回执时不再消费验证码", async ({ page }) => {
  const { calls } = await setup(page);
  await apply(page);
  await page.route("**/auth/challenges/verify", (route) => route.fulfill({ json: {} }));
  await page.route("**/auth/complete", (route) => route.fulfill({ json: {} }));
  await verify(page);
  await expect(page.locator("#auth-result")).toContainText("结果未知");
  await expect(page.locator("#verify")).toBeDisabled();
  await expect(page.locator("#login-done")).toBeHidden();
  expect(calls.filter((call) => call.path === "auth/challenges")).toHaveLength(1);
});

test("U13 正在验证与正在完成登录分别播报且按钮不可重复提交", async ({ page }) => {
  const state = await setup(page);
  await apply(page);
  let held: Route | undefined;
  await page.route("**/auth/challenges/verify", (route) => {
    held = route;
  });
  await verify(page);
  await expect(page.locator("#auth-result")).toContainText("正在验证");
  await expect(page.locator("#verify")).toBeDisabled();
  state.pending();
  await held?.fulfill({ json: { verified: true, pending_session_id: "synthetic-pending" } });
  await expect(page.locator("#activate")).toBeEnabled();
  await page.route("**/auth/activate", (route) => {
    held = route;
  });
  await page.locator("#activate").click();
  await expect(page.locator("#auth-result")).toContainText("正在完成登录");
  await expect(page.locator("#activate")).toBeDisabled();
  await expect.poll(() => held?.request().url().endsWith("auth/activate")).toBe(true);
  await held?.fulfill({ json: { activated: true, csrf_token: "synthetic-active" } });
  await expect(page.locator("#login-done")).toBeVisible();
});
