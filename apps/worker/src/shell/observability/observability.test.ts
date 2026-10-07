import { MAIL_FEEDBACK_TTL } from "@hoyo/contracts";
import { observeFeedbackGrowth } from "./feedback";
import "../../admin/test-support";
import { env } from "cloudflare:test";
import {
  EXECUTOR_BATCH_WALL_LIMIT,
  FEED_MAX_STALE,
  OBS_METRICS,
  OPERATIONAL_CONTROLS,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { combinedAuthenticator, issueAdminSession } from "../../admin/session";
import { readPipelineControls } from "../../executors/pipeline/controls";
import { maintainFeedback } from "../../scheduled/feedback";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { isLiveEntry, SOURCE_REGISTRY } from "../../sources/registry";
import { generateSecretToken } from "../../storage/crypto/random";
import { ADMIN_SESSION_COOKIE_NAME, USER_SESSION_COOKIE_NAME } from "../domains";
import { fakeExecutionContext, testKeyring } from "../test-support";
import { controlsAllow, readControl } from "./controls";
import { readMetric, recordMetric } from "./metrics";
import { withOperationalControls } from "./route-controls";
import { makeObservabilityRoutes } from "./routes";
import { readObservability } from "./views";

let now = 1_900_000_000_000;
const origin = "https://synthetic.example";
const shell = createApiShell({
  authenticator: combinedAuthenticator(
    env.DB,
    () => testKeyring,
    () => now,
  ),
  csrfKey: async () => (await testKeyring).csrf(),
  routes: makeObservabilityRoutes(() => now),
});
async function admin() {
  const s = await issueAdminSession(env.DB, await testKeyring, "owner", "synthetic", now);
  const csrf = await mintCsrfToken(
    (await testKeyring).csrf(),
    s.tokenHash,
    generateSecretToken().bytes,
  );
  return {
    origin,
    "content-type": "application/json",
    [CSRF_HEADER_NAME]: csrf,
    cookie: `${ADMIN_SESSION_COOKIE_NAME}=${s.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
  };
}
const request = (path: string, headers: Record<string, string>, body?: unknown) =>
  shell.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "PUT",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    fakeExecutionContext,
  );
const body = (control = "outbound_enabled", enabled = false, expected_updated_at = 0) => ({
  control,
  enabled,
  expected_updated_at,
  reason: "maintenance",
});
async function set(key: string, value: boolean) {
  await env.DB.prepare(
    "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  )
    .bind(key, JSON.stringify(value), now)
    .run();
}
beforeEach(async () => {
  now++;
  await env.DB.exec(
    "DELETE FROM system_state; DELETE FROM audit_log; DELETE FROM admin_sessions; DELETE FROM usage_periods; DELETE FROM outbox; DELETE FROM activity_write_failures;",
  );
});
describe("A-P5-OBS 管理写权限和原子审计", () => {
  it("无凭证和用户 cookie 不可读管理员指标", async () => {
    expect((await request("/api/v2/admin/observability", {})).status).toBe(401);
    expect(
      (await request("/api/v2/admin/controls", { cookie: `${USER_SESSION_COOKIE_NAME}=synthetic` }))
        .status,
    ).toBe(401);
  });
  it("缺 CSRF、跨源、其他管理员会话的绑定均拒绝", async () => {
    const a = await admin(),
      b = await admin();
    for (const headers of [
      { ...a, [CSRF_HEADER_NAME]: "" },
      { ...a, origin: "https://other.example" },
      { ...b, cookie: a.cookie },
    ])
      expect((await request("/api/v2/admin/controls", headers, body())).status).toBe(401);
    expect((await readControl(env.DB, "outbound_enabled")).value).toBe("unknown");
  });
  it("并发创建只有一次写及一次审计，旧版本不得覆盖", async () => {
    const a = await admin();
    const r = await Promise.all([
      request("/api/v2/admin/controls", a, body()),
      request("/api/v2/admin/controls", a, body()),
    ]);
    expect(r.map((v) => v.status).sort()).toEqual([200, 409]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE target_type='operational_control'",
      ).first("n"),
    ).toBe(1);
    const state = await readControl(env.DB, "outbound_enabled");
    now++;
    expect(
      (await request("/api/v2/admin/controls", a, body("outbound_enabled", true, state.updated_at)))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          "/api/v2/admin/controls",
          a,
          body("outbound_enabled", false, state.updated_at),
        )
      ).status,
    ).toBe(409);
  });
  it("审计失败回滚开关；原因不接受秘密或空字符串", async () => {
    const a = await admin();
    for (const reason of ["", "synthetic@example.test"])
      expect((await request("/api/v2/admin/controls", a, { ...body(), reason })).status).toBe(400);
    await env.DB.exec(
      "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    try {
      expect((await request("/api/v2/admin/controls", a, body())).status).toBe(503);
      expect((await readControl(env.DB, "outbound_enabled")).value).toBe("unknown");
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_audit_failure;");
    }
  });
  it.each(OPERATIONAL_CONTROLS)("独立写 %s，其他开关不被隐式改动", async (control) => {
    const a = await admin();
    const input = {
      ...body(control, true),
      ...(control === "source_enabled" ? { source: SOURCE_REGISTRY[0].sourceId } : {}),
    };
    const response = await request("/api/v2/admin/controls", a, input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM system_state").first("n")).toBe(1);
  });
  it("A-P3-REVIEW-SKIP 跳过审核没有记录时读作关闭（其他开关仍是未知）；以版本 0 写入首行，且只在 AI 草稿可用时生效", async () => {
    const a = await admin();
    const listed = (await (await request("/api/v2/admin/controls", a)).json()) as {
      controls: { control: string; value: unknown; updated_at: number }[];
    };
    expect(listed.controls.find((row) => row.control === "review_skip_enabled")).toEqual({
      control: "review_skip_enabled",
      value: false,
      updated_at: 0,
    });
    expect(listed.controls.find((row) => row.control === "model_enabled")?.value).toBe("unknown");
    expect(await controlsAllow(env.DB, "review_skip_enabled")).toBe(false);
    expect(
      (await request("/api/v2/admin/controls", a, body("review_skip_enabled", true))).status,
    ).toBe(200);
    expect((await readControl(env.DB, "review_skip_enabled")).value).toBe(true);
    // 开关打开但 AI 草稿不可用（外发、只读、模型任一不满足）时不生效。
    expect((await readPipelineControls(env.DB)).reviewSkip).toBe(false);
    await set("outbound_enabled", true);
    await set("model_enabled", true);
    expect((await readPipelineControls(env.DB)).reviewSkip).toBe(true);
    await set("read_only", true);
    expect((await readPipelineControls(env.DB)).reviewSkip).toBe(false);
  });
  it("ADR-0033 来源开关没有记录时读作关闭、版本 0：初始化之后才登记的直播兑换码来源能以版本 0 开启，开启后管线即启用", async () => {
    const a = await admin();
    const listed = (await (await request("/api/v2/admin/controls", a)).json()) as {
      controls: { control: string; source?: string; value: unknown; updated_at: number }[];
    };
    const live = SOURCE_REGISTRY.filter(isLiveEntry).map((entry) => entry.sourceId);
    expect(live).toEqual(["genshin-live", "hsr-live", "zzz-live"]);
    for (const source of live)
      expect(listed.controls.find((row) => row.source === source)).toMatchObject({
        control: "source_enabled",
        value: false,
        updated_at: 0,
      });
    // 全局开关没有记录时仍是未知（首次关闭门初始化必须逐项写入）。
    expect(listed.controls.find((row) => row.control === "outbound_enabled")?.value).toBe(
      "unknown",
    );
    await set("outbound_enabled", true);
    expect((await readPipelineControls(env.DB)).sources["zzz-live"].enabled).toBe(false);
    const write = await request("/api/v2/admin/controls", a, {
      ...body("source_enabled", true),
      source: "zzz-live",
    });
    expect(write.status).toBe(200);
    expect((await readControl(env.DB, "source_enabled", "zzz-live")).value).toBe(true);
    expect((await readPipelineControls(env.DB)).sources["zzz-live"].enabled).toBe(true);
    // 有了记录之后，版本 0 不能再覆盖它。
    expect(
      (
        await request("/api/v2/admin/controls", a, {
          ...body("source_enabled", false),
          source: "zzz-live",
        })
      ).status,
    ).toBe(409);
    expect((await readControl(env.DB, "source_enabled", "zzz-live")).value).toBe(true);
  });
  it("来源只认注册表，不接受任意 URL；缺配置不启用管线", async () => {
    const a = await admin();
    expect(
      (
        await request("/api/v2/admin/controls", a, {
          ...body("source_enabled", true),
          source: "https://private.example",
        })
      ).status,
    ).toBe(400);
    expect(await controlsAllow(env.DB, "outbound_enabled")).toBe(false);
    expect(
      Object.values((await readPipelineControls(env.DB)).sources).every((v) => !v.enabled),
    ).toBe(true);
    await set("outbound_enabled", true);
    await set(`source:${SOURCE_REGISTRY[0].sourceId}`, true);
    expect((await readPipelineControls(env.DB)).sources[SOURCE_REGISTRY[0].sourceId].enabled).toBe(
      true,
    );
    await set("read_only", true);
    expect((await readPipelineControls(env.DB)).sources[SOURCE_REGISTRY[0].sourceId].enabled).toBe(
      false,
    );
  });
});
describe("A-P5-OBS 指标和证据边界", () => {
  it("固定槽并发累加、日界覆盖、迟到旧日不覆盖新日", async () => {
    await Promise.all([
      recordMetric(env.DB, "feed_shrink_guard", now),
      recordMetric(env.DB, "feed_shrink_guard", now),
    ]);
    expect((await readMetric(env.DB, "feed_shrink_guard", now))?.count).toBe(2);
    const tomorrow = utcDayPeriod(now).endMsExclusive;
    await recordMetric(env.DB, "feed_shrink_guard", tomorrow);
    await recordMetric(env.DB, "feed_shrink_guard", now);
    expect((await readMetric(env.DB, "feed_shrink_guard", tomorrow))?.count).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM system_state WHERE key LIKE 'obs:%'").first(
        "n",
      ),
    ).toBe(1);
  });
  it("全部历史事件单次告警、主机聚合不记录 URL", async () => {
    for (const m of OBS_METRICS) await recordMetric(env.DB, m, now);
    const host = SOURCE_REGISTRY[0].approvedHosts[0];
    await recordMetric(env.DB, "source_response_truncated", now, 1, host);
    const v = await readObservability(env.DB, now);
    for (const code of [
      "feed_shrink_guard",
      "mail_provider_unknown",
      "delivery_budget_failed",
      "delivery_dispatch_failed",
      "snapshot_build_failed",
      `source_response_truncated:${host}`,
    ])
      expect(v.alerts).toContainEqual({ code, state: "alert" });
    expect(v.mail_merge_ratio).toBe(1);
    expect(v.seat_renew_release_ratio).toBe(1);
    expect(JSON.stringify(v)).not.toContain("email_ciphertext");
  });
  it("空库、平台缺失和没有回收数据保持 unknown；回收暂停", async () => {
    const v = await readObservability(env.DB, now);
    expect(v.platform.every((x) => x.fact === null)).toBe(true);
    expect(v.reclaim.accounts_paused).toBe(true);
    expect(v.mail_merge_ratio).toBeNull();
    expect(v.seat_renew_release_ratio).toBeNull();
    expect(v.pools?.auth.remaining).toBeGreaterThan(0);
    expect(v.metrics.feed_shrink_guard).toBeNull();
  });
  it("平台事实带时间周期，过期回到 unknown，不把本地 CPU 当真实值", async () => {
    const a = await admin();
    const fact = {
      metric: "queue_dlq_backlog",
      value: 2,
      observed_at: now,
      period_start: now - 1,
      period_end: now + 1,
      reason: "evidence_reviewed",
    };
    expect((await request("/api/v2/admin/observability/platform", a, fact)).status).toBe(200);
    expect((await readObservability(env.DB, now)).alerts).toContainEqual({
      code: "platform:queue_dlq_backlog",
      state: "alert",
    });
    now++;
    expect(
      (await readObservability(env.DB, now)).platform.find((x) => x.metric === "queue_dlq_backlog")
        ?.fact,
    ).toBeNull();
  });
  it("快照 pending 超过 FEED_MAX_STALE 告警", async () => {
    await env.DB.prepare(
      "INSERT INTO outbox(id,topic,dedupe_key,payload_json,created_at,dispatch_state) VALUES ('synthetic','snapshot_rebuild','synthetic','{}',?,'pending')",
    )
      .bind(now - FEED_MAX_STALE * 1000)
      .run();
    expect((await readObservability(env.DB, now)).alerts).toContainEqual({
      code: "snapshot_lag",
      state: "alert",
    });
  });
  it("无 Queue 流量仍逐页推进，失败不阻断另一相，墙钟到期停止", async () => {
    let tick = now;
    const prune = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const reconcile = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const ring = await testKeyring;
    const keys = async () => ({ lookup: ring.emailLookup(), field: ring.fieldEncryption() });
    await maintainFeedback(env.DB, keys, () => tick, { prune, reconcile });
    expect(prune).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    prune.mockImplementation(async () => {
      tick += EXECUTOR_BATCH_WALL_LIMIT * 1000;
      return 1;
    });
    reconcile.mockClear();
    await maintainFeedback(env.DB, keys, () => tick, { prune, reconcile });
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("只读只拦扩大，不拦退订、停用、撤销及删除", async () => {
    await set("read_only", true);
    for (const path of [
      "/unsubscribe/*",
      "/email/one-click/*",
      "/api/v2/me/calendar/disable",
      "/api/v2/me/delete",
      "/api/v2/auth/logout",
      "/api/v2/auth/recovery",
    ]) {
      const hit = vi.fn(async () => new Response(null, { status: 204 }));
      const route = withOperationalControls([
        { method: "POST", pattern: path, domain: "public", write: true, handler: hit },
      ])[0];
      await route.handler({ env } as Parameters<typeof route.handler>[0]);
      expect(hit).toHaveBeenCalledOnce();
    }
  });
});

it("P5 无 Queue 流量真实清理过期未关联反馈，增长基于两次采样", async () => {
  const ring = await testKeyring;
  const keys = async () => ({ lookup: ring.emailLookup(), field: ring.fieldEncryption() });
  await env.DB.exec("DELETE FROM mail_feedback");
  await observeFeedbackGrowth(env.DB, now);
  await env.DB.prepare(
    "INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at) VALUES ('synthetic-observation','synthetic-observation','synthetic-observation','delivered',?,'{}',?)",
  )
    .bind(now, now - MAIL_FEEDBACK_TTL * 1000)
    .run();
  now++;
  await maintainFeedback(env.DB, keys, () => now);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_feedback").first("n")).toBe(0);
  expect((await readObservability(env.DB, now)).alerts).toContainEqual({
    code: "unmatched_expired",
    state: "alert",
  });
  now++;
  await observeFeedbackGrowth(env.DB, now);
  expect((await readObservability(env.DB, now)).alerts).toContainEqual({
    code: "unmatched_expired",
    state: "clear",
  });
});

it("未配置密钥且无待关联反馈不记维护故障；有待关联反馈时仍如实记故障", async () => {
  await env.DB.exec("DELETE FROM mail_feedback");
  const keys = vi.fn(async (): Promise<never> => {
    throw new Error("mail_keys_unconfigured");
  });
  await maintainFeedback(env.DB, keys, () => now);
  expect(keys).not.toHaveBeenCalled();
  expect(await readMetric(env.DB, "feedback_maintenance_failed", now)).toBeNull();
  await env.DB.prepare(
    `INSERT INTO mail_outbox(id,purpose,priority,period_key,address_version,payload_kind,status,message_id,created_at,updated_at)
    VALUES ('synthetic-keys-outbox','existing_auth',0,'synthetic',1,'synthetic','accepted','<synthetic-keys@mail.example.com>',?,?)`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at)
    VALUES ('synthetic-keys','synthetic-keys','<synthetic-keys@mail.example.com>','delivered',?,?,?)`,
  )
    .bind(now, JSON.stringify({ stage: "pending", leaseUntil: 0, token: null }), now)
    .run();
  try {
    await maintainFeedback(env.DB, keys, () => now);
    expect(keys).toHaveBeenCalled();
    expect((await readMetric(env.DB, "feedback_maintenance_failed", now))?.count).toBe(1);
  } finally {
    await env.DB.exec("DELETE FROM mail_feedback");
    await env.DB.prepare("DELETE FROM mail_outbox WHERE id='synthetic-keys-outbox'").run();
  }
});

