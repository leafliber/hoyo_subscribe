import { expect, type Page, type Route, test } from "@playwright/test";
import type { CandidateDetail, QueuePage } from "../../apps/web/src/features/admin/types";
import { buildApiErrorBody } from "../../packages/contracts/src/index";

// E2 合成响应：不访问 Worker、真实账号、官方来源或邮件链路。
const injection = '<img src=x onerror="window.adminInjection=true">';
const syntheticSecret = "synthetic-bootstrap-input-only";
const csrf = (value: string) => ({
  "set-cookie": `__Host-hoyo_csrf=${value}; Secure; SameSite=Strict; Path=/`,
});
function detail(id = "synthetic-candidate"): CandidateDetail {
  return {
    candidate: {
      id,
      article_version_id: "synthetic-version",
      updated_at: 1_900_000_000_000,
      review_status: "pending",
      proposal_json: { classification: "uncertain", events: [], ambiguities: [injection] },
    },
    article: {
      articleVersionId: "synthetic-version",
      articleId: "synthetic-article",
      sourceId: "genshin-ann",
      externalId: "synthetic-announcement",
      officialUrl: "https://example.invalid/synthetic",
      completeness: "complete",
      blocks: [
        { kind: "html", html: injection },
        { kind: "text", text: "合成公告正文" },
      ],
    },
    evidence: [
      {
        id: "synthetic-evidence",
        article_version_id: "synthetic-version",
        block_ref: injection,
        event_id: null,
        milestone_id: null,
      },
    ],
  };
}
type Call = { path: string; body: Record<string, unknown>; csrf?: string; url: string };
async function setup(page: Page, options: { loggedIn?: boolean; pages?: QueuePage[] } = {}) {
  const state = {
    loggedIn: options.loggedIn ?? true,
    current: detail(),
    calls: [] as Call[],
    reads: 0,
    writes: 0,
    queueFailure: false,
    detailFailure: false,
    loginStatus: 200,
    logoutStatus: 200,
    logoutReply: { logged_out: true } as Record<string, unknown>,
    logoutWait: Promise.resolve(),
    logoutNetworkFailure: false,
    preauthWait: Promise.resolve(),
    write: null as ((route: Route, call: Call) => Promise<void>) | null,
  };
  const pages = options.pages ?? [
    {
      candidates: [
        { id: "synthetic-candidate", created_at: 1_900_000_000_000, updated_at: 1_900_000_000_000 },
      ],
      next_cursor: null,
    },
  ];
  await page.route("**/api/v2/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v2/", "");
    const call = {
      path,
      body: (req.postDataJSON() ?? {}) as Record<string, unknown>,
      csrf: req.headers()["x-csrf-token"],
      url: req.url(),
    };
    state.calls.push(call);
    if (path === "auth/preauth") {
      await state.preauthWait;
      return route.fulfill({
        json: { csrf_token: "synthetic-preauth" },
        headers: csrf("synthetic-preauth"),
      });
    }
    if (path === "admin/session/bootstrap") {
      if (state.loginStatus !== 200)
        return route.fulfill({
          status: state.loginStatus,
          json:
            state.loginStatus === 429
              ? buildApiErrorBody("rate_limited", { code: "rate_limited", retry_after_ms: 12_000 })
              : { error: { code: "unauthorized", message: syntheticSecret } },
        });
      state.loggedIn = true;
      return route.fulfill({
        json: { csrf_token: "synthetic-admin", expires_at: 1_900_010_000_000 },
        headers: csrf("synthetic-admin"),
      });
    }
    if (!state.loggedIn)
      return route.fulfill({ status: 401, json: buildApiErrorBody("unauthorized") });
    if (path === "admin/session/logout") {
      await state.logoutWait;
      if (state.logoutNetworkFailure) return route.abort("failed");
      if (state.logoutStatus !== 200)
        return route.fulfill({
          status: state.logoutStatus,
          json: buildApiErrorBody("temporarily_unavailable"),
        });
      if (state.logoutReply.logged_out === true) state.loggedIn = false;
      return route.fulfill({ json: state.logoutReply });
    }
    if (path === "admin/review/queue") {
      if (state.queueFailure)
        return route.fulfill({ status: 503, json: buildApiErrorBody("temporarily_unavailable") });
      const cursor = url.searchParams.get("cursor");
      const index = cursor === null ? 0 : Number(cursor);
      return route.fulfill({ json: pages[index] });
    }
    if (path.startsWith("admin/review/candidates/")) {
      state.reads++;
      if (state.detailFailure)
        return route.fulfill({ status: 503, json: buildApiErrorBody("temporarily_unavailable") });
      return route.fulfill({
        json: {
          ...state.current,
          candidate: { ...state.current.candidate, id: path.split("/").at(-1) },
        },
      });
    }
    if (path.startsWith("admin/review/") && req.method() === "POST") {
      state.writes++;
      if (state.write) return state.write(route, call);
      state.current.candidate.updated_at++;
      if (path.endsWith("create") || path.endsWith("revise")) {
        state.current.candidate.proposal_json = JSON.parse(String(call.body.proposal_json));
        return route.fulfill({
          json: {
            candidate: {
              candidateId: state.current.candidate.id,
              updatedAtMs: state.current.candidate.updated_at,
            },
          },
        });
      }
      if (path.endsWith("reject")) state.current.candidate.review_status = "rejected";
      else state.current.candidate.review_status = "approved";
      return route.fulfill({
        json: {
          candidate_id: state.current.candidate.id,
          review_status: state.current.candidate.review_status,
          updated_at: state.current.candidate.updated_at,
          publication: { outcome: "published" },
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}
async function openCandidate(page: Page) {
  await page.goto("/admin/");
  await page.getByRole("button", { name: "查看候选 synthetic-candidate", exact: true }).click();
  await expect(page.locator("#candidate-meta")).toContainText("已读版本");
  await expect(page.locator("#submit")).toBeEnabled();
}
async function submit(page: Page, action: string, reason = "合成人工核对理由") {
  await page.getByLabel("审核操作").selectOption(action);
  await page.getByLabel("操作理由", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "提交操作", exact: true }).click();
}

test.describe("A-F6-REVIEW", () => {
  test("引导秘密仅在 bootstrap 请求体，立即清空；401 判定登录，退出回到表单", async ({ page }) => {
    const state = await setup(page, {
      loggedIn: false,
      pages: [{ candidates: [], next_cursor: null }],
    });
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(error.message));
    await page.goto("/admin/");
    const input = page.getByLabel("引导秘密");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    let releasePreauth = () => {};
    state.preauthWait = new Promise<void>((resolve) => {
      releasePreauth = resolve;
    });
    await input.fill(syntheticSecret);
    await page.getByRole("button", { name: "登录管理端", exact: true }).click();
    await expect(input).toHaveValue("");
    expect(state.calls.some((call) => call.path === "admin/session/bootstrap")).toBe(false);
    releasePreauth(); // 在预认证响应尚未返回时，输入就必须已经清空。
    await expect(page.getByText("没有待审核的候选", { exact: true })).toBeVisible();
    const writes = state.calls.filter((call) => call.path !== "admin/review/queue");
    expect(writes.map((call) => call.path)).toEqual(["auth/preauth", "admin/session/bootstrap"]);
    expect(writes[1].body).toEqual({ secret: syntheticSecret });
    expect(writes[1].csrf).toBe("synthetic-preauth");
    expect(
      state.calls.filter((call) => JSON.stringify(call).includes(syntheticSecret)),
    ).toHaveLength(1);
    expect(page.url()).not.toContain(syntheticSecret);
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          html: document.documentElement.outerHTML,
          cookie: document.cookie,
        }),
      ),
    ).not.toContain(syntheticSecret);
    expect(logs.join("\n")).not.toContain(syntheticSecret);
    await page.reload(); // 不依赖本地登录标志，直接查询管理接口。
    await expect(page.getByText("没有待审核的候选", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "退出管理端", exact: true }).click();
    await expect(page.locator("#notice")).toHaveText("已退出管理端。");
    await expect(input).toBeVisible();
    expect(state.calls.at(-1)?.csrf).toBe("synthetic-admin");
    expect(state.calls.some((call) => call.path.startsWith("me"))).toBe(false);
  });
  test("登录失败统一提示且不回显响应文本，限速只显示公开等待", async ({ page }) => {
    const state = await setup(page, { loggedIn: false });
    state.loginStatus = 401;
    await page.goto("/admin/");
    for (const status of [401, 429]) {
      state.loginStatus = status;
      await page.getByLabel("引导秘密").fill(syntheticSecret);
      await page.getByRole("button", { name: "登录管理端", exact: true }).click();
      await expect(page.locator("#notice")).toContainText(
        status === 401 ? "无法登录" : "等待 12 秒",
      );
      await expect(page.getByLabel("引导秘密")).toHaveValue("");
      await expect(page.locator("body")).not.toContainText(syntheticSecret);
    }
  });
  test("队列穿过空页直到最后，显示来源和文章；正文证据标签只作文本", async ({ page }, testInfo) => {
    const row = (id: string) => ({
      id,
      created_at: 1_900_000_000_000,
      updated_at: 1_900_000_000_000,
    });
    const state = await setup(page, {
      pages: [
        { candidates: [row("synthetic-candidate")], next_cursor: "1" },
        { candidates: [], next_cursor: "2" },
        { candidates: [row("synthetic-last")], next_cursor: null },
      ],
    });
    await openCandidate(page);
    await expect(page.locator("#queue-state")).toHaveText("已读完队列，共 2 个待审核候选。");
    expect(
      state.calls
        .filter((call) => call.path === "admin/review/queue")
        .map((call) => new URL(call.url).searchParams.get("cursor")),
    ).toEqual([null, "1", "2"]);
    await expect(page.locator("#queue")).toContainText("genshin-ann");
    await expect(page.locator("#queue")).toContainText("synthetic-announcement");
    await expect(page.locator("#blocks")).toContainText(injection);
    await expect(page.locator("#evidence")).toContainText("<img src=x");
    await expect(page.locator("#review img")).toHaveCount(0);
    expect(await page.evaluate(() => "adminInjection" in window)).toBe(false);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("admin-review.png"), fullPage: true });
  });
  for (const action of ["revise", "reject", "approve", "correct", "associate", "retract"]) {
    test(`${action} 使用读到的版本与理由，发布操作显示 outcome`, async ({ page }) => {
      const state = await setup(page);
      await openCandidate(page);
      const version = state.current.candidate.updated_at;
      await page.getByLabel("审核操作").selectOption(action);
      if (action === "associate")
        await page.getByLabel("目标事件 target_event_id").fill("synthetic-target");
      if (action === "revise")
        await page
          .getByLabel("候选 JSON · proposal_json", { exact: true })
          .fill('{"classification":"no_event","events":[],"ambiguities":[]}');
      await submit(page, action);
      await expect(page.locator("#publication")).toContainText(
        action === "revise"
          ? "已修正"
          : action === "reject"
            ? "已驳回"
            : "publication.outcome: published",
      );
      const call = state.calls.find((call) => call.path === `admin/review/${action}`);
      expect(call?.body).toMatchObject({
        candidate_id: "synthetic-candidate",
        expected_updated_at: version,
        reason: "合成人工核对理由",
      });
      if (action === "associate") expect(call?.body.target_event_id).toBe("synthetic-target");
      if (action === "revise") expect(typeof call?.body.proposal_json).toBe("string");
    });
  }
  test("新建指定文章版本，字段级 400 就地显示并保留输入", async ({ page }) => {
    const state = await setup(page);
    state.write = async (route) =>
      route.fulfill({
        status: 400,
        json: buildApiErrorBody("validation", {
          code: "validation",
          fields: [
            { path: "article_version_id", reason: "not_found" },
            { path: "proposal_json", reason: "too_long" },
          ],
        }),
      });
    await page.goto("/admin/");
    await page.getByRole("button", { name: "新建候选", exact: true }).click();
    await page.getByLabel("文章版本 article_version_id（新建时指定）").fill("synthetic-version");
    await page.getByLabel("候选 JSON · proposal_json", { exact: true }).fill("{}");
    await page.getByLabel("操作理由", { exact: true }).fill("合成新建理由");
    await page.locator("#submit").click();
    await expect(page.locator("#article_version_id-error")).toHaveText(
      "article_version_id: not_found ",
    );
    await expect(page.locator("#proposal_json-error")).toHaveText("proposal_json: too_long ");
    await expect(page.locator("#article_version_id")).toBeFocused();
    await expect(page.locator("#proposal_json")).toHaveValue("{}");
    expect(state.calls.at(-1)?.body).toEqual({
      article_version_id: "synthetic-version",
      proposal_json: "{}",
      reason: "合成新建理由",
    });
    state.write = null;
    await page.locator("#submit").click();
    await expect(page.locator("#publication")).toHaveText("候选已新建，尚未批准。");
  });
  test("409 重新读取但不自动提交或覆盖本地草稿，再次点击才使用新版", async ({ page }) => {
    const state = await setup(page);
    await openCandidate(page);
    const original = state.current.candidate.updated_at;
    const reads = state.reads;
    state.write = async (route) => {
      state.current.candidate.updated_at++;
      state.current.candidate.proposal_json = {
        classification: "no_event",
        events: [],
        ambiguities: [],
      };
      await route.fulfill({ status: 409, json: buildApiErrorBody("conflict") });
    };
    const draft = '{"classification":"uncertain","events":[],"ambiguities":["本地修改"]}';
    await page.locator("#proposal_json").fill(draft);
    await submit(page, "revise");
    await expect(page.locator("#notice")).toContainText("已在别处改过。已重新读取");
    await expect(page.locator("#proposal_json")).toHaveValue(draft);
    await expect(page.locator("#reason")).toHaveValue("合成人工核对理由");
    expect(state.reads).toBeGreaterThan(reads);
    expect(state.writes).toBe(1);
    state.write = null;
    await page.locator("#submit").click();
    await expect(page.locator("#publication")).toContainText("已修正");
    expect(
      state.calls
        .filter((call) => call.path === "admin/review/revise")
        .map((call) => call.body.expected_updated_at),
    ).toEqual([original, original + 1]);
  });
  test("已批准未发布可用最新版本重发同一操作与理由", async ({ page }, testInfo) => {
    const state = await setup(page);
    await openCandidate(page);
    state.write = async (route) => {
      state.current.candidate.updated_at++;
      state.current.candidate.review_status = "approved";
      await route.fulfill({
        json: {
          candidate_id: "synthetic-candidate",
          review_status: "approved",
          updated_at: state.current.candidate.updated_at,
          publication: { outcome: "condition_missed" },
        },
      });
    };
    await submit(page, "approve", "初次批准理由");
    await expect(page.locator("#publication")).toContainText(
      "已批准、未发布。publication.outcome: condition_missed",
    );
    await expect(page.getByRole("button", { name: "重试发布", exact: true })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("admin-publication-pending.png"),
      fullPage: true,
    });
    state.current.candidate.updated_at++; // 重试必须再次读取，不能复用第一次响应。
    const version = state.current.candidate.updated_at;
    state.write = null;
    await page.locator("#reason").fill("这个编辑不应替换重试理由");
    await page.getByRole("button", { name: "重试发布", exact: true }).click();
    await expect(page.locator("#publication")).toContainText("已批准、已发布");
    const calls = state.calls.filter((call) => call.path === "admin/review/approve");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({
      candidate_id: "synthetic-candidate",
      reason: "初次批准理由",
      expected_updated_at: version,
    });
  });
  test("重试前候选内容变化时停止；未保存 JSON 不会被裁定悄悄忽略", async ({ page }) => {
    const state = await setup(page);
    await openCandidate(page);
    const saved = await page.locator("#proposal_json").inputValue();
    await page.locator("#proposal_json").fill("{}");
    await submit(page, "approve");
    await expect(page.locator("#notice")).toContainText("JSON 有未保存修改");
    expect(state.writes).toBe(0);
    await page.locator("#proposal_json").fill(saved);
    state.write = async (route) => {
      state.current.candidate.review_status = "approved";
      await route.fulfill({
        json: {
          updated_at: state.current.candidate.updated_at,
          publication: { outcome: "temporarily_unavailable" },
        },
      });
    };
    await submit(page, "approve");
    await expect(page.locator("#retry-publication")).toBeEnabled();
    state.current.candidate.proposal_json = { changed: true };
    await page.locator("#retry-publication").click();
    await expect(page.locator("#notice")).toContainText("未重试发布");
    expect(state.writes).toBe(1);
  });
  test("读取失败不假空、退出失败不假退出，会话过期返回登录", async ({ page }) => {
    const state = await setup(page);
    state.queueFailure = true;
    await page.goto("/admin/");
    await expect(page.locator("#notice")).toContainText("请求未能确认完成");
    await expect(page.getByText("没有待审核的候选", { exact: true })).toHaveCount(0);
    await expect(page.locator("#login")).toBeHidden();
    state.queueFailure = false;
    await page.locator("#reload").click();
    state.logoutStatus = 503;
    await page.locator("#logout").click();
    await expect(page.locator("#notice")).toContainText("请求未能确认完成");
    await expect(page.locator("#workspace")).toBeVisible();
    state.loggedIn = false;
    await page.locator("#reload").click();
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#workspace")).toBeHidden();
  });
  test("409 后重新读取失败会禁写，重新打开候选后才能继续", async ({ page }) => {
    const state = await setup(page);
    await openCandidate(page);
    state.write = async (route) => {
      state.detailFailure = true;
      await route.fulfill({ status: 409, json: buildApiErrorBody("conflict") });
    };
    await submit(page, "approve");
    await expect(page.locator("#notice")).toContainText("重新读取失败。写操作已暂停");
    await expect(page.locator("#submit")).toBeDisabled();
    expect(state.writes).toBe(1);
    state.detailFailure = false;
    await page.getByRole("button", { name: "查看候选 synthetic-candidate", exact: true }).click();
    await expect(page.locator("#submit")).toBeEnabled();
  });
  for (const [label, reply] of [
    ["缺字段", {}],
    ["false", { logged_out: false }],
    ["字符串", { logged_out: "true" }],
    ["数字", { logged_out: 1 }],
    ["null", { logged_out: null }],
  ] as const) {
    test(`退出回执 ${label} 不假成功，等待异步处理后的最终界面`, async ({ page }) => {
      const state = await setup(page);
      state.logoutReply = reply;
      let releaseLogout = () => {};
      state.logoutWait = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
      await openCandidate(page);
      await page.locator("#logout").click();
      await expect(page.locator("#logout")).toBeDisabled();
      releaseLogout();
      // 先等待响应处理产生的最终错误状态，不能用过早的否定断言充当通过。
      await expect(page.locator("#notice")).toHaveText(
        "请求未能确认完成，请重新读取后核对结果；不会自动重发写操作。",
      );
      await expect(page.locator("#logout")).toBeEnabled();
      await expect(page.locator("#workspace")).toBeVisible();
      await expect(page.locator("#login")).toBeHidden();
      await expect(page.locator("#notice")).not.toContainText("已退出管理端");
      expect(state.loggedIn).toBe(true);
      expect(state.calls.filter((call) => call.path === "admin/session/logout")).toHaveLength(1);
      await page.locator("#reload").click();
      await expect(page.locator("#notice")).toHaveText("已重新读取队列。");
      await expect(page.locator("#workspace")).toBeVisible();
    });
  }
  test("退出网络失败保持未确认，退出收到 401 则要求重新登录", async ({ page }) => {
    const state = await setup(page);
    await openCandidate(page);
    state.logoutNetworkFailure = true;
    await page.locator("#logout").click();
    await expect(page.locator("#notice")).toHaveText(
      "请求未能确认完成，请重新读取后核对结果；不会自动重发写操作。",
    );
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#logout")).toBeEnabled();
    state.logoutNetworkFailure = false;
    state.loggedIn = false;
    await page.locator("#logout").click();
    await expect(page.locator("#notice")).toHaveText("需要重新登录管理端。");
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#notice")).not.toContainText("已退出管理端");
  });
  test.describe("非东八区浏览器", () => {
    test.use({ timezoneId: "America/Los_Angeles" });
    test("队列创建时间固定北京时间，保留日期、秒与源毫秒事实", async ({ page }) => {
      await setup(page);
      await page.goto("/admin/");
      await expect(page.locator("#queue-state")).toHaveText("已读完队列，共 1 个待审核候选。");
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
        "America/Los_Angeles",
      );
      const createdAt = page.locator("#queue time");
      await expect(createdAt).toHaveText("2030-03-18 01:46:40 · 北京时间 UTC+8");
      await expect(createdAt).toHaveAttribute("datetime", "2030-03-17T17:46:40.000Z");
      expect(Date.parse((await createdAt.getAttribute("datetime")) ?? "")).toBe(1_900_000_000_000);
    });
  });
  test("无普通导航入口，页面 noindex 且帮助说明可见", async ({ page }) => {
    await setup(page, { loggedIn: false });
    await page.goto("/");
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
    await page.goto("/admin/");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
    await expect(page.getByText(/建议用单独的浏览器配置文件/)).toBeVisible();
    await expect(page.locator("nav")).toHaveCount(0);
  });
});
