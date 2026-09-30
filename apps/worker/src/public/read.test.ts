import { env } from "cloudflare:test";
import {
  browseWindow,
  PUBLIC_READ_LIMITS as LIMITS,
  PUBLIC_CACHE_FRESH,
  PublicEventDetailResponseSchema,
  PublicEventsResponseSchema,
  type PublicSnapshotNode,
  PublicStatusResponseSchema,
  SUPPORTED_SCOPE,
  TimeValueSchema,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeRegistrationOpen } from "../accounts/admission/registration";
import worker from "../index";
import { PUBLIC_HEAD_SQL, PUBLIC_PENDING_SQL, PUBLIC_SOURCES_SQL } from "./queries";
import { readCatalog, readEventDetail, readEvents, readPublicStatus } from "./read";
import { makeNode, migratePublicTest, NOW, resetPublicTest, seedNodes } from "./test-support";

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing test fixture");
  return value;
}
// 仅触发可用性读取；没有邮件绑定，不调用发送链。
const mailStatusEnv = {
  ...env,
  AUTH_MAIL_FROM: "auth@example.invalid",
  BIZ_MAIL_FROM: "calendar@example.invalid",
  SITE_ORIGIN: "https://example.invalid",
  CRYPTO_MASTER_SECRET: "synthetic-unused",
  CRYPTO_OTP_PEPPER: "synthetic-unused",
  CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic-unused",
};
const url = (path = "events") => new URL(`https://app.test/api/v2/${path}`);
const request = (path: string, bindings: Env = env) =>
  worker.fetch(new Request(url(path), { headers: { cookie: "ignored=synthetic" } }), bindings, {
    waitUntil() {},
  } as unknown as ExecutionContext);
