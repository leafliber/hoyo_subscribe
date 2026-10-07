// ADR-0030 · 管理员登记直播活动（米游社首页没出现直播入口时的兜底）。合成管理员会话，不访问官方。
import "../../admin/test-support";
import { env } from "cloudflare:test";
import { REDEEM_LIVE_TRACK_DAYS, REDEEM_LIVE_TRACK_MAX } from "@hoyo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { combinedAuthenticator, issueAdminSession } from "../../admin/session";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { readRedeemHints, redeemHintKey } from "../../sources/redeem-store";
import { generateSecretToken } from "../../storage/crypto/random";
import { ADMIN_SESSION_COOKIE_NAME } from "../domains";
import { fakeExecutionContext, testKeyring } from "../test-support";
import { makeObservabilityRoutes } from "./routes";

let now = 1_900_000_000_000;
const origin = "https://synthetic.example";
const ACT = "ea202610091930001";
const LIVE_URL = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${ACT}&mhy_presentation_style=fullscreen`;
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
const register = (
  headers: Record<string, string>,
  body: unknown,
  path = "/api/v2/admin/redeem-lives",
) =>
  shell.fetch(
    new Request(origin + path, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    fakeExecutionContext,
  );

beforeEach(async () => {
  now += 1000;
  await env.DB.exec(
    "DELETE FROM system_state; DELETE FROM audit_log; DELETE FROM admin_sessions; DELETE FROM jobs;",
  );
});

describe("ADR-0030 管理员登记直播活动", () => {
  it("官方直播页链接（含米游社应用内链接）或活动 ID 都认；写入登记、审计，并让该来源尽快采集一次", async () => {
    const headers = await admin();
    await env.DB.prepare(
      "INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('pipeline:source:zzz-live','pipeline_source','{\"sourceId\":\"zzz-live\"}',?,'pending',?,?)",
    )
      .bind(now + 1_800_000, now, now)
      .run();
    const response = await register(headers, {
      source: "zzz-live",
      live: `mihoyobbs://webview?link=${encodeURIComponent(LIVE_URL)}`,
      reason: "maintenance",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      registered: true,
      source: "zzz-live",
      act_id: ACT,
      tracked: 1,
    });
    expect(await readRedeemHints(env.DB, "zzz-live", now)).toEqual([
      { act_id: ACT, added_at: now },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT action, target_type, target_id, reason FROM audit_log WHERE action = 'redeem_live_register'",
      ).all(),
    ).toMatchObject({
      results: [
        {
          action: "redeem_live_register",
          target_type: "source",
          target_id: "zzz-live",
          reason: "maintenance",
        },
      ],
    });
    expect(
      await env.DB.prepare("SELECT due_at FROM jobs WHERE id = 'pipeline:source:zzz-live'").first(
        "due_at",
      ),
    ).toBe(now);

    // 再登记同一活动：只保留最新一次；新登记在前；数量与跟踪期都有上界。
    now += 1000;
    const again = await register(headers, { source: "zzz-live", live: ACT, reason: "maintenance" });
    expect(again.status).toBe(200);
    expect(await readRedeemHints(env.DB, "zzz-live", now)).toEqual([
      { act_id: ACT, added_at: now },
    ]);
    for (let i = 0; i < REDEEM_LIVE_TRACK_MAX + 2; i++) {
      now += 1000;
      expect(
        (
          await register(headers, {
            source: "zzz-live",
            live: `ea2026100${i}`,
            reason: "maintenance",
          })
        ).status,
      ).toBe(200);
    }
    const hints = await readRedeemHints(env.DB, "zzz-live", now);
    expect(hints).toHaveLength(REDEEM_LIVE_TRACK_MAX);
    expect(hints[0]?.act_id).toBe(`ea2026100${REDEEM_LIVE_TRACK_MAX + 1}`);
    expect(
      await readRedeemHints(env.DB, "zzz-live", now + REDEEM_LIVE_TRACK_DAYS * 86_400_000 + 1),
    ).toEqual([]);
  });

  it("只接受直播兑换码来源与官方直播页：公告源、其他页面、未知来源、带查询参数、自由文本理由都拒绝", async () => {
    const headers = await admin();
    for (const body of [
      { source: "zzz-ann", live: ACT, reason: "maintenance" },
      {
        source: "zzz-live",
        live: "https://webstatic.mihoyo.com/bbs/event/signin/index.html?act_id=e1",
        reason: "maintenance",
      },
      {
        source: "zzz-live",
        live: "https://example.invalid/bbs/event/live/index.html?act_id=x",
        reason: "maintenance",
      },
      { source: "not-a-source", live: ACT, reason: "maintenance" },
      { source: "zzz-live", live: ACT, reason: "随便写的理由" },
      { source: "zzz-live", live: ACT, reason: "maintenance", extra: 1 },
    ])
      expect((await register(headers, body)).status).toBe(400);
    expect(
      (
        await register(
          headers,
          { source: "zzz-live", live: ACT, reason: "maintenance" },
          "/api/v2/admin/redeem-lives?x=1",
        )
      ).status,
    ).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM system_state").first("n")).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'redeem_live_register'",
      ).first("n"),
    ).toBe(0);
  });

  it("没有管理员会话拒绝；并发登记后到的一次返回冲突，不丢前一次", async () => {
    expect(
      (
        await register(
          { origin, "content-type": "application/json" },
          { source: "zzz-live", live: ACT, reason: "maintenance" },
        )
      ).status,
    ).toBe(401);
    const headers = await admin();
    const results = await Promise.all([
      register(headers, { source: "zzz-live", live: ACT, reason: "maintenance" }),
      register(headers, { source: "zzz-live", live: "ea2026101000002", reason: "maintenance" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await readRedeemHints(env.DB, "zzz-live", now)).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'redeem_live_register'",
      ).first("n"),
    ).toBe(1);
  });

  it("运行开关页能看到直播来源的登记与正在跟踪的活动", async () => {
    const headers = await admin();
    await register(headers, { source: "hsr-live", live: ACT, reason: "maintenance" });
    await env.DB.prepare(
      `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json, verified_publishers_json,
         cursor_json, poll_policy_json, verification_state, created_at, updated_at)
       VALUES ('hsr-live', 'hsr', 'cn', 'miyolive-redeem-codes', '[]', '[]', ?, '{}', 'verified-working', ?, ?)`,
    )
      .bind(
        JSON.stringify({
          watermark: null,
          lastPollCompletedAtMs: null,
          lastRecheckCompletedAtMs: null,
          lives: [{ actId: ACT, firstSeenAtMs: now, closedAtMs: null }],
        }),
        now,
        now,
      )
      .run();
    const response = await shell.fetch(
      new Request(`${origin}/api/v2/admin/controls`, { headers }),
      env,
      fakeExecutionContext,
    );
    const body = (await response.json()) as {
      controls: { source?: string; info?: Record<string, unknown> }[];
    };
    const live = body.controls.find((row) => row.source === "hsr-live");
    expect(live?.info).toMatchObject({
      adapter: "miyolive",
      lives: {
        hints: [{ act_id: ACT, added_at: now }],
        tracked: [{ act_id: ACT, first_seen_at: now, closed_at: null }],
      },
    });
    expect(body.controls.find((row) => row.source === "hsr-ann")?.info).not.toHaveProperty("lives");
    // 键名固定，便于审计核对。
    expect(redeemHintKey("hsr-live")).toBe("redeem_live_hints:hsr-live");
  });
});
