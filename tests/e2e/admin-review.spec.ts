import { expect, type Page, type Route, test } from "@playwright/test";
import type {
  CandidateDetail,
  QueuePage,
  VersionListing,
  VersionRecord,
} from "../../apps/web/src/features/admin/types";
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
// P3-17 合成 AI 草稿详情：可读正文、图片提示、草稿事件与说明；标题里混入注入字符串验证只按文本渲染。
const draftTitle = "「合成」祈愿：合成角色概率UP！";
function draftDetail(
  classification: "events" | "uncertain" | "no_event" = "events",
): CandidateDetail {
  const base = detail();
  const events =
    classification === "no_event"
      ? []
      : [
          {
            event_key: "primary",
            event_type: "gacha",
            status: "scheduled",
            title: `「合成」祈愿${injection}`,
            type_evidence: { block_ref: "blocks/0", quote: "「合成」祈愿", tag: null },
            status_evidence: null,
            milestones: [
              {
                milestone_key: "start",
                node_type: "start",
                title: "「合成」祈愿开始",
                time: {
                  precision: "unknown",
                  source_timezone: "UTC+08:00",
                  raw_expression: "7.1版本更新后",
                  time_basis: "unresolved",
                },
                time_evidence: { block_ref: "blocks/1", quote: "7.1版本更新后", tag: null },
              },
              {
                milestone_key: "end",
                node_type: "end",
                title: "「合成」祈愿结束",
                time: {
                  precision: "datetime",
                  utc_ms: Date.parse("2026-10-13T09:59:00Z"),
                  source_timezone: "UTC+08:00",
                  raw_expression: "2026/10/13 17:59",
                  time_basis: "official_explicit",
                },
                time_evidence: { block_ref: "blocks/1", quote: "2026/10/13 17:59", tag: "t_lc" },
              },
            ],
          },
        ];
  return {
    ...base,
    candidate: {
      ...base.candidate,
      proposal_json: {
        classification: "uncertain",
        events: [],
        ambiguities: ["未命中已核验规则模板"],
      },
    },
    article: {
      ...base.article,
      blocks: [
        { kind: "title", text: draftTitle },
        {
          kind: "html",
          html: '<p>7.1版本更新后 ~ &lt;t class="t_lc"&gt;2026/10/13 17:59&lt;/t&gt;</p>',
        },
      ],
    },
    readable_blocks: [draftTitle, "7.1版本更新后 ~ 2026/10/13 17:59"],
    media_count: 1,
    draft: {
      status: "ready",
      profile_ref: "@cf/qwen/qwen3-30b-a3b-fp8/draft-prompt-v1/candidate-schema-v1",
      article_version_id: "synthetic-version",
      proposal: {
        classification,
        events,
        ambiguities: classification === "uncertain" ? ["合成疑点：卡池时间与另一篇公告不同"] : [],
      },
      notes: ["事件 1：原文中找不到「2026/09/23 11:00」，已丢弃这个结束节点。"],
      reason_code: null,
      usage: { neurons: 13, prompt_tokens: 1219, completion_tokens: 221 },
      updated_at: 1_900_000_000_000,
      derived_count: 0,
      derivation_key: '[["7.1",0]]',
    },
  } as unknown as CandidateDetail;
}
const draftPages: QueuePage[] = [
  {
    candidates: [
      {
        id: "synthetic-candidate",
        created_at: 1_900_000_000_000,
        updated_at: 1_900_000_000_000,
        source_id: "genshin-ann",
        external_id: "synthetic-announcement",
        game: "genshin",
        title: draftTitle,
        draft_status: "ready",
      },
    ],
    next_cursor: null,
    ai_usage: { day: "2026-10-04", settled: 13, reserved: 0, cap: 6000 },
  },
];
async function openDraft(page: Page) {
  await page.goto("/admin/");
  await page.getByRole("button", { name: `查看候选 ${draftTitle}`, exact: true }).click();
  await expect(page.locator("#candidate-meta")).toContainText("已读版本");
}
// 运行开关面板（features/admin/controls.ts）在工作区出现时读取一次；形状同 Worker 的 GET /api/v2/admin/controls。
// P3-20：来源行带注册表能力与抓取状态（info）。
const controlRows = [
  { control: "read_only", value: false, updated_at: 1_900_000_000_000 },
  { control: "registration_open", value: true, updated_at: 1_900_000_000_000 },
  { control: "model_enabled", value: true, updated_at: 1_900_000_000_000 },
  // P3-25：后加的开关还没有记录时，Worker 按默认值读作关闭、版本 0。
  { control: "review_skip_enabled", value: false, updated_at: 0 },
  {
    control: "source_enabled",
    source: "genshin-ann",
    value: true,
    updated_at: 1_900_000_000_000,
    info: {
      game: "genshin",
      adapter: "announcement-webview",
      state: {
        verification_state: "verified-working",
        last_success_at: 1_900_000_000_000,
        updated_at: 1_900_000_000_000,
        job_status: "pending",
        job_last_error: null,
      },
    },
  },
  {
    control: "source_enabled",
    source: "hsr-ann",
    value: true,
    updated_at: 1_900_000_000_000,
    info: {
      game: "hsr",
      adapter: "announcement-webview",
      state: {
        verification_state: "maintenance-required",
        last_success_at: 1_899_000_000_000,
        updated_at: 1_899_500_000_000,
        job_status: "failed",
        job_last_error: "source_maintenance",
      },
    },
  },
  {
    control: "source_enabled",
    source: "zzz-ann",
    value: false,
    updated_at: 1_900_000_000_000,
    info: { game: "zzz", adapter: "announcement-webview", state: null },
  },
];
const controlsRead = `已读取 ${controlRows.length} 个开关。每次修改都会写入审计记录。`;
type Call = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  csrf?: string;
  url: string;
};
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
    pages: [] as QueuePage[],
    versions: { versions: [], suggestions: [], pending_references: {} } as VersionListing,
    controls: structuredClone(controlRows) as Record<string, unknown>[],
  };
  state.pages = options.pages ?? [
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
      method: req.method(),
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
    if (path === "admin/controls" && req.method() === "GET")
      return route.fulfill({ json: { server_time: 1_900_000_000_000, controls: state.controls } });
    if (path === "admin/controls" && req.method() === "PUT") {
      state.writes++;
      const row = state.controls.find(
        (item) => item.control === call.body.control && item.source === call.body.source,
      );
      if (row) Object.assign(row, { value: call.body.enabled, updated_at: 1_900_000_000_100 });
      return route.fulfill({ json: { ...call.body, value: call.body.enabled } });
    }
    if (path === "admin/sources/resume" && req.method() === "POST") {
      state.writes++;
      const row = state.controls.find((item) => item.source === call.body.source);
      const info = row?.info as { state: Record<string, unknown> } | undefined;
      if (info?.state) Object.assign(info.state, { verification_state: "verified-working" });
      return route.fulfill({ json: { resumed: true, source: call.body.source } });
    }
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
      return route.fulfill({ json: state.pages[index] });
    }
    if (path === "admin/versions" && req.method() === "GET")
      return route.fulfill({ json: state.versions });
    if (path.startsWith("admin/versions/") && req.method() === "POST") {
      state.writes++;
      if (state.write) return state.write(route, call);
      return route.fulfill({ json: { version: null } });
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
      if (path.endsWith("adopt-draft")) {
        // P3-17：服务端从已保存草稿生成候选；合成响应只模拟版本递增与内容替换。
        const draft = state.current.draft?.proposal;
        state.current.candidate.proposal_json =
          draft?.classification === "no_event"
            ? { classification: "no_event", events: [], ambiguities: [] }
            : { classification: "events", events: draft?.events ?? [], ambiguities: [] };
        return route.fulfill({
          json: {
            candidate_id: state.current.candidate.id,
            review_status: "pending",
            updated_at: state.current.candidate.updated_at,
          },
        });
      }
      if (path.endsWith("reject")) state.current.candidate.review_status = "rejected";
      else state.current.candidate.review_status = "approved";
      const noEvent =
        (state.current.candidate.proposal_json as { classification?: string }).classification ===
        "no_event";
      return route.fulfill({
        json: {
          candidate_id: state.current.candidate.id,
          review_status: state.current.candidate.review_status,
          updated_at: state.current.candidate.updated_at,
          publication: { outcome: noEvent ? "unchanged" : "published" },
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
    // P3-19：运行开关拆到独立页面，审核页登录后只读队列。
    await expect(page.locator("#controls-panel")).toHaveCount(0);
    const nonQueue = state.calls.filter((call) => call.path !== "admin/review/queue");
    expect(nonQueue.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST auth/preauth",
      "POST admin/session/bootstrap",
    ]);
    expect(nonQueue[1].body).toEqual({ secret: syntheticSecret });
    expect(nonQueue[1].csrf).toBe("synthetic-preauth");
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
    expect(state.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "admin/session/logout",
      csrf: "synthetic-admin",
    });
    // 每次工作区出现只读一次运行开关：不轮询、不写入。
    // P3-19：开关拆到独立页面，审核页不读取开关。
    expect(state.calls.filter((call) => call.path === "admin/controls")).toEqual([]);
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
    // P3-17：队列一页直接带来源与文章，不再逐条读详情；没有标题时读屏名退回候选 ID。
    const row = (id: string) => ({
      id,
      created_at: 1_900_000_000_000,
      updated_at: 1_900_000_000_000,
      source_id: "genshin-ann",
      external_id: "synthetic-announcement",
      game: "genshin",
      title: null,
      draft_status: null,
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
    await page.screenshot({ path: testInfo.outputPath("admin-review.png"), fullPage: true });
    // 移动端模拟下内容溢出会把 innerWidth（布局视口）一起撑宽；clientWidth 才保持设备宽度。
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
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
    // 只有管理端内部的三个页签，不出现公共站点导航或指向公共页面的链接。
    const tabs = page.getByRole("navigation", { name: "管理后台页面" }).getByRole("link");
    await expect(tabs).toHaveText(["审核", "版本时间表", "运行开关"]);
    await expect(page.locator("nav")).toHaveCount(1);
    await expect(
      page.locator('a[href="/"], a[href^="/subscription"], a[href^="/account"]'),
    ).toHaveCount(0);
  });
});

