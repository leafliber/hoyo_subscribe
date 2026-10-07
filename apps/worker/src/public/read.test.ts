import { env } from "cloudflare:test";
import {
  BROWSE_RANGES,
  browseWindow,
  PUBLIC_READ_LIMITS as LIMITS,
  type PatchDecision,
  PUBLIC_CACHE_FRESH,
  PublicEventArticlesResponseSchema,
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
import { seedOperationalControls } from "../shell/observability/test-support";
import {
  PUBLIC_CHANGES_SQL,
  PUBLIC_HEAD_SQL,
  PUBLIC_PENDING_SQL,
  PUBLIC_SOURCES_SQL,
} from "./queries";
import {
  readCatalog,
  readEventArticles,
  readEventDetail,
  readEvents,
  readPublicStatus,
} from "./read";
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
beforeEach(async () => {
  await resetPublicTest();
  await seedOperationalControls(env.DB);
});
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
  it("日期、预计、待定原样；窗口附带昨天，游戏筛选；取消与撤回不混淆", async () => {
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
    expect(response.nodes.map((n) => n.id)).toEqual(["date", "estimate", "unknown", "yesterday"]);
    expect(response.nodes[0]?.time).not.toHaveProperty("utc_ms");
    expect(response.nodes[1]?.time.time_basis).toBe("official_estimate");
    expect(response.nextCursor).toBeNull();
  });
  it.each(BROWSE_RANGES)("P3-16 $id 只补昨天的节点并返回昨天边界", async ({ id }) => {
    const today = makeNode("today");
    const yesterday = makeNode("yesterday");
    const beforeYesterday = makeNode("before-yesterday");
    yesterday.projection.milestone.time = TimeValueSchema.parse({
      ...yesterday.projection.milestone.time,
      utc_ms: Date.parse("2026-09-29T00:00:00+08:00"),
    });
    beforeYesterday.projection.milestone.time = TimeValueSchema.parse({
      ...beforeYesterday.projection.milestone.time,
      utc_ms: Date.parse("2026-09-28T23:59:59.999+08:00"),
    });
    await seedNodes([today, yesterday, beforeYesterday]);
    const response = await readEvents(env.DB, url(`events?range=${id}`), NOW);
    const result = PublicEventsResponseSchema.parse(await response.json());
    expect(result.nodes.map((n) => n.id)).toEqual(["today", "yesterday"]);
    expect(result.window).toEqual(browseWindow(id, NOW));
    expect(result.window.yesterday).toBe(Date.parse("2026-09-29T00:00:00+08:00"));
    expect(result.recentChanges).toEqual([]);
    expect(result.recentChangesTruncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
  it("P3-16 昨天与今天共用身份分页流，跨页不遗漏也不重复", async () => {
    const nodes = Array.from({ length: LIMITS.scanPage + 2 }, (_, i) => {
      const n = makeNode(`band-${String(i).padStart(4, "0")}`);
      if (i % 2 === 0) {
        n.projection.milestone.time = TimeValueSchema.parse({
          ...n.projection.milestone.time,
          utc_ms: Date.parse("2026-09-29T23:59:59.999+08:00"),
        });
      }
      return n;
    });
    await seedNodes(nodes);
    let cursor: string | null = null;
    const seen: string[] = [];
    let pages = 0;
    do {
      const query = new URLSearchParams({ range: "today" });
      if (cursor !== null) query.set("cursor", cursor);
      const result = PublicEventsResponseSchema.parse(
        await (await readEvents(env.DB, url(`events?${query}`), NOW)).json(),
      );
      expect(result.window).toEqual(browseWindow("today", NOW));
      expect(result.publication.generation).toBe(1);
      seen.push(...result.nodes.map((n) => n.id));
      cursor = result.nextCursor;
      pages++;
      if (pages > nodes.length) throw new Error("游标未推进");
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(nodes.map((n) => n.projection.milestone_id));
    expect(new Set(seen).size).toBe(nodes.length);
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
  it("近期变化只在首页读取并返回，续页不再重复查询与取证", async () => {
    const changed = makeNode("page-0000-change");
    await seedNodes([
      {
        ...changed,
        patch: {
          kind: "rescheduled",
          fact_reason: "rescheduled",
          old_time: changed.projection.milestone.time,
          new_time: changed.projection.milestone.time,
          display_time: changed.projection.milestone.time,
          extends_window: true,
          retain_until: NOW + 1000,
        },
      },
      ...Array.from({ length: LIMITS.scanPage }, (_, i) =>
        makeNode(`page-${String(i + 1).padStart(4, "0")}`),
      ),
    ]);
    let changeQueries = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql === PUBLIC_CHANGES_SQL) changeQueries++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = PublicEventsResponseSchema.parse(await (await readEvents(db, url(), NOW)).json());
    expect(changeQueries).toBe(SUPPORTED_SCOPE.games.length);
    expect(first.recentChanges.map((n) => n.id)).toEqual(["page-0000-change"]);
    expect(first.nextCursor).not.toBeNull();
    changeQueries = 0;
    const next = PublicEventsResponseSchema.parse(
      await (
        await readEvents(
          db,
          url(`events?cursor=${encodeURIComponent(must(first.nextCursor))}`),
          NOW,
        )
      ).json(),
    );
    expect(changeQueries).toBe(0);
    expect(next.recentChanges).toEqual([]);
    expect(next.recentChangesTruncated).toBe(false);
    expect(next.nodes.length).toBeGreaterThan(0);
    expect(first.nodes.length + next.nodes.length).toBe(LIMITS.scanPage + 1);
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
    expect(fresh.headers.get("cache-control")).toBe("no-cache");
    const stale = await readEvents(env.DB, url(), NOW + PUBLIC_CACHE_FRESH * 1000);
    const body = PublicEventsResponseSchema.parse(await stale.json());
    expect(body.cache).toEqual({
      generatedAt: NOW + PUBLIC_CACHE_FRESH * 1000,
      freshUntil: NOW + PUBLIC_CACHE_FRESH * 2000,
      stale: false,
    });
    expect(body.publication.publishedAt).toBe(NOW);
    expect(stale.headers.get("cache-control")).toBe("no-cache");
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
  it("ADR-0028 待定第一次得到时间不进近期变更，也不占条数上限；列表与详情都不标改期", async () => {
    const patch = (
      n: PublicSnapshotNode,
      oldTime: PatchDecision["old_time"],
      retainUntil: number,
    ) => ({
      ...n,
      patch: {
        kind: "rescheduled" as const,
        fact_reason: "已公布新时间",
        extends_window: true,
        display_time: n.projection.milestone.time,
        old_time: oldTime,
        new_time: n.projection.milestone.time,
        retain_until: retainUntil,
      },
    });
    // 没有旧时间的改期保留期更晚，按排序本会排在前面占满上限。
    const firstTimes = Array.from({ length: 3 }, (_, i) =>
      patch(makeNode(`first-${i}`, "first-event"), null, NOW + 5000),
    );
    const real = Array.from({ length: LIMITS.recentChanges }, (_, i) => {
      const n = makeNode(`moved-${i}`);
      return patch(n, n.projection.milestone.time, NOW + 1000);
    });
    await seedNodes([...firstTimes, ...real]);
    const list = PublicEventsResponseSchema.parse(
      await (await readEvents(env.DB, url(), NOW)).json(),
    );
    expect(list.recentChanges.map((n) => n.id).sort()).toEqual(
      real.map((n) => n.projection.milestone_id).sort(),
    );
    expect(list.recentChangesTruncated).toBe(false);
    for (const n of firstTimes)
      expect(list.nodes.find((x) => x.id === n.projection.milestone_id)?.change).toBeNull();
    const detail = PublicEventDetailResponseSchema.parse(
      await (await readEventDetail(env.DB, url("events/first-event"), "first-event", NOW)).json(),
    );
    expect(detail.event.milestones).toHaveLength(3);
    expect(detail.event.changes).toEqual([]);
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
  it("同游戏多个来源逐来源显示；已下线来源（ADR-0016）的历史行不出现；待审独立统计", async () => {
    await seedApprovedEvidence();
    await env.DB.prepare("UPDATE sources SET verification_state = 'verified-working'").run();
    for (const sourceId of ["list-only", "miyoushe-news"])
      await env.DB.prepare(
        "INSERT INTO sources SELECT ?,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,'maintenance-required-list-only',last_success_at,created_at,updated_at FROM sources WHERE source_id='source'",
      )
        .bind(sourceId)
        .run();
    const result = await readPublicStatus(env.DB, NOW);
    expect(result.sources).toEqual([
      {
        sourceId: "list-only",
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

// P3-22（ADR-0014）：活动依据的官方公告原文。绑定条件与公告发布时间相同，正文块原样返回。
const ARTICLE_URL = "https://example.invalid/official";
const ARTICLE_BLOCKS = [
  { kind: "title", text: "合成公告：城市探索挑战" },
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap;">活动时间：<span>&lt;t class="t_gl"&gt;2026/10/01 10:00&lt;/t&gt;</span> 起</p>',
  },
  { kind: "text", text: "顶层残片" },
];
async function seedArticleSource() {
  await env.DB.prepare(
    "INSERT INTO sources VALUES ('source','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?)",
  )
    .bind(NOW, NOW, NOW)
    .run();
  await env.DB.prepare("INSERT INTO articles VALUES ('article','source','ext',?,?,?,?,?)")
    .bind(ARTICLE_URL, NOW, NOW, NOW, NOW)
    .run();
}
async function seedVersion(
  id: string,
  versionNo: number,
  fetchedAt: number,
  blocks: unknown[] = ARTICLE_BLOCKS,
) {
  await env.DB.prepare(
    "INSERT INTO article_versions VALUES (?,'article',?,?,?,'[]','complete',NULL,?,?)",
  )
    .bind(id, versionNo, `hash-${id}`, JSON.stringify(blocks), fetchedAt, fetchedAt)
    .run();
}
/** 本代发布的节点，日历投影与快照一致（绑定的前提）。 */
async function seedPublishedNodes(ids: string[]) {
  const nodes = ids.map((id) => {
    const n = makeNode(id);
    return { ...n, source_projection_json: JSON.stringify(n.projection) };
  });
  await seedNodes(nodes);
  for (const n of nodes)
    await env.DB.prepare("INSERT INTO calendar_projections VALUES (?,?,1,?,?)")
      .bind(n.projection.milestone_id, n.projection.event_id, n.source_projection_json, NOW)
      .run();
  return nodes;
}
/** 一个已批准候选覆盖给定节点，证据指向 version；createdAt 晚于代次发布即"尚未发布"。 */
async function seedApproval(
  candidate: string,
  nodes: readonly PublicSnapshotNode[],
  version: string,
  createdAt = NOW,
) {
  const event = must(nodes[0]).projection.event;
  await env.DB.prepare(
    "INSERT INTO candidates(id,proposal_json,review_status,created_at,updated_at) VALUES (?,?,'approved',?,?)",
  )
    .bind(
      candidate,
      JSON.stringify({
        events: [
          {
            title: event.title,
            event_type: event.event_type,
            status: event.status,
            status_evidence: null,
            milestones: nodes.map((n) => ({
              ...n.projection.milestone,
              time_evidence: { quote: `${n.projection.milestone_id} 的证据片段` },
            })),
          },
        ],
      }),
      createdAt,
      createdAt,
    )
    .run();
  for (const n of nodes)
    await env.DB.prepare(
      "INSERT INTO evidence(id,candidate_id,event_id,milestone_id,article_version_id,block_ref,created_at) VALUES (?,?,?,?,?,'blocks/1',?)",
    )
      .bind(
        `${candidate}-${n.projection.milestone_id}`,
        candidate,
        n.projection.event_id,
        n.projection.milestone_id,
        version,
        createdAt,
      )
      .run();
}
const readArticles = async (id = "event") =>
  PublicEventArticlesResponseSchema.parse(
    await (await readEventArticles(env.DB, url(`events/${id}/articles`), id, NOW)).json(),
  );

describe("A-P3-ARTICLE-VIEW 公开原文只读本代已发布事实绑定的文章版本", () => {
  it("正文块原样返回，带抓取时间与官方数据源；不泄漏版本 ID、候选与证据内部字段", async () => {
    await seedArticleSource();
    await seedVersion("version-internal-id", 3, NOW - 500);
    await seedApproval(
      "candidate-internal-id",
      await seedPublishedNodes(["node"]),
      "version-internal-id",
    );
    const response = await readEventArticles(env.DB, url("events/event/articles"), "event", NOW);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const text = await response.text();
    for (const secret of [
      "version-internal-id",
      "candidate-internal-id",
      "proposal",
      "article_version_id",
      "body_blocks_json",
      "human_locked",
    ])
      expect(text).not.toContain(secret);
    const body = PublicEventArticlesResponseSchema.parse(JSON.parse(text));
    expect(body.eventId).toBe("event");
    expect(body.publication).toEqual({ generation: 1, publishedAt: NOW });
    expect(body.articles).toEqual([
      {
        officialUrl: ARTICLE_URL,
        versionNo: 3,
        fetchedAt: NOW - 500,
        publishedAt: null,
        completeness: "complete",
        blocks: ARTICLE_BLOCKS,
      },
    ]);
  });

  it("证据晚于本代发布、候选字段不匹配、投影不一致或候选未批准时不给原文（空数组）", async () => {
    await seedArticleSource();
    await seedVersion("v1", 1, NOW - 500);
    const nodes = await seedPublishedNodes(["node"]);
    const title = must(nodes[0]).projection.event.title;
    await seedApproval("approved", nodes, "v1", NOW + 1);
    expect((await readArticles()).articles).toEqual([]);
    await env.DB.prepare("DELETE FROM evidence").run();
    await env.DB.prepare("DELETE FROM candidates").run();
    await seedApproval("approved", nodes, "v1");
    expect((await readArticles()).articles).toHaveLength(1);
    await env.DB.prepare(
      "UPDATE candidates SET proposal_json = json_set(proposal_json, '$.events[0].title', '不同标题')",
    ).run();
    expect((await readArticles()).articles).toEqual([]);
    await env.DB.prepare(
      "UPDATE candidates SET proposal_json = json_set(proposal_json, '$.events[0].title', ?)",
    )
      .bind(title)
      .run();
    await env.DB.prepare("UPDATE calendar_projections SET projection_json = '{}'").run();
    expect((await readArticles()).articles).toEqual([]);
    await env.DB.prepare("UPDATE calendar_projections SET projection_json = ?")
      .bind(must(nodes[0]).source_projection_json)
      .run();
    expect((await readArticles()).articles).toHaveLength(1);
    await env.DB.prepare("UPDATE candidates SET review_status = 'pending'").run();
    expect((await readArticles()).articles).toEqual([]);
  });

  it("多个节点同一版本只给一份；最新事件证据未发布时按各节点已发布证据去重，新抓取在前", async () => {
    await seedArticleSource();
    await seedVersion("v1", 1, NOW - 2000);
    await seedVersion("v2", 2, NOW - 1000);
    await seedVersion("v3-unpublished", 3, NOW - 10);
    const [a, b] = await seedPublishedNodes(["node-a", "node-b"]);
    await seedApproval("both", [must(a), must(b)], "v1", NOW - 20);
    expect((await readArticles()).articles.map((x) => x.versionNo)).toEqual([1]);
    await seedApproval("only-b", [must(b)], "v2", NOW - 10);
    // 最新事件证据（only-b）已发布但不覆盖 node-a：与公告发布时间相同，node-a 不能证明绑定。
    expect((await readArticles()).articles.map((x) => x.versionNo)).toEqual([2]);
    await seedApproval("newer", [must(a), must(b)], "v3-unpublished", NOW + 1);
    // 最新事件证据晚于本代发布：各节点回落到自己已发布的证据。
    expect((await readArticles()).articles.map((x) => x.versionNo)).toEqual([2, 1]);
  });

  it("正文累计超过公共响应上限明确不可用，不返回截断的原文", async () => {
    await seedArticleSource();
    const big = (chars: number) => [
      { kind: "title", text: "长公告" },
      { kind: "html", html: `<p>${"长".repeat(chars)}</p>` },
    ];
    // 每篇约 0.6 倍上限（"长"占 3 字节）：新抓取的那篇先计入，旧的那篇累计超限被置空 → 整体不可用。
    await seedVersion("v1", 1, NOW - 2000, big(LIMITS.responseBytes / 5));
    await seedVersion("v2", 2, NOW - 1000, big(LIMITS.responseBytes / 5));
    const [a, b] = await seedPublishedNodes(["node-a", "node-b"]);
    await seedApproval("only-a", [must(a)], "v1", NOW - 20);
    await seedApproval("only-b", [must(b)], "v2", NOW - 10);
    await seedApproval("newer", [must(a), must(b)], "v1", NOW + 1);
    await expect(
      readEventArticles(env.DB, url("events/event/articles"), "event", NOW),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
    await env.DB.prepare("DELETE FROM evidence WHERE candidate_id = 'only-a'").run();
    expect((await readArticles()).articles.map((x) => x.versionNo)).toEqual([2]);
  });

  it("路由：原文子资源 200 且可缓存；无发布代次 503、没有此事件 404、多余路径或参数 400", async () => {
    expect((await request("events/event/articles")).status).toBe(503);
    await seedArticleSource();
    await seedVersion("v1", 1, NOW - 500);
    await seedApproval("approved", await seedPublishedNodes(["node"]), "v1");
    const ok = await request("events/event/articles");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-cache");
    expect(PublicEventArticlesResponseSchema.parse(await ok.json()).articles).toHaveLength(1);
    expect((await request("events/no-such-event/articles")).status).toBe(404);
    expect((await request("events/event/articles?cursor=x")).status).toBe(400);
    expect((await request("events/event/articles/extra")).status).toBe(400);
    expect((await request("events/event/other")).status).toBe(400);
    expect((await request("events/event")).status).toBe(200);
  });
});
