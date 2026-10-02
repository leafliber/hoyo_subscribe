import { env } from "cloudflare:test";
import {
  CALENDAR_PREVIEW_RATE_LIMIT,
  CALENDAR_PREVIEW_RATE_WINDOW,
  CalendarNodesResponseSchema,
  CalendarPreviewResponseSchema,
  decideCalendarPatch,
  explainCalendarPreview,
  FEED_BASE_NODE_MAX,
  FEED_MAX_STALE,
  FEED_PATCH_NODE_MAX,
  FEED_RESPONSE_MAX_BYTES,
  feedWindow,
  PUBLIC_CACHE_FRESH,
  PUBLIC_READ_LIMITS,
  requiredCalendarSources,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionAuthenticator } from "../../auth/sessions/authenticator";
import { createApiShell } from "../../shell/router";
import { fakeExecutionContext } from "../../shell/test-support";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { splitSqlStatements } from "../../storage/split-sql";
import { makeFeedHandler } from "../feed/handler";
import { FeedPublicCache, requiredFeedSources } from "../feed/public-read";
import { encodePreviewCursor, previewIcs } from "./read";
import { makeCalendarPreviewRoutes } from "./routes";
import {
  config,
  feed,
  node,
  run,
  type StampedNode,
  savedState,
  seed,
  snapshot,
  T,
} from "./test-support";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
let user: Awaited<ReturnType<typeof seed>>,
  at = T;
let shell: ReturnType<typeof createApiShell>;
const site = "https://app.test",
  publicPath = "/api/v2/calendar/nodes",
  privatePath = "/api/v2/me/calendar/preview";