test.describe("A-P3-DRAFT", () => {
  test("队列一页显示标题与草稿状态；详情左原文右草稿，一键批准带排除路径与同一理由", async ({
    page,
  }, testInfo) => {
    // 走一遍真实登录，写请求才会带上 bootstrap 下发的管理员 CSRF。
    const state = await setup(page, { loggedIn: false, pages: draftPages });
    state.current = draftDetail();
    await page.goto("/admin/");
    await page.getByLabel("引导秘密").fill(syntheticSecret);
    await page.getByRole("button", { name: "登录管理端", exact: true }).click();
    await expect(page.locator("#queue")).toContainText(draftTitle);
    await expect(page.locator("#queue")).toContainText("原神");
    await expect(page.locator("#queue")).toContainText("AI 草稿就绪");
    await expect(page.locator("#ai-usage")).toHaveText(
      "今日 AI 草稿用量 13 / 6000 Neurons（UTC 2026-10-04）",
    );
    expect(state.reads).toBe(0);
    await page.getByRole("button", { name: `查看候选 ${draftTitle}`, exact: true }).click();
    await expect(page.locator("#detail-title")).toHaveText(draftTitle);
    await expect(page.locator("#readable-blocks")).toContainText(
      "7.1版本更新后 ~ 2026/10/13 17:59",
    );
    await expect(page.locator("#media-warning")).toBeVisible();
    await expect(page.locator("#draft-panel")).toContainText(
      "结束：2026-10-13 17:59（北京时间 UTC+8）",
    );
    await expect(page.locator("#draft-panel")).toContainText(
      "开始：7.1版本更新后（原文，未定时刻）",
    );
    await expect(page.locator("#draft-panel")).toContainText("已丢弃这个结束节点");
    await expect(page.locator("#draft-panel")).toContainText("<img src=x");
    await expect(page.locator("#review img")).toHaveCount(0);
    expect(await page.evaluate(() => "adminInjection" in window)).toBe(false);
    await expect(page.locator("#advanced")).not.toHaveAttribute("open", "");
    await page.screenshot({ path: testInfo.outputPath("admin-draft.png"), fullPage: true });
    await page.getByLabel("保留节点：开始 7.1版本更新后（原文，未定时刻）").uncheck();
    await page.getByLabel("常用理由").selectOption({ index: 1 });
    const reason = await page.getByLabel("操作理由", { exact: true }).inputValue();
    expect(reason).toBe("已对照官方原文核对，保留的时间与证据一致");
    await page.getByRole("button", { name: "采用草稿并批准", exact: true }).click();
    await expect(page.locator("#publication")).toContainText("已批准、已发布");
    const writes = state.calls.filter(
      (call) => call.method === "POST" && call.path.startsWith("admin/review/"),
    );
    expect(writes.map((call) => call.path)).toEqual([
      "admin/review/adopt-draft",
      "admin/review/approve",
    ]);
    expect(writes[0].body).toEqual({
      candidate_id: "synthetic-candidate",
      expected_updated_at: 1_900_000_000_000,
      expected_draft_updated_at: 1_900_000_000_000,
      expected_derivation_key: '[["7.1",0]]',
      reason,
      exclude: ["e0.m0"],
      confirm_ambiguities: false,
    });
    expect(writes[1].body).toEqual({
      candidate_id: "synthetic-candidate",
      expected_updated_at: 1_900_000_000_001,
      reason,
    });
    expect(writes.every((call) => call.csrf === "synthetic-admin")).toBe(true);
  });

  test("有疑点的草稿必须勾选确认后才能一键批准", async ({ page }) => {
    const state = await setup(page, { pages: draftPages });
    state.current = draftDetail("uncertain");
    await openDraft(page);
    await expect(page.locator("#draft-panel")).toContainText("合成疑点");
    await page.getByLabel("操作理由", { exact: true }).fill("合成人工核对理由");
    const adopt = page.getByRole("button", { name: "采用草稿并批准", exact: true });
    await expect(adopt).toBeDisabled();
    await page.getByLabel("我已对照原文核对，以上疑点不影响下面保留的日程").check();
    await expect(adopt).toBeEnabled();
    await adopt.click();
    await expect(page.locator("#publication")).toContainText("已批准、已发布");
    const adoptCall = state.calls.find((call) => call.path === "admin/review/adopt-draft");
    expect(adoptCall?.body.confirm_ambiguities).toBe(true);
  });

  test("AI 判断无日程时只显示确认无日程，结果如实显示未发生新发布", async ({ page }) => {
    const state = await setup(page, { pages: draftPages });
    state.current = draftDetail("no_event");
    await openDraft(page);
    await expect(page.getByRole("button", { name: "采用草稿并批准", exact: true })).toBeHidden();
    await page.getByLabel("常用理由").selectOption({ index: 2 });
    await page.getByRole("button", { name: "确认无日程", exact: true }).click();
    await expect(page.locator("#publication")).toContainText("已批准，本次未发生新发布");
    expect(state.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "admin/review/adopt-draft",
      "admin/review/approve",
    ]);
  });

  test("没填理由不发请求；采用遇到 409 时不提交批准并重新读取", async ({ page }) => {
    const state = await setup(page, { pages: draftPages });
    state.current = draftDetail();
    await openDraft(page);
    await page.getByRole("button", { name: "采用草稿并批准", exact: true }).click();
    await expect(page.locator("#reason-error")).toHaveText("请填写操作理由。");
    expect(state.writes).toBe(0);
    state.write = async (route) =>
      route.fulfill({ status: 409, json: buildApiErrorBody("conflict") });
    await page.getByLabel("操作理由", { exact: true }).fill("合成人工核对理由");
    await page.getByRole("button", { name: "采用草稿并批准", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("已在别处改过。已重新读取");
    expect(state.calls.filter((call) => call.path === "admin/review/approve")).toEqual([]);
  });
});

test.describe("P3-19 管理端拆页", () => {
  test("运行开关在独立页面：登录一次三页通用，审核页不再读取开关", async ({ page }) => {
    const state = await setup(page, {
      loggedIn: false,
      pages: [{ candidates: [], next_cursor: null }],
    });
    await page.goto("/admin/");
    await page.getByLabel("引导秘密").fill(syntheticSecret);
    await page.getByRole("button", { name: "登录管理端", exact: true }).click();
    await expect(page.getByText("没有待审核的候选", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "运行开关", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/settings\/$/);
    await expect(page.locator("#controls-status")).toHaveText(controlsRead);
    await expect(page.locator("#login")).toBeHidden();
    await expect(page.getByRole("link", { name: "运行开关", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(state.calls.filter((call) => call.path === "admin/session/bootstrap")).toHaveLength(1);
  });

  test("审核页按游戏与草稿状态筛选；处理完自动打开下一条", async ({ page }) => {
    const row = (id: string, game: string, title: string, draft: "ready" | null) => ({
      id,
      created_at: 1_900_000_000_000,
      updated_at: 1_900_000_000_000,
      source_id: `${game}-ann`,
      external_id: id,
      game,
      title,
      draft_status: draft,
    });
    const first = row("synthetic-candidate", "genshin", draftTitle, "ready");
    const second = row("synthetic-second", "hsr", "「合成」跃迁：第二条", null);
    const state = await setup(page, {
      pages: [{ candidates: [first, second], next_cursor: null }],
    });
    state.current = draftDetail();
    await page.goto("/admin/");
    await expect(page.locator("#queue-state")).toHaveText("已读完队列，共 2 个待审核候选。");
    await page.getByLabel("游戏").selectOption("hsr");
    await expect(page.locator("#queue .queue-item")).toHaveCount(1);
    await expect(page.locator("#queue-state")).toContainText("当前筛选显示 1 个");
    await page.getByLabel("游戏").selectOption("all");
    await page.getByLabel("草稿", { exact: true }).selectOption("ready");
    await expect(page.locator("#queue .queue-item")).toHaveCount(1);
    await page.getByLabel("草稿", { exact: true }).selectOption("all");
    await page.getByRole("button", { name: `查看候选 ${draftTitle}`, exact: true }).click();
    await expect(page.locator(`#queue .queue-item[data-id="synthetic-candidate"]`)).toHaveAttribute(
      "aria-current",
      "true",
    );
    // 批准后第一条离开队列：队列只剩第二条，页面自动打开它。
    state.write = async (route, call) => {
      if (call.path.endsWith("approve"))
        state.pages = [{ candidates: [second], next_cursor: null }];
      state.current.candidate.updated_at++;
      if (call.path.endsWith("adopt-draft"))
        return route.fulfill({
          json: {
            candidate_id: "synthetic-candidate",
            review_status: "pending",
            updated_at: state.current.candidate.updated_at,
          },
        });
      state.current.candidate.review_status = "approved";
      return route.fulfill({
        json: {
          candidate_id: "synthetic-candidate",
          review_status: "approved",
          updated_at: state.current.candidate.updated_at,
          publication: { outcome: "published" },
        },
      });
    };
    await page.getByLabel("操作理由", { exact: true }).fill("合成人工核对理由");
    await page.getByRole("button", { name: "采用草稿并批准", exact: true }).click();
    await expect(page.locator("#notice")).toHaveText("已处理完上一条，自动打开队列中的下一条。");
    await expect(page.locator("#publication")).toContainText("已批准、已发布");
    await expect(page.locator(`#queue .queue-item[data-id="synthetic-second"]`)).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  test("A-P3-VERSION 版本时间表：显示摘录与影响条数，采用与清除都带理由和已读版本", async ({
    page,
  }, testInfo) => {
    const state = await setup(page);
    state.versions = {
      versions: [
        {
          game: "hsr",
          version: "4.6",
          update_start_ms: Date.parse("2026-09-27T22:00:00Z"),
          update_start_source: "s46",
          version_end_ms: null,
          version_end_source: null,
          version_end_basis: null,
          updated_at: 1_900_000_000_500,
        },
      ],
      suggestions: [
        {
          id: "s46",
          game: "hsr",
          version: "4.6",
          article_version_id: "v46",
          title: "4.6版本「月升之前，与兽共舞」版本更新说明",
          official_url: "https://sr.mihoyo.com/news/46",
          update_start_ms: Date.parse("2026-09-27T22:00:00Z"),
          update_start: { block_ref: "blocks/10", quote: "2026/09/28 06:00:00" },
          update_duration: { block_ref: "blocks/10", quote: "预计5个小时完成" },
          version_end_ms: Date.parse("2026-11-10T22:00:00Z"),
          version_end: { block_ref: "blocks/7", quote: "2026/11/11 06:00:00" },
          created_at: 1_900_000_000_000,
        },
      ],
      pending_references: { "hsr:4.6": 3 },
    };
    await page.goto("/admin/versions/");
    const card = page.getByRole("article", { name: "崩坏：星穹铁道 4.6 版本" });
    await expect(card).toContainText("影响 3 条待审草稿");
    await expect(card).toContainText("2026-09-28 06:00（北京时间 UTC+8）");
    await expect(card).toContainText("预计5个小时完成");
    await expect(page.getByRole("article", { name: "原神 7.1 版本" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("admin-versions.png"), fullPage: true });
    // 没填理由不发请求。
    await card.getByRole("button", { name: "采用", exact: true }).click();
    await expect(page.locator("#reason-error")).toHaveText("请先填写或选择确认理由。");
    expect(state.writes).toBe(0);
    await page.getByLabel("常用理由").selectOption({ index: 1 });
    await card.getByRole("button", { name: "采用", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("已确认");
    const confirm = state.calls.find((call) => call.path === "admin/versions/confirm");
    expect(confirm?.body).toEqual({
      game: "hsr",
      version: "4.6",
      field: "version_end",
      suggestion_id: "s46",
      expected_updated_at: 1_900_000_000_500,
      reason: "已对照版本公告原文核对",
    });
    await card.getByRole("button", { name: "清除确认", exact: true }).click();
    const clear = state.calls.find((call) => call.path === "admin/versions/clear");
    expect(clear?.body).toEqual({
      game: "hsr",
      version: "4.6",
      field: "update_start",
      expected_updated_at: 1_900_000_000_500,
      reason: "已对照版本公告原文核对",
    });
    expect(
      state.calls.filter((call) => call.method === "POST").every((call) => call.csrf !== undefined),
    ).toBe(true);
  });

  test("A-P3-VERSION 版本结束只取紧接着的下一版本：被引用的更新开始锁定，采用带上看到的值", async ({
    page,
  }) => {
    const state = await setup(page);
    const at = (iso: string) => Date.parse(iso);
    const row = (version: string, fields: Partial<VersionRecord>): VersionRecord => ({
      game: "hsr",
      version,
      update_start_ms: null,
      update_start_source: null,
      version_end_ms: null,
      version_end_source: null,
      version_end_basis: null,
      updated_at: 1_900_000_000_500,
      ...fields,
    });
    const suggestion = (id: string, version: string, start: number) => ({
      id,
      game: "hsr",
      version,
      article_version_id: `v-${id}`,
      title: `${version}版本更新说明`,
      official_url: `https://sr.mihoyo.com/news/${id}`,
      update_start_ms: start,
      update_start: { block_ref: "blocks/3", quote: "合成时刻" },
      update_duration: null,
      version_end_ms: null,
      version_end: null,
      created_at: 1_900_000_000_000,
    });
    state.versions = {
      versions: [
        row("4.8", { update_start_ms: at("2026-12-09T22:00:00Z"), update_start_source: "s48" }),
        row("4.6", { update_start_ms: at("2026-09-27T22:00:00Z"), update_start_source: "s46" }),
        row("4.5", {
          update_start_ms: at("2026-08-16T22:00:00Z"),
          update_start_source: "s45",
          version_end_ms: at("2026-09-27T22:00:00Z"),
          version_end_source: "s46",
          version_end_basis: "next_update",
        }),
        row("4.4", {}),
      ],
      suggestions: [suggestion("s47", "4.7", at("2026-11-04T22:00:00Z"))],
      pending_references: {},
    };
    await page.goto("/admin/versions/");
    const card = (version: string) =>
      page.getByRole("article", { name: `崩坏：星穹铁道 ${version} 版本` });
    // 4.6 的更新开始被 4.5 的结束引用：只给提示，不给修改或清除。
    await expect(card("4.6")).toContainText("已被 4.5 版本的结束引用");
    await expect(card("4.6").getByRole("button", { name: "清除确认" })).toHaveCount(0);
    // 4.6 的下一版本是 4.7（只有摘录、未确认）：提示先确认，不跳过去取 4.8。
    await expect(card("4.6")).toContainText("下一版本 4.7 的更新开始尚未确认");
    await expect(card("4.6")).not.toContainText("取 4.8 版本的更新开始");
    // 4.5 已按 4.6 的更新开始确认且值一致：不重复列出。
    await expect(card("4.5")).toContainText("（取下一版本的更新开始）");
    await expect(card("4.5")).not.toContainText("取 4.6 版本的更新开始");
    // 摘录附官方原文链接。
    await expect(card("4.7").getByRole("link", { name: "打开官方原文" })).toHaveAttribute(
      "href",
      "https://sr.mihoyo.com/news/s47",
    );
    // 4.4 取 4.5 的更新开始：请求带上页面上看到的那个值。
    await page.getByLabel("常用理由").selectOption({ index: 1 });
    await card("4.4")
      .getByRole("listitem")
      .filter({ hasText: "取 4.5 版本的更新开始" })
      .getByRole("button", { name: "采用" })
      .click();
    await expect(page.locator("#notice")).toContainText("已确认");
    expect(state.calls.find((call) => call.path === "admin/versions/confirm")?.body).toEqual({
      game: "hsr",
      version: "4.4",
      field: "version_end",
      from_next_version: true,
      expected_next_update_start_ms: at("2026-08-16T22:00:00Z"),
      expected_updated_at: 1_900_000_000_500,
      reason: "已对照版本公告原文核对",
    });
  });
});

test.describe("P3-20 运行开关", () => {
  test("页面内二次确认：不弹浏览器确认框；未选理由、取消都不发请求，确认后写入并重新读取", async ({
    page,
  }) => {
    const state = await setup(page);
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await page.goto("/admin/settings/");
    await expect(page.locator("#controls-status")).toHaveText(controlsRead);
    // 按开关名称找行：其他开关的说明里也会提到"只读模式"。
    const row = page
      .locator(".control-row")
      .filter({ has: page.locator(".control-name", { hasText: "只读模式" }) });
    await row.getByRole("button", { name: "开启", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText("请先在上方选择修改理由。");
    await page.getByLabel("修改理由（每次修改都会记录）").selectOption("maintenance");
    await row.getByRole("button", { name: "开启", exact: true }).click();
    const confirm = row.getByRole("group", { name: "确认开启" });
    await expect(confirm).toContainText(
      "确认开启「只读模式」？这会立即影响线上服务，并写入审计记录。",
    );
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText("已取消，没有修改。");
    await expect(confirm).toHaveCount(0);
    expect(state.calls.filter((call) => call.method === "PUT")).toEqual([]);
    await row.getByRole("button", { name: "开启", exact: true }).click();
    await row.getByRole("button", { name: "确认开启", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText(
      "已开启「只读模式」，已重新读取核实。",
    );
    const writes = state.calls.filter((call) => call.method === "PUT");
    expect(writes.map((call) => call.body)).toEqual([
      {
        control: "read_only",
        enabled: true,
        expected_updated_at: 1_900_000_000_000,
        reason: "maintenance",
      },
    ]);
    await expect(row.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
    expect(dialogs).toBe(0);
  });

  test("来源行写明能抓什么与抓取状态：未建立的来源如实说明，维护中的来源可在行内确认后解除", async ({
    page,
  }) => {
    const state = await setup(page);
    await page.goto("/admin/settings/");
    await expect(page.locator("#controls-status")).toHaveText(controlsRead);
    const genshin = page.locator(".control-row").filter({ hasText: "原神游戏内公告" });
    await expect(genshin).toContainText("抓取公告列表（含图文资讯）与完整正文");
    await expect(genshin).toContainText("最近成功抓取：");
    const zzz = page.locator(".control-row").filter({ hasText: "绝区零游戏内公告" });
    await expect(zzz).toContainText("抓取公告列表（含图文资讯）与完整正文");
    await expect(zzz).toContainText("抓取状态：尚未建立");
    const hsr = page.locator(".control-row").filter({ hasText: "崩坏：星穹铁道游戏内公告" });
    await expect(hsr).toContainText("需维护");
    await page.getByLabel("修改理由（每次修改都会记录）").selectOption("evidence_reviewed");
    await hsr.getByRole("button", { name: "解除维护", exact: true }).click();
    await expect(hsr.getByRole("group", { name: "确认解除维护" })).toContainText(
      "源站仍受限时会重新进入维护",
    );
    await hsr.getByRole("button", { name: "确认解除维护", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText(
      "已解除「来源抓取 · 崩坏：星穹铁道游戏内公告」的维护，下一次轮询会重新抓取。",
    );
    expect(
      state.calls.filter((call) => call.path === "admin/sources/resume").map((call) => call.body),
    ).toEqual([
      { source: "hsr-ann", expected_updated_at: 1_899_500_000_000, reason: "evidence_reviewed" },
    ]);
    await expect(hsr.getByRole("button", { name: "解除维护", exact: true })).toHaveCount(0);
  });

  test("A-P3-REVIEW-SKIP 跳过审核在「数据管线」组，默认关闭、写明不经人工核对；开启须页面内确认，首行以版本 0 写入", async ({
    page,
  }) => {
    const state = await setup(page);
    await page.goto("/admin/settings/");
    await expect(page.locator("#controls-status")).toHaveText(controlsRead);
    const pipeline = page.locator(".control-group").filter({ hasText: "数据管线" });
    const named = (name: string) =>
      pipeline
        .locator(".control-row")
        .filter({ has: page.locator(".control-name", { hasText: name }) });
    const row = named("跳过审核");
    await expect(row.locator(".control-name .badge")).toHaveText("关");
    await expect(row).toContainText("不经人工核对");
    await expect(row).toContainText("仍留在审核队列");
    await expect(named("AI 草稿（模型抽取）")).toHaveCount(1);
    await page.getByLabel("修改理由（每次修改都会记录）").selectOption("verified_configuration");
    await row.getByRole("button", { name: "开启", exact: true }).click();
    await expect(row.getByRole("group", { name: "确认开启" })).toContainText("跳过审核");
    expect(state.calls.filter((call) => call.method === "PUT")).toEqual([]);
    await row.getByRole("button", { name: "确认开启", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText(
      "已开启「跳过审核」，已重新读取核实。",
    );
    expect(state.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
      {
        control: "review_skip_enabled",
        enabled: true,
        expected_updated_at: 0,
        reason: "verified_configuration",
      },
    ]);
  });

  test("ADR-0033 直播兑换码来源没有开关记录时显示「关」、可以开启（首行以版本 0 写入）；开启即全自动，手动登记是收起的备用方案", async ({
    page,
  }) => {
    const state = await setup(page);
    state.controls.push({
      control: "source_enabled",
      source: "zzz-live",
      value: false,
      updated_at: 0,
      info: { game: "zzz", adapter: "miyolive", state: null, lives: { hints: [], tracked: [] } },
    });
    await page.goto("/admin/settings/");
    await expect(page.locator("#controls-status")).toHaveText(
      `已读取 ${controlRows.length + 1} 个开关。每次修改都会写入审计记录。`,
    );
    const row = page.locator(".control-row").filter({ hasText: "绝区零直播兑换码" });
    await expect(row.locator(".control-name .badge")).toHaveText("关");
    await expect(row).toContainText("开启后全自动");
    await expect(row).toContainText("正在跟踪的直播：暂无（开启后自动从米游社首页发现）");
    // 手动登记默认收起，展开后才看到输入框；重绘后保持展开。
    const manual = row.locator("details.control-live-manual");
    await expect(manual.locator("summary")).toHaveText("备用：手动登记直播");
    await expect(row.getByRole("textbox")).toBeHidden();
    await manual.locator("summary").click();
    await expect(row.getByRole("textbox")).toBeVisible();
    const toggle = row.getByRole("button", { name: "开启", exact: true });
    await expect(toggle).toBeEnabled();
    await page.getByLabel("修改理由（每次修改都会记录）").selectOption("verified_configuration");
    await toggle.click();
    await row.getByRole("button", { name: "确认开启", exact: true }).click();
    await expect(page.locator("#controls-status")).toHaveText(
      "已开启「来源抓取 · 绝区零直播兑换码」，已重新读取核实。",
    );
    expect(state.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
      {
        control: "source_enabled",
        source: "zzz-live",
        enabled: true,
        expected_updated_at: 0,
        reason: "verified_configuration",
      },
    ]);
    await expect(row.locator(".control-name .badge")).toHaveText("开");
    await expect(row).toContainText("正在跟踪的直播：暂无（每次轮询自动从米游社首页发现）");
    await expect(row.getByRole("textbox")).toBeVisible();
  });
});