it("反馈维护一相失败不会遮蔽另一相，记录固定故障而不无限重试", async () => {
  const ring = await testKeyring;
  const prune = vi.fn().mockRejectedValue(new Error("synthetic"));
  const reconcile = vi.fn().mockResolvedValue(0);
  await maintainFeedback(
    env.DB,
    async () => ({ lookup: ring.emailLookup(), field: ring.fieldEncryption() }),
    () => now,
    { prune, reconcile },
  );
  expect(prune).toHaveBeenCalledOnce();
  expect(reconcile).toHaveBeenCalledOnce();
  expect((await readMetric(env.DB, "feedback_maintenance_failed", now))?.count).toBe(1);
});

describe("终态可见且只能由所有者有意解除", () => {
  const post = (path: string, headers: Record<string, string>, payload: unknown) =>
    shell.fetch(
      new Request(origin + path, { method: "POST", headers, body: JSON.stringify(payload) }),
      env,
      fakeExecutionContext,
    );
  const source = SOURCE_REGISTRY[0];
  const jobId = `pipeline:source:${source.sourceId}`;
  async function seedMaintenance() {
    await env.DB.exec("DELETE FROM jobs; DELETE FROM sources;");
    await env.DB.prepare(
      `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at)
      VALUES (?,?,?,?,'[]','[]','{}','{}','maintenance-required',?,?,?)`,
    )
      .bind(
        source.sourceId,
        source.game,
        source.region,
        source.adapterId,
        now - 1,
        now - 1,
        now - 1,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload_json,due_at,status,attempts,last_error,created_at,updated_at)
      VALUES (?,'pipeline_source',?,?,'failed',3,'source_maintenance',?,?)`,
    )
      .bind(
        jobId,
        JSON.stringify({ sourceId: source.sourceId, page: { stale: true } }),
        now,
        now,
        now,
      )
      .run();
  }
  it("来源维护锁、来源待办失败与投递核心终态都持续告警，并给出解除所需的版本", async () => {
    await seedMaintenance();
    await env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload_json,due_at,status,attempts,last_error,created_at,updated_at)
      VALUES ('delivery:backoff','delivery_backoff','{}',?,'failed',2,'invalid_data',?,?)`,
    )
      .bind(now, now, now - 1)
      .run();
    const v = await readObservability(env.DB, now);
    expect(v.alerts).toContainEqual({
      code: `source_maintenance:${source.sourceId}`,
      state: "alert",
    });
    expect(v.alerts).toContainEqual({
      code: `source_job_failed:${source.sourceId}`,
      state: "alert",
    });
    expect(v.alerts).toContainEqual({
      code: `source_maintenance:${SOURCE_REGISTRY[1].sourceId}`,
      state: "clear",
    });
    expect(v.alerts).toContainEqual({ code: "delivery_failed_jobs", state: "alert" });
    expect(v.failed_jobs).toContainEqual({
      id: "delivery:backoff",
      status: "failed",
      last_error: "invalid_data",
      attempts: 2,
      updated_at: now - 1,
    });
    expect(v.source_states).toContainEqual(
      expect.objectContaining({
        source_id: source.sourceId,
        verification_state: "maintenance-required",
        updated_at: now - 1,
        job_status: "failed",
      }),
    );
  });
  it("A-P3-CONTROLS 运行开关的来源行带能力与抓取状态：仅列表来自注册表，维护中给出解除所需版本", async () => {
    await seedMaintenance();
    const response = await request("/api/v2/admin/controls", await admin());
    expect(response.status).toBe(200);
    const { controls } = (await response.json()) as {
      controls: { control: string; source?: string; info?: Record<string, unknown> }[];
    };
    const rows = controls.filter((row) => row.control === "source_enabled");
    expect(rows.map((row) => row.source)).toEqual(SOURCE_REGISTRY.map((entry) => entry.sourceId));
    expect(rows.find((row) => row.source === source.sourceId)?.info).toEqual({
      game: source.game,
      adapter: source.adapterKind,
      state: {
        verification_state: "maintenance-required",
        last_success_at: now - 1,
        updated_at: now - 1,
        job_status: "failed",
        job_last_error: "source_maintenance",
      },
    });
    const unopened = SOURCE_REGISTRY.find((entry) => entry.sourceId !== source.sourceId);
    expect(unopened).toBeDefined();
    // 来源行尚未建立（开关从未开过）时状态为 null，能力照样来自注册表。
    expect(rows.find((row) => row.source === unopened?.sourceId)?.info).toEqual({
      game: unopened?.game,
      adapter: unopened?.adapterKind,
      state: null,
    });
    expect(
      controls.filter((row) => row.control !== "source_enabled").every((row) => !row.info),
    ).toBe(true);
  });
  it("解除来源维护：恢复注册表状态、只放回一次轮询并审计；版本过期、非维护或租约中均冲突", async () => {
    await seedMaintenance();
    const a = await admin();
    const payload = {
      source: source.sourceId,
      expected_updated_at: now - 1,
      reason: "evidence_reviewed",
    };
    expect(
      (await post("/api/v2/admin/sources/resume", a, { ...payload, source: "unknown" })).status,
    ).toBe(400);
    expect(
      (await post("/api/v2/admin/sources/resume", a, { ...payload, reason: "free text" })).status,
    ).toBe(400);
    await env.DB.prepare("UPDATE jobs SET status='leased' WHERE id=?").bind(jobId).run();
    expect((await post("/api/v2/admin/sources/resume", a, payload)).status).toBe(409);
    await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?").bind(jobId).run();
    const ok = await post("/api/v2/admin/sources/resume", a, payload);
    expect(ok.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT verification_state,updated_at FROM sources WHERE source_id=?")
        .bind(source.sourceId)
        .first(),
    ).toEqual({ verification_state: source.verificationState, updated_at: now });
    expect(
      await env.DB.prepare("SELECT status,payload_json,due_at,last_error FROM jobs WHERE id=?")
        .bind(jobId)
        .first(),
    ).toEqual({
      status: "pending",
      payload_json: JSON.stringify({ sourceId: source.sourceId }),
      due_at: now,
      last_error: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='source_maintenance_release' AND target_id=?",
      )
        .bind(source.sourceId)
        .first("n"),
    ).toBe(1);
    now++;
    expect((await post("/api/v2/admin/sources/resume", a, payload)).status).toBe(409);
    expect((await readObservability(env.DB, now)).alerts).toContainEqual({
      code: `source_maintenance:${source.sourceId}`,
      state: "clear",
    });
  });
  it("解除投递终态：退避行置 done、不自动开启外发并审计；重复或非清单行拒绝", async () => {
    await env.DB.exec("DELETE FROM jobs;");
    await set("mail_sending_available", false);
    await env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload_json,due_at,status,attempts,last_error,created_at,updated_at)
      VALUES ('delivery:backoff','delivery_backoff','{}',?,'failed',2,'invalid_data',?,?)`,
    )
      .bind(now, now, now - 1)
      .run();
    const a = await admin();
    const payload = {
      job: "delivery:backoff",
      expected_updated_at: now - 1,
      reason: "maintenance",
    };
    expect(
      (await post("/api/v2/admin/delivery/rearm", a, { ...payload, job: "delivery:mail:x" }))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/v2/admin/delivery/rearm", a, { ...payload, expected_updated_at: now - 2 }))
        .status,
    ).toBe(409);
    const ok = await post("/api/v2/admin/delivery/rearm", a, payload);
    expect(ok.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status,due_at FROM jobs WHERE id='delivery:backoff'").first(),
    ).toEqual({ status: "done", due_at: now });
    expect((await readControl(env.DB, "mail_sending_available")).value).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='delivery_rearm'",
      ).first("n"),
    ).toBe(1);
    now++;
    expect((await post("/api/v2/admin/delivery/rearm", a, payload)).status).toBe(409);
    expect((await readObservability(env.DB, now)).alerts).toContainEqual({
      code: "delivery_failed_jobs",
      state: "clear",
    });
  });
});