function request(path: string, cookie = false) {
  return shell.fetch(
    new Request(site + path, {
      headers: cookie ? { cookie: `__Host-session=${user.cookie}` } : {},
    }),
    env,
    fakeExecutionContext,
  );
}
function continuation(path: string, values: Parameters<typeof encodePreviewCursor>[0]) {
  return `${path}?cursor=${encodeURIComponent(encodePreviewCursor(values))}`;
}
beforeAll(async () => {
  for (const name of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[name] ?? "").map((sql) => env.DB.prepare(sql)),
    );
}, 60000);
beforeEach(async () => {
  at = T;
  user = await seed();
  await snapshot([node("synthetic-node")]);
  const cache = new FeedPublicCache();
  shell = createApiShell({
    authenticator: sessionAuthenticator(env.DB, () => at),
    routes: makeCalendarPreviewRoutes({ cache, now: () => at }),
    feedHandler: makeFeedHandler({ cache, now: () => at }),
  });
});
describe("A-P3-PREVIEW 真实外壳/D1", () => {
  it("公开响应 Cookie 无关、严格白名单、不泄漏内部字段，浏览器与服务端等价且只读", async () => {
    const before = await savedState(user.userId);
    const anonymous = await request(publicPath),
      logged = await request(publicPath, true);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe(`public, max-age=${PUBLIC_CACHE_FRESH}`);
    const body = CalendarNodesResponseSchema.parse(await anonymous.json());
    expect(await logged.json()).toEqual(body);
    const saved = await request(privatePath, true);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("private, no-store");
    const preview = CalendarPreviewResponseSchema.parse(await saved.json());
    expect(preview.items).toEqual(
      explainCalendarPreview(preview.config, body.nodes, body.asOf).items,
    );
    expect(preview).toMatchObject({ outcome: "ok", server_time: T, subscription: { revision: 1 } });
    expect(await savedState(user.userId)).toEqual(before);
    for (const field of [
      "user_id",
      "source_projection_json",
      "human_locked",
      "public_ical_revision",
      "token_hash",
    ])
      expect(JSON.stringify(body)).not.toContain(field);
    for (const query of [
      "games=genshin",
      "source=draft",
      "cursor=x&cursor=y",
      `cursor=${"x".repeat(PUBLIC_READ_LIMITS.queryBytes)}`,
    ])
      expect((await request(`${publicPath}?${query}`)).status).toBe(400);
    expect((await request(`${privatePath}?source=draft`, true)).status).toBe(400);
  });
  it("公开路由完全不调用认证器；私人不接受无会话/pending，受限恢复会话可读", async () => {
    const auth = vi.fn().mockRejectedValue(new Error("must not authenticate"));
    const publicShell = createApiShell({
      authenticator: { authenticate: auth },
      routes: makeCalendarPreviewRoutes({ now: () => at }),
    });
    expect(
      (
        await publicShell.fetch(
          new Request(site + publicPath, { headers: { cookie: "bad=synthetic" } }),
          env,
          fakeExecutionContext,
        )
      ).status,
    ).toBe(200);
    expect(auth).not.toHaveBeenCalled();
    expect((await request(privatePath)).status).toBe(401);
    await run("UPDATE sessions SET state='pending' WHERE id=?", user.sessionId);
    expect((await request(privatePath, true)).status).toBe(401);
    await run(
      "UPDATE sessions SET state='active',recovery_code_required=1 WHERE id=?",
      user.sessionId,
    );
    expect((await request(privatePath, true)).status).toBe(200);
    user = await seed(false);
    const invalid = await request(privatePath, true);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { details: { fields: [{ reason: "subscription_uninitialized" }] } },
    });
  });
  it("缺少完整代次/损坏计数返回 503 snapshot_unavailable，不能伪装空日历", async () => {
    await run("UPDATE public_snapshots SET node_count=NULL WHERE state='current'");
    for (const path of [publicPath, privatePath]) {
      const response = await request(path, true);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ calendar: { reason: "snapshot_unavailable" } });
    }
  });
  it("游标绑定 generation/revision/asOf，未来/早于发布时间拒绝，私人过旧拒绝", async () => {
    for (const path of [publicPath, privatePath]) {
      const revision = path === privatePath ? { revision: 1 } : {};
      const cursor = { generation: 1, asOf: T, offset: 0, ...revision };
      for (const asOf of [T + 1, T - 1])
        expect((await request(continuation(path, { ...cursor, asOf }), true)).status).toBe(400);
      const oldGeneration = await request(continuation(path, { ...cursor, generation: 2 }), true);
      expect(oldGeneration.status).toBe(409);
      expect(await oldGeneration.json()).toMatchObject({
        error: { details: { reason: "preview_outdated" } },
      });
    }
    const changed = await request(
      continuation(privatePath, { generation: 1, revision: 2, asOf: T, offset: 0 }),
      true,
    );
    expect(changed.status).toBe(409);
    at = T + PUBLIC_CACHE_FRESH * 1000 + 1;
    expect(
      (
        await request(
          continuation(privatePath, { generation: 1, revision: 1, asOf: T, offset: 0 }),
          true,
        )
      ).status,
    ).toBe(409);
    expect(
      (await request(continuation(publicPath, { generation: 1, asOf: T, offset: 0 }))).status,
    ).toBe(200);
  });
  it("自适应分页完整且同一时刻；续页实际换代/改订阅拒绝", async () => {
    const values = Array.from({ length: 220 }, (_, i) => {
      const n = node(`page-${String(i).padStart(3, "0")}`);
      return {
        ...n,
        projection: { ...n.projection, event: { ...n.projection.event, title: "文".repeat(900) } },
      };
    });
    await snapshot(values);
    for (const path of [publicPath, privatePath]) {
      let cursor: string | null = null,
        count = 0,
        pages = 0;
      do {
        const response = await request(
          path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
          true,
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
          PUBLIC_READ_LIMITS.responseBytes,
        );
        const body =
          path === publicPath
            ? CalendarNodesResponseSchema.parse(JSON.parse(text))
            : CalendarPreviewResponseSchema.parse(JSON.parse(text));
        expect(body.asOf).toBe(T);
        count += "nodes" in body ? body.nodes.length : body.items.length;
        cursor = body.nextCursor;
        pages++;
        at = T + 1;
      } while (cursor);
      expect(count).toBe(values.length);
      expect(pages).toBeGreaterThan(1);
      at = T;
    }
    const first = CalendarNodesResponseSchema.parse(await (await request(publicPath)).json());
    await snapshot(values, 2);
    expect(
      (await request(`${publicPath}?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).status,
    ).toBe(409);
    const saved = CalendarPreviewResponseSchema.parse(
      await (await request(privatePath, true)).json(),
    );
    await run("UPDATE user_subscriptions SET revision=2 WHERE user_id=?", user.userId);
    expect(
      (await request(`${privatePath}?cursor=${encodeURIComponent(saved.nextCursor ?? "")}`, true))
        .status,
    ).toBe(409);
  });
  it("全集任一节点超限即 503，不返回截断的前页", async () => {
    const large = node("z-large");
    await snapshot([
      node("a-small"),
      {
        ...large,
        projection: {
          ...large.projection,
          event: { ...large.projection.event, title: "x".repeat(PUBLIC_READ_LIMITS.nodeBytes) },
        },
      },
    ]);
    expect((await request(publicPath)).status).toBe(503);
    expect((await request(privatePath, true)).status).toBe(503);
  });
  it.each(["source_stale", "base_node_limit", "patch_node_limit", "response_byte_limit"] as const)(
    "blocked %s 与真实 Feed 503 同码且保留条目",
    async (reason) => {
      let values: StampedNode[] = [node("blocked")];
      if (reason === "source_stale")
        await run("UPDATE sources SET last_success_at=?", T - FEED_MAX_STALE * 1000 - 1);
      if (reason === "base_node_limit")
        values = Array.from({ length: FEED_BASE_NODE_MAX + 1 }, (_, i) => node(`base-${i}`));
      if (reason === "patch_node_limit")
        values = Array.from({ length: FEED_PATCH_NODE_MAX + 1 }, (_, i) => {
          const n = node(`patch-${i}`);
          return { ...n, tombstone: true, patch: decideCalendarPatch(n.projection, null, null, T) };
        });
      if (reason === "response_byte_limit")
        values = Array.from({ length: FEED_BASE_NODE_MAX }, (_, i) => {
          const n = node(`byte-${i}`);
          return {
            ...n,
            projection: {
              ...n.projection,
              event: {
                ...n.projection.event,
                summary: "x".repeat(Math.ceil(FEED_RESPONSE_MAX_BYTES / FEED_BASE_NODE_MAX)),
              },
            },
          };
        });
      await snapshot(values);
      const address = await feed(user.userId);
      const preview = await request(privatePath, true);
      expect(preview.status).toBe(200);
      expect(CalendarPreviewResponseSchema.parse(await preview.json())).toMatchObject({
        outcome: "blocked",
        diagnostic: reason,
      });
      const actual = await request(`/feeds/u/${address.token}.ics`);
      expect(actual.status).toBe(503);
      expect(await actual.json()).toMatchObject({ calendar: { reason } });
    },
    30000,
  );
  it("来源规则抽取保持 Feed 字节；预览序列化与真实 Feed 仅等长 namespace 不同", async () => {
    const oldIds = SOURCE_REGISTRY.filter(
      (e) =>
        !e.contentChannelDisabled &&
        config.scope.games.includes(e.game) &&
        config.scope.regions.some((r) => r.toLowerCase() === e.region),
    ).map((e) => e.sourceId);
    expect(requiredFeedSources(config)).toEqual(oldIds);
    expect(requiredCalendarSources(config, SOURCE_REGISTRY).map((s) => s.sourceId)).toEqual(oldIds);
    const values = [node("normal"), node("history", feedWindow(T).start - 1)];
    await snapshot(values);
    const address = await feed(user.userId);
    const before = await (await request(`/feeds/u/${address.token}.ics`)).text();
    await request(publicPath);
    await request(privatePath, true);
    const after = await (await request(`/feeds/u/${address.token}.ics`)).text();
    expect(after).toBe(before);
    const simulated = previewIcs({ generation: 1, published_at: T, nodes: values }, config, T, {
      view_revision: 0,
      changed_at: T,
    });
    expect(simulated).toBe(
      before.replaceAll(address.namespace, "00000000-0000-0000-0000-000000000000"),
    );
    expect(new TextEncoder().encode(simulated).length).toBe(
      new TextEncoder().encode(before).length,
    );
  });
});

it("A-P3-PREVIEW 实际 VEVENT 逐项对应更正、取消、删除、纯日期和预计关联省略", async () => {
  const { default: ICAL } = await import("ical.js");
  const { TimeValueSchema } = await import("@hoyo/contracts");
  const old = node("moved"),
    moved = node("moved", feedWindow(T).end + 86400000);
  const cancelled = node("cancelled"),
    retracted = node("retracted"),
    deleted = node("deleted"),
    pending = node("pending");
  const date = node("date"),
    estimate = node("estimate");
  const values: StampedNode[] = [
    { ...moved, patch: decideCalendarPatch(old.projection, moved.projection, null, T) },
    ...(
      [
        [cancelled, "cancelled"],
        [retracted, "retracted"],
      ] as const
    ).map(([n, status]) => {
      const projection = { ...n.projection, event: { ...n.projection.event, status } };
      return { ...n, projection, patch: decideCalendarPatch(n.projection, projection, null, T) };
    }),
    { ...deleted, tombstone: true, patch: decideCalendarPatch(deleted.projection, null, null, T) },
    (() => {
      const projection = {
        ...pending.projection,
        event: { ...pending.projection.event, status: "postponed" as const },
        milestone: {
          ...pending.projection.milestone,
          time: TimeValueSchema.parse({
            precision: "unknown",
            time_basis: "unresolved",
            source_timezone: "UTC",
            raw_expression: "synthetic TBD",
          }),
        },
      };
      return {
        ...pending,
        projection,
        patch: decideCalendarPatch(pending.projection, projection, null, T),
      };
    })(),
    {
      ...date,
      projection: {
        ...date.projection,
        milestone: {
          ...date.projection.milestone,
          node_type: "end",
          time: TimeValueSchema.parse({
            precision: "date",
            date: "2026-10-02",
            source_timezone: "UTC",
            time_basis: "official_explicit",
            raw_expression: "synthetic day",
          }),
        },
      },
    },
    {
      ...estimate,
      projection: {
        ...estimate.projection,
        milestone: {
          ...estimate.projection.milestone,
          node_type: "end",
          time: { ...estimate.projection.milestone.time, time_basis: "official_estimate" },
        },
      },
    },
  ];
  await snapshot(values);
  const address = await feed(user.userId);
  const preview = CalendarPreviewResponseSchema.parse(
    await (await request(privatePath, true)).json(),
  );
  expect(preview.omitted.reminderNotExact).toBe(2);
  const actual = await request(`/feeds/u/${address.token}.ics`);
  expect(actual.status).toBe(200);
  const events = new ICAL.Component(ICAL.parse(await actual.text())).getAllSubcomponents("vevent");
  expect(events).toHaveLength(preview.items.length);
  for (const item of preview.items) {
    const component = events.find((e) =>
      String(e.getFirstPropertyValue("uid")).includes(`.${encodeURIComponent(item.milestoneId)}@`),
    );
    if (!component) throw new Error("missing event");
    const event = new ICAL.Event(component);
    expect(event.summary).toBe(`${item.eventTitle} · ${item.milestoneTitle}`);
    expect(component.getFirstPropertyValue("status") === "CANCELLED").toBe(item.cancelled);
    if (item.time.precision === "datetime")
      expect(event.startDate.toJSDate().getTime()).toBe(item.time.utc_ms);
    else expect(event.startDate.toString()).toBe(item.time.date);
    expect(
      component
        .getAllSubcomponents("valarm")
        .map((a) => -(a.getFirstPropertyValue("trigger") as { toSeconds(): number }).toSeconds()),
    ).toEqual(item.alarm?.leadSeconds ?? []);
  }
});

it("A-P3-PREVIEW 串行第 RATE_LIMIT+1 次 429，窗口恢复且拒绝不延长窗口、全程只读", async () => {
  const before = await savedState(user.userId);
  const prepare = vi.spyOn(env.DB, "prepare");
  try {
    for (let i = 0; i < CALENDAR_PREVIEW_RATE_LIMIT; i++)
      expect((await request(privatePath, true)).status).toBe(200);
    const denied = await request(privatePath, true);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(await denied.json()).toMatchObject({
      error: {
        code: "rate_limited",
        details: {
          code: "rate_limited",
          retry_after_ms: CALENDAR_PREVIEW_RATE_WINDOW * 1000,
        },
      },
    });
    at = T + CALENDAR_PREVIEW_RATE_WINDOW * 1000 - 1;
    expect((await request(privatePath, true)).status).toBe(429);
    at++;
    expect((await request(privatePath, true)).status).toBe(200);
    // 包含外壳鉴权在内，全部 SQL 为 SELECT：无账本、活动水位或续期写入。
    expect(prepare.mock.calls.length).toBeGreaterThan(0);
    for (const [sql] of prepare.mock.calls) expect(sql.trim()).toMatch(/^SELECT\b/i);
  } finally {
    prepare.mockRestore();
  }
  expect(await savedState(user.userId)).toEqual(before);
});

it("A-P3-PREVIEW 首屏和续页共桶；429 后保留游标，等待窗口后完整续完", async () => {
  const values = Array.from({ length: 220 }, (_, i) => {
    const n = node(`rate-page-${String(i).padStart(3, "0")}`);
    return {
      ...n,
      projection: { ...n.projection, event: { ...n.projection.event, title: "文".repeat(900) } },
    };
  });
  await snapshot(values);
  const before = await savedState(user.userId);
  const first = CalendarPreviewResponseSchema.parse(
    await (await request(privatePath, true)).json(),
  );
  expect(first.nextCursor).not.toBeNull();
  const path = `${privatePath}?cursor=${encodeURIComponent(first.nextCursor ?? "")}`;
  for (let i = 1; i < CALENDAR_PREVIEW_RATE_LIMIT; i++)
    expect((await request(i % 2 === 0 ? privatePath : path, true)).status).toBe(200);
  for (const p of [privatePath, path]) expect((await request(p, true)).status).toBe(429);
  at = T + CALENDAR_PREVIEW_RATE_WINDOW * 1000;
  let cursor = first.nextCursor,
    count = first.items.length;
  do {
    const response = await request(
      `${privatePath}?cursor=${encodeURIComponent(cursor ?? "")}`,
      true,
    );
    expect(response.status).toBe(200);
    const body = CalendarPreviewResponseSchema.parse(await response.json());
    expect(body.asOf).toBe(first.asOf);
    expect(body.server_time).toBe(at);
    count += body.items.length;
    cursor = body.nextCursor;
  } while (cursor);
  expect(count).toBe(first.totals.items);
  expect(await savedState(user.userId)).toEqual(before);
});

it("A-P3-PREVIEW 不同会话隔离（含同账号），公开节点与 Feed 不消耗私人桶", async () => {
  const original = user;
  const other = await seed();
  await run("UPDATE sessions SET user_id=? WHERE id=?", original.userId, other.sessionId);
  const address = await feed(original.userId);
  for (let i = 0; i < CALENDAR_PREVIEW_RATE_LIMIT; i++) {
    expect((await request(publicPath, true)).status).toBe(200);
    expect((await request(`/feeds/u/${address.token}.ics`)).status).toBe(200);
    expect((await request(privatePath, true)).status).toBe(200);
  }
  expect((await request(privatePath, true)).status).toBe(429);
  user = other;
  for (let i = 0; i < CALENDAR_PREVIEW_RATE_LIMIT; i++)
    expect((await request(privatePath, true)).status).toBe(200);
  expect((await request(privatePath, true)).status).toBe(429);
  user = original;
  expect((await request(publicPath, true)).status).toBe(200);
  expect((await request(`/feeds/u/${address.token}.ics`)).status).toBe(200);
});

it("A-P3-PREVIEW 并发先占用窗口，不超卖；完成请求不释放次数", async () => {
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  class DelayedCache extends FeedPublicCache {
    override async read(db: D1Database, now: number) {
      entered++;
      await barrier;
      return super.read(db, now);
    }
  }
  const local = createApiShell({
    authenticator: sessionAuthenticator(env.DB, () => T),
    routes: makeCalendarPreviewRoutes({ cache: new DelayedCache(), now: () => T }),
  });
  const get = () =>
    local.fetch(
      new Request(site + privatePath, {
        headers: { cookie: `__Host-session=${user.cookie}` },
      }),
      env,
      fakeExecutionContext,
    );
  const before = await savedState(user.userId);
  let deniedCount = 0;
  const calls = Array.from({ length: CALENDAR_PREVIEW_RATE_LIMIT + 1 }, () =>
    get().then((r) => {
      if (r.status === 429) deniedCount++;
      return r;
    }),
  );
  try {
    await vi.waitFor(() => {
      expect(entered).toBe(CALENDAR_PREVIEW_RATE_LIMIT);
      expect(deniedCount).toBe(1);
    });
  } finally {
    release?.();
  }
  const responses = await Promise.all(calls);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(CALENDAR_PREVIEW_RATE_LIMIT);
  expect(responses.filter((r) => r.status === 429)).toHaveLength(1);
  expect((await get()).status).toBe(429);
  expect(await savedState(user.userId)).toEqual(before);
});

it("A-P3-PREVIEW Worker 真实入口跨请求保留限流桶，失败的读取不退次数", async () => {
  const { default: worker } = await import("../../index");
  const clock = vi.spyOn(Date, "now").mockReturnValue(T);
  const before = await savedState(user.userId);
  try {
    for (let i = 0; i < CALENDAR_PREVIEW_RATE_LIMIT; i++) {
      const r = await worker.fetch(
        new Request(site + privatePath + "?cursor=bad", {
          headers: { cookie: `__Host-session=${user.cookie}` },
        }),
        env,
        fakeExecutionContext,
      );
      expect(r.status).toBe(400);
    }
    const denied = await worker.fetch(
      new Request(site + privatePath, {
        headers: { cookie: `__Host-session=${user.cookie}` },
      }),
      env,
      fakeExecutionContext,
    );
    expect(denied.status).toBe(429);
    expect(await denied.text()).not.toContain(user.sessionId);
  } finally {
    clock.mockRestore();
  }
  expect(await savedState(user.userId)).toEqual(before);
});