async function seedApprovedEvidence() {
  const n = makeNode();
  const projection = JSON.stringify(n.projection);
  const node = { ...n, source_projection_json: projection };
  await seedNodes([node]);
  await env.DB.prepare(
    "INSERT INTO sources VALUES ('source','genshin','cn','synthetic','[]','[]','{}','{}','maintenance-required',?,?,?)",
  )
    .bind(NOW - 100, NOW - 100, NOW - 100)
    .run();
  await env.DB.prepare(
    "INSERT INTO articles VALUES ('article','source','ext','https://example.invalid/official',?,?,?,?)",
  )
    .bind(NOW, NOW, NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO article_versions VALUES ('version','article',1,'hash','[]','[]','complete',?,?,?)",
  )
    .bind(NOW - 200, NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO candidates(id,proposal_json,review_status,created_at,updated_at) VALUES ('pending','{}','pending',?,?),('approved','{}','approved',?,?)",
  )
    .bind(NOW, NOW, NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO evidence(id,candidate_id,event_id,milestone_id,article_version_id,block_ref,created_at) VALUES ('gap','pending',NULL,NULL,'version','blocks/0',?),('published','approved','event','node','version','blocks/0',?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare("INSERT INTO calendar_projections VALUES ('node','event',1,?,?)")
    .bind(projection, NOW)
    .run();
  await env.DB.prepare("UPDATE candidates SET proposal_json = ? WHERE id = 'approved'")
    .bind(
      JSON.stringify({
        events: [
          {
            title: n.projection.event.title,
            event_type: n.projection.event.event_type,
            status: n.projection.event.status,
            status_evidence: null,
            milestones: [
              { ...n.projection.milestone, time_evidence: { quote: "合成公告中的已核验片段" } },
            ],
          },
        ],
      }),
    )
    .run();
}

beforeAll(migratePublicTest);
beforeEach(resetPublicTest);
describe("A-P3-PUBLIC 真实本地 D1 公共闭环", () => {
  it("超过 2 MB 的真实尺寸整代按字节分页，既不截断也不跨 D1 单值上限", async () => {
    const nodes = Array.from({ length: LIMITS.detailNodes }, (_, i) => {
      const n = makeNode(`large-${String(i).padStart(5, "0")}`);
      n.projection.event.title = "x".repeat(2000);
      n.projection.milestone.time.raw_expression = "y".repeat(2000);
      return n;
    });
    expect(new TextEncoder().encode(JSON.stringify(nodes)).length).toBeGreaterThan(2_000_000);
    await seedNodes(nodes);
    let cursor: string | null = null;
    const seen: string[] = [];
    let pages = 0;
    do {
      const response = await readEvents(
        env.DB,
        url(`events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
        NOW,
      );
      const text = await response.text();
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LIMITS.responseBytes);
      const page = PublicEventsResponseSchema.parse(JSON.parse(text));
      seen.push(...page.nodes.map((n) => n.id));
      cursor = page.nextCursor;
      pages++;
      if (pages > nodes.length) throw new Error("游标未推进");
    } while (cursor);
    expect(seen).toEqual(nodes.map((n) => n.projection.milestone_id));
    expect(new Set(seen).size).toBe(nodes.length);
    expect(pages).toBeGreaterThan(nodes.length / LIMITS.scanPage);
    await expect(readEventDetail(env.DB, url("events/event"), "event", NOW)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
  }, 120_000);

  it("无代次不冒充成功空数据；catalog/status 仍可见，能力未知，不建立身份", async () => {
    const catalog = (await (await readCatalog(env.DB, url("catalog"), NOW)).json()) as {
      publication: unknown;
    };
    expect(catalog.publication).toBeNull();
    await expect(readEvents(env.DB, url(), NOW)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    const status = await request("status");
    expect(status.status).toBe(200);
    const data = PublicStatusResponseSchema.parse(await status.json());
    expect(data.capabilities.calendar).toBe("unknown");
    expect(must(data.sources).every((s) => s.verificationState === "unknown")).toBe(true);
    expect(data.calendarClients).toContainEqual({
      client: "apple_calendar_macos",
      support: "verified",
    });
    for (const table of ["users", "sessions", "auth_challenges"])
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
    expect(status.headers.has("set-cookie")).toBe(false);
  });
  it("日期、预计、待定原样；窗口从今日起，游戏筛选；取消与撤回不混淆", async () => {
    const nodes = [
      makeNode("date"),
      makeNode("estimate"),
      makeNode("unknown"),
      makeNode("yesterday"),
      makeNode("other"),
    ];
    must(nodes[0]).projection.milestone.time = TimeValueSchema.parse({
      precision: "date",
      date: "2026-09-30",
      source_timezone: "UTC+8",
      raw_expression: "当日",
      time_basis: "official_explicit",
    });
    must(nodes[1]).projection.milestone.time = TimeValueSchema.parse({
      ...must(nodes[1]).projection.milestone.time,
      time_basis: "official_estimate",
    });
    must(nodes[2]).projection.milestone.time = TimeValueSchema.parse({
      precision: "unknown",
      source_timezone: "UTC+8",
      raw_expression: "延期",
      time_basis: "unresolved",
    });
    must(nodes[3]).projection.milestone.time = TimeValueSchema.parse({
      precision: "date",
      date: "2026-09-29",
      source_timezone: "UTC+8",
      raw_expression: "昨日",
      time_basis: "official_explicit",
    });
    const other = { ...must(nodes[4]), game: "hsr" as const };
    nodes[4] = other;
    await seedNodes(nodes);
    const response = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url("events?range=all&games=genshin"), NOW)).json(),
    );
    expect(response.nodes.map((n) => n.id)).toEqual(["date", "estimate", "unknown"]);
    expect(response.nodes[0]?.time).not.toHaveProperty("utc_ms");
    expect(response.nodes[1]?.time.time_basis).toBe("official_estimate");
    expect(response.nextCursor).toBeNull();
  });
  it("近期更正不受未来窗口隐藏、过期消失、列表详情状态相同，HTML 只作字符串", async () => {
    const changes = ["rescheduled", "cancelled", "retracted", "postponed_unknown"] as const;
    const nodes: PublicSnapshotNode[] = changes.map((kind, i) => {
      const n = makeNode(`change-${i}`, `event-${i}`);
      const old = n.projection.milestone.time;
      n.projection.event.status =
        kind === "cancelled"
          ? "cancelled"
          : kind === "retracted"
            ? "retracted"
            : kind === "postponed_unknown"
              ? "postponed"
              : "scheduled";
      n.projection.milestone.time = TimeValueSchema.parse({
        precision: "unknown",
        raw_expression: '<img src=x onerror="alert(1)">合成公开依据',
        source_timezone: "UTC+8",
        time_basis: "unresolved",
      });
      return {
        ...n,
        patch: {
          kind,
          fact_reason: kind,
          old_time: old,
          new_time: n.projection.milestone.time,
          display_time: old,
          extends_window: true,
          retain_until: NOW + 1000,
        },
      };
    });
    const expired = {
      ...makeNode("expired"),
      tombstone: true,
      patch: { ...must(must(nodes[0]).patch), retain_until: NOW },
    };
    await seedNodes([...nodes, expired]);
    const list = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(list.recentChanges).toHaveLength(4);
    expect(list.recentChanges.map((n) => n.change?.kind)).toEqual([
      "rescheduled",
      "cancelled",
      "retracted",
      "pending",
    ]);
    const detail = PublicEventDetailResponseSchema.parse(
      await (await readEventDetail(env.DB, url("events/event-3"), "event-3", NOW)).json(),
    );
    expect(detail.event.milestones[0]).toEqual(list.nodes.find((n) => n.id === "change-3"));
    expect(detail.event.changes[0]?.change.historicalTime?.precision).toBe("datetime");
    expect(detail.event.official).toMatchObject({
      publisher: null,
      updatedAt: null,
      publishedAt: null,
    });
    expect(detail.event.official.excerpts[0]).toContain("<img");
  });
  it("分页有界、空页仍能继续；游标拒绝换代、换筛选、跨日拼接", async () => {
    await seedNodes(
      Array.from({ length: LIMITS.scanPage + 1 }, (_, i) =>
        makeNode(`page-${String(i).padStart(4, "0")}`),
      ),
    );
    const first = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url("events?games=hsr"), NOW)).json(),
    );
    expect(first.nodes).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const nextUrl = url(`events?games=hsr&cursor=${encodeURIComponent(must(first.nextCursor))}`);
    expect(
      PublicEventsResponseSchema.parse(await (await readEvents(env.DB, nextUrl, NOW)).json())
        .nextCursor,
    ).toBeNull();
    await expect(readEvents(env.DB, nextUrl, NOW + 86400000)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      readEvents(env.DB, url(`events?cursor=${encodeURIComponent(must(first.nextCursor))}`), NOW),
    ).rejects.toMatchObject({ code: "conflict" });
    await seedNodes([makeNode("replacement")], 2);
    await expect(readEvents(env.DB, nextUrl, NOW)).rejects.toMatchObject({ code: "conflict" });
  });
  it("读取中换代拒绝整响应，不能把被回收的节点当完整空列表", async () => {
    await seedNodes([makeNode()]);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const db = {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (sql.includes("milestone_id > ?"))
          return {
            bind(...args: unknown[]) {
              return {
                async all() {
                  entered();
                  await pause;
                  return statement.bind(...args).all();
                },
              };
            },
          };
        return statement;
      },
    } as D1Database;
    const inFlight = readEvents(db, url(), NOW);
    await reading;
    await seedNodes([makeNode("new-generation")], 2);
    release();
    await expect(inFlight).rejects.toMatchObject({ code: "conflict" });
  });
  it("旧代次实时响应仍有完整副本新鲜期；私人参数/任意窗口拒绝", async () => {
    await seedNodes([makeNode()]);
    const fresh = await readEvents(env.DB, url(), NOW);
    expect(fresh.headers.get("cache-control")).toContain(`max-age=${PUBLIC_CACHE_FRESH}`);
    const stale = await readEvents(env.DB, url(), NOW + PUBLIC_CACHE_FRESH * 1000);
    const body = PublicEventsResponseSchema.parse(await stale.json());
    expect(body.cache).toEqual({
      generatedAt: NOW + PUBLIC_CACHE_FRESH * 1000,
      freshUntil: NOW + PUBLIC_CACHE_FRESH * 2000,
      stale: false,
    });
    expect(body.publication.publishedAt).toBe(NOW);
    expect(stale.headers.get("cache-control")).toBe(`public, max-age=${PUBLIC_CACHE_FRESH}`);
    const nextDay = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW + 86400000)).json(),
    );
    expect(nextDay.cache.stale).toBe(false);
    expect(nextDay.cache.freshUntil - nextDay.cache.generatedAt).toBe(PUBLIC_CACHE_FRESH * 1000);
    for (const q of [
      "email=x",
      "user_id=x",
      "feed=x",
      "range=365d",
      "games=bad",
      "range=3d&range=7d",
      "cursor=bad",
      `cursor=${encodeURIComponent(btoa(encodeURIComponent(JSON.stringify({ generation: 1, start: NOW, range: "3d", games: [], after: "", user_id: "synthetic" }))))}`,
    ])
      await expect(readEvents(env.DB, url(`events?${q}`), NOW)).rejects.toMatchObject({
        code: "validation",
      });
    expect((await request("catalog?email=x")).status).toBe(400);
    expect((await request("status?email=x")).status).toBe(400);
    expect((await request("events/no-such-event")).status).toBe(404);
    expect((await request("eventsno-such-event")).status).toBe(404);
    expect((await request("catalog")).status).toBe(200);
    const detailResponse = await request("events/event");
    expect(detailResponse.status).toBe(200);
    expect(PublicEventDetailResponseSchema.parse(await detailResponse.json()).event.id).toBe(
      "event",
    );
  });
  it("响应白名单不泄漏投影内部标记；单节点超限明确失败，近期列表有上限", async () => {
    await seedNodes(
      Array.from({ length: LIMITS.recentChanges + 1 }, (_, i) => {
        const n = makeNode(`bounded-${i}`);
        return {
          ...n,
          patch: {
            kind: "rescheduled" as const,
            fact_reason: "新时间",
            extends_window: true,
            display_time: n.projection.milestone.time,
            old_time: n.projection.milestone.time,
            new_time: n.projection.milestone.time,
            retain_until: NOW + 1000,
          },
        };
      }),
    );
    const response = await readEvents(env.DB, url(), NOW);
    const text = await response.text();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LIMITS.responseBytes);
    for (const secret of [
      "human_locked",
      "source_projection_json",
      "public_ical_revision",
      "candidate_id",
      "body_blocks_json",
    ])
      expect(text).not.toContain(secret);
    const body = PublicEventsResponseSchema.parse(JSON.parse(text));
    expect(body.recentChanges).toHaveLength(LIMITS.recentChanges);
    expect(body.recentChangesTruncated).toBe(true);
    const huge = makeNode("huge");
    huge.projection.event.title = "x".repeat(LIMITS.nodeBytes);
    await seedNodes([huge], 2);
    await expect(readEvents(env.DB, url(), NOW)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
  });
  it("来源维护与待审只给聚合数；官方发布时间与核验、发布代次时间分开", async () => {
    await seedApprovedEvidence();
    const status = await readPublicStatus(env.DB, NOW);
    expect(must(status.sources)[0]).toMatchObject({
      verificationState: "unavailable",
      verifiedAt: NOW - 100,
    });
    expect(status.reviewGaps).toContainEqual({ game: "genshin", count: 1 });
    const list = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(list.nodes[0]?.noticePublishedAt).toBe(NOW - 200);
    expect(list.nodes[0]?.evidence).toBe("合成公告中的已核验片段");
    expect(list.publication.publishedAt).toBe(NOW);
    await env.DB.prepare(
      "UPDATE calendar_projections SET projection_json = '{}' WHERE milestone_id='node'",
    ).run();
    const unbound = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(unbound.nodes[0]?.noticePublishedAt).toBeNull();
  });
  it("窗口终点恰好 end 的节点必须排除", async () => {
    const end = must(browseWindow("today", NOW).end);
    const before = makeNode("before");
    const atEnd = makeNode("at-end");
    before.projection.milestone.time = TimeValueSchema.parse({
      ...before.projection.milestone.time,
      utc_ms: end - 1,
    });
    atEnd.projection.milestone.time = TimeValueSchema.parse({
      ...atEnd.projection.milestone.time,
      utc_ms: end,
    });
    await seedNodes([before, atEnd]);
    const result = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url("events?range=today"), NOW)).json(),
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["before"]);
  });
  it("近期变更恰好上限时没有截断", async () => {
    await seedNodes(
      Array.from({ length: LIMITS.recentChanges }, (_, i) => {
        const n = makeNode(`exact-${i}`);
        return {
          ...n,
          patch: {
            kind: "rescheduled" as const,
            fact_reason: "合成更正",
            extends_window: true,
            display_time: n.projection.milestone.time,
            old_time: n.projection.milestone.time,
            new_time: n.projection.milestone.time,
            retain_until: NOW + 1000,
          },
        };
      }),
    );
    const result = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(result.recentChanges).toHaveLength(LIMITS.recentChanges);
    expect(result.recentChangesTruncated).toBe(false);
  });
  it("详情排除仍在保留期的墓碑节点", async () => {
    const live = makeNode("live"),
      deleted = makeNode("deleted");
    deleted.tombstone = true;
    deleted.patch = {
      kind: "deleted",
      fact_reason: "系统删除",
      extends_window: true,
      display_time: deleted.projection.milestone.time,
      old_time: deleted.projection.milestone.time,
      new_time: null,
      retain_until: NOW + 1000,
    };
    await seedNodes([live, deleted]);
    const result = PublicEventDetailResponseSchema.parse(
      await (await readEventDetail(env.DB, url("events/event"), "event", NOW)).json(),
    );
    expect(result.event.milestones.map((n) => n.id)).toEqual(["live"]);
    expect(result.event.changes).toEqual([]);
    const list = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(list.recentChanges.map((n) => n.id)).toEqual(["deleted"]);
  });
  it("投影绑定成立但候选字段不匹配时公告发布时间未知", async () => {
    await seedApprovedEvidence();
    const before = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(before.nodes[0]?.noticePublishedAt).toBe(NOW - 200);
    await env.DB.prepare(
      "UPDATE candidates SET proposal_json = json_set(proposal_json, '$.events[0].title', '不同标题') WHERE id = 'approved'",
    ).run();
    const result = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(result.nodes[0]?.noticePublishedAt).toBeNull();
    expect(result.nodes[0]?.evidence).toBe(makeNode().projection.milestone.time.raw_expression);
  });
  it("同游戏官方与米游社逐来源显示，待审独立统计", async () => {
    await seedApprovedEvidence();
    await env.DB.prepare("UPDATE sources SET verification_state = 'verified-working'").run();
    await env.DB.prepare(
      "INSERT INTO sources SELECT 'miyoushe',game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,'maintenance-required-list-only',last_success_at,created_at,updated_at FROM sources WHERE source_id='source'",
    ).run();
    const result = await readPublicStatus(env.DB, NOW);
    expect(result.sources).toEqual([
      {
        sourceId: "miyoushe",
        game: "genshin",
        verifiedAt: NOW - 100,
        verificationState: "verified",
        degradationReasons: ["content_unavailable"],
      },
      {
        sourceId: "source",
        game: "genshin",
        verifiedAt: NOW - 100,
        verificationState: "verified",
        degradationReasons: [],
      },
    ]);
    expect(result.reviewGaps).toContainEqual({ game: "genshin", count: 1 });
  });
  it("无法归属及超过上限的待审计数为未知，status 仍返回原有开关", async () => {
    await seedApprovedEvidence();
    await writeRegistrationOpen(env.DB, true, NOW);
    await env.DB.prepare(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?) ON CONFLICT(key) DO UPDATE SET value_json='true'",
    )
      .bind(NOW)
      .run();
    try {
      await env.DB.prepare(
        "INSERT INTO candidates(id,proposal_json,review_status,created_at,updated_at) VALUES ('orphan','{}','pending',?,?)",
      )
        .bind(NOW, NOW)
        .run();
      for (const overflow of [false, true]) {
        if (overflow) {
          await env.DB.prepare("DELETE FROM candidates WHERE id='orphan'").run();
          await env.DB.prepare(
            "INSERT INTO candidates(id,proposal_json,review_status,created_at,updated_at) SELECT 'overflow-' || value,'{}','pending',?,? FROM json_each(?)",
          )
            .bind(
              NOW,
              NOW,
              JSON.stringify(Array.from({ length: LIMITS.pendingCandidates }, (_, i) => i)),
            )
            .run();
          await env.DB.prepare(
            "INSERT INTO evidence(id,candidate_id,article_version_id,block_ref,created_at) SELECT id,id,'version','blocks/0',? FROM candidates WHERE id LIKE 'overflow-%'",
          )
            .bind(NOW)
            .run();
        }
        const response = await request("status", mailStatusEnv);
        expect(response.status).toBe(200);
        const result = PublicStatusResponseSchema.parse(await response.json());
        expect(result.registration_open).toBe(true);
        expect(result.mail_sending_available).toBe(true);
        expect(result.reviewGaps).toEqual(
          SUPPORTED_SCOPE.games.map((game) => ({ game, count: null })),
        );
        expect(result.sources).not.toBeNull();
        expect(result.publication).not.toBeNull();
      }
    } finally {
      await writeRegistrationOpen(env.DB, false, NOW);
      await env.DB.prepare("DELETE FROM system_state WHERE key='mail_sending_available'").run();
    }
  });
  it("每个公开聚合查询故障只降级该项，注册与邮件独立返回", async () => {
    await seedApprovedEvidence();
    await writeRegistrationOpen(env.DB, true, NOW);
    await env.DB.prepare(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?) ON CONFLICT(key) DO UPDATE SET value_json='true'",
    )
      .bind(NOW)
      .run();
    try {
      for (const failSql of [PUBLIC_HEAD_SQL, PUBLIC_PENDING_SQL, PUBLIC_SOURCES_SQL]) {
        const db = {
          prepare(sql: string) {
            if (sql === failSql) throw new Error("synthetic read failure");
            return env.DB.prepare(sql);
          },
        } as D1Database;
        const response = await request("status", { ...mailStatusEnv, DB: db });
        expect(response.status).toBe(200);
        const result = PublicStatusResponseSchema.parse(await response.json());
        expect(result.registration_open).toBe(true);
        expect(result.mail_sending_available).toBe(true);
        expect(result.publication === null).toBe(failSql === PUBLIC_HEAD_SQL);
        expect(result.sources === null).toBe(failSql === PUBLIC_SOURCES_SQL);
        expect(result.reviewGaps.find((r) => r.game === "genshin")?.count).toBe(
          failSql === PUBLIC_PENDING_SQL ? null : 1,
        );
      }
      await env.DB.prepare(
        "INSERT INTO sources SELECT 'extra-' || value, 'genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,? FROM json_each(?)",
      )
        .bind(
          NOW,
          NOW,
          NOW,
          JSON.stringify(Array.from({ length: LIMITS.sourcesPerGame }, (_, i) => i)),
        )
        .run();
      const response = await request("status", mailStatusEnv);
      expect(response.status).toBe(200);
      const result = PublicStatusResponseSchema.parse(await response.json());
      expect(result.sources).toBeNull();
      expect(result.reviewGaps.find((r) => r.game === "genshin")?.count).toBe(1);
      expect(result.registration_open).toBe(true);
    } finally {
      await writeRegistrationOpen(env.DB, false, NOW);
      await env.DB.prepare("DELETE FROM system_state WHERE key='mail_sending_available'").run();
    }
  });
});
