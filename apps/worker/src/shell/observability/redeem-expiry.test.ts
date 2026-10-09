// ADR-0034 · 管理员照官方说明登记兑换码截止时间。合成管理员会话与合成数据，不访问官方。
import "../../admin/test-support";
import { env } from "cloudflare:test";
import { REDEEM_LIVE_TRACK_DAYS, redeemStatusCheckAfter } from "@hoyo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { combinedAuthenticator, issueAdminSession } from "../../admin/session";
import type { SourcePollState } from "../../executors/pipeline/source-poll";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { readVisibleRedeemCodes } from "../../sources/redeem-store";
import { generateSecretToken } from "../../storage/crypto/random";
import { ADMIN_SESSION_COOKIE_NAME } from "../domains";
import { fakeExecutionContext, testKeyring } from "../test-support";
import { makeObservabilityRoutes } from "./routes";

const beijing = (text: string) => Date.parse(`${text}+08:00`);
const START = beijing("2026-10-09T20:50:00");
let tick = 0;
let now = START;
const origin = "https://synthetic.example";
const ACT = "ea202609241643161324";
const REVEALED = beijing("2026-10-09T19:43:30");
const CHECKED = beijing("2026-10-09T20:40:00");
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
const save = (
  headers: Record<string, string>,
  body: Record<string, unknown>,
  path = "/api/v2/admin/redeem-expiry",
) =>
  shell.fetch(
    new Request(origin + path, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    fakeExecutionContext,
  );
const body = (overrides: Record<string, unknown> = {}) => ({
  source: "zzz-live",
  act_id: ACT,
  expires_at: "2026-10-11T23:59:59",
  reason: "evidence_reviewed",
  expected_updated_at: 0,
  ...overrides,
});
type Tracked = {
  act_id: string;
  title: string | null;
  phase: string;
  next_check_at: number | null;
  codes: { code: string; revealed_at: number; gone_at: number | null }[];
  official_expiry: { expires_at: number; text: string } | null;
  manual_expiry: { expires_at: number; text: string; updated_at: number } | null;
};
async function tracked(headers: Record<string, string>): Promise<Tracked[]> {
  const response = await shell.fetch(
    new Request(`${origin}/api/v2/admin/controls`, { headers }),
    env,
    fakeExecutionContext,
  );
  const reply = (await response.json()) as {
    controls: { source?: string; info?: { lives?: { tracked: Tracked[] } } }[];
  };
  return reply.controls.find((row) => row.source === "zzz-live")?.info?.lives?.tracked ?? [];
}
const count = async (sql: string) => await env.DB.prepare(sql).first<number>("n");

beforeEach(async () => {
  tick += 1;
  now = START + tick * 1000;
  await env.DB.exec(
    "DELETE FROM redeem_live_expiry; DELETE FROM redeem_codes; DELETE FROM sources; DELETE FROM system_state; DELETE FROM audit_log; DELETE FROM admin_sessions; DELETE FROM jobs;",
  );
  // 一场已经收尾、官方没写有效期的直播（绝区零 3.3 前瞻的形状）。
  const cursor: SourcePollState = {
    watermark: null,
    lastPollCompletedAtMs: CHECKED,
    lastRecheckCompletedAtMs: CHECKED,
    lives: [
      {
        actId: ACT,
        firstSeenAtMs: beijing("2026-10-09T19:40:00"),
        closedAtMs: null,
        checkedAtMs: CHECKED,
        record: {
          title: "《绝区零》3.3版本前瞻特别节目",
          tip: null,
          endAtMs: beijing("2026-10-09T20:30:00"),
          ended: true,
          codes: [{ code: "PHOENIX1021", reward: "菲林*300", revealAtMs: REVEALED }],
          pendingRevealAtMs: [],
          officialExpiry: null,
        },
      },
    ],
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sources (source_id, game, region, adapter, approved_hosts_json, verified_publishers_json,
         cursor_json, poll_policy_json, verification_state, created_at, updated_at)
       VALUES ('zzz-live', 'zzz', 'cn', 'miyolive-redeem-codes', '[]', '[]', ?, '{}', 'verified-working', ?, ?)`,
    ).bind(JSON.stringify(cursor), now, now),
    env.DB.prepare(
      `INSERT INTO redeem_codes (source_id, act_id, code, game, live_title, reward, revealed_at,
         expires_at, expiry_text, live_closed_at, first_seen_at, updated_at)
       VALUES ('zzz-live', ?, 'PHOENIX1021', 'zzz', '《绝区零》3.3版本前瞻特别节目', '菲林*300', ?, NULL, NULL, NULL, ?, ?)`,
    ).bind(ACT, REVEALED, REVEALED, REVEALED),
    env.DB.prepare(
      "INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('pipeline:source:zzz-live','pipeline_source','{\"sourceId\":\"zzz-live\"}',?,'pending',?,?)",
    ).bind(redeemStatusCheckAfter(CHECKED), now, now),
  ]);
});

describe("ADR-0034 管理员登记兑换码截止时间", () => {
  it("运行开关页列出这场直播的兑换码、截止时间与采集阶段：没有截止时间时按整点核对", async () => {
    const headers = await admin();
    expect(await tracked(headers)).toEqual([
      {
        act_id: ACT,
        first_seen_at: beijing("2026-10-09T19:40:00"),
        closed_at: null,
        title: "《绝区零》3.3版本前瞻特别节目",
        checked_at: CHECKED,
        phase: "checking",
        next_check_at: beijing("2026-10-09T21:00:00"),
        codes: [{ code: "PHOENIX1021", revealed_at: REVEALED, gone_at: null }],
        official_expiry: null,
        manual_expiry: null,
      },
    ]);
  });

  it("登记：写入、审计、提前采集；首页条立即按它显示；改动要带上次的版本，旧版本返回冲突", async () => {
    const headers = await admin();
    const response = await save(headers, body());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      saved: true,
      source: "zzz-live",
      act_id: ACT,
      expires_at: beijing("2026-10-11T23:59:59"),
      text: "2026/10/11 23:59:59",
      updated_at: now,
    });
    expect(
      await env.DB.prepare(
        "SELECT action, target_type, target_id, reason FROM audit_log WHERE action = 'redeem_expiry_set'",
      ).all(),
    ).toMatchObject({
      results: [
        {
          action: "redeem_expiry_set",
          target_type: "redeem_live",
          target_id: `zzz-live:${ACT}`,
          reason: "evidence_reviewed",
        },
      ],
    });
    expect(
      await env.DB.prepare("SELECT due_at FROM jobs WHERE id = 'pipeline:source:zzz-live'").first(
        "due_at",
      ),
    ).toBe(now);
    expect(
      (await readVisibleRedeemCodes(env.DB, now)).map((code) => [code.expiresAt, code.expiryText]),
    ).toEqual([[beijing("2026-10-11T23:59:59"), "2026/10/11 23:59:59"]]);
    const [live] = await tracked(headers);
    expect(live).toMatchObject({
      phase: "deadline",
      next_check_at: null,
      manual_expiry: {
        expires_at: beijing("2026-10-11T23:59:59"),
        text: "2026/10/11 23:59:59",
        updated_at: now,
      },
    });

    // 改动：带上次看到的版本；没输入秒就不写秒。
    const version = live?.manual_expiry?.updated_at ?? 0;
    now += 1000;
    const changed = await save(
      headers,
      body({ expires_at: "2026-10-12T12:00", expected_updated_at: version }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ text: "2026/10/12 12:00", updated_at: now });
    // 拿旧版本（或当作还没登记）再写：冲突，不覆盖。
    for (const expected of [version, 0])
      expect((await save(headers, body({ expected_updated_at: expected }))).status).toBe(409);
    expect(
      await env.DB.prepare("SELECT expression FROM redeem_live_expiry").first("expression"),
    ).toBe("2026/10/12 12:00");
    expect(
      await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'redeem_expiry_set'"),
    ).toBe(2);
  });

  it("拒绝：没在跟踪的直播、公告源、不早于第一个兑换码发放、认不出的时间、自由文本理由、额外字段、查询参数、未来版本号", async () => {
    const headers = await admin();
    for (const overrides of [
      { act_id: "ea2026100000000" },
      { source: "zzz-ann" },
      { source: "not-a-source" },
      { expires_at: "2026-10-09T19:43:30" },
      { expires_at: "2026-10-09T19:00" },
      { expires_at: "2026-02-30T12:00" },
      { expires_at: "10月11日 23:59" },
      { reason: "官方帖子写的" },
      { extra: 1 },
      { expected_updated_at: now + 60_000 },
      { expected_updated_at: -1 },
    ])
      expect((await save(headers, body(overrides))).status).toBe(400);
    expect((await save(headers, body(), "/api/v2/admin/redeem-expiry?x=1")).status).toBe(400);
    // 跟踪期过了的直播也不能登记。
    now += REDEEM_LIVE_TRACK_DAYS * 86_400_000;
    expect((await save(await admin(), body())).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM redeem_live_expiry")).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'redeem_expiry_set'"),
    ).toBe(0);
  });

  it("没有管理员会话拒绝；并发登记后到的一次返回冲突，不丢前一次", async () => {
    expect((await save({ origin, "content-type": "application/json" }, body())).status).toBe(401);
    const headers = await admin();
    const results = await Promise.all([
      save(headers, body()),
      save(headers, body({ expires_at: "2026-10-12T12:00" })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM redeem_live_expiry")).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'redeem_expiry_set'"),
    ).toBe(1);
  });
});
