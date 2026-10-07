import { expect, test } from "@playwright/test";
import { sourceFeedback } from "../../apps/web/src/features/schedule/source-status";
import { PublicApiClient, PublicReadError } from "../../apps/web/src/lib/public-api/client";
import {
  browseWindow,
  EVENT_TYPES,
  NODE_TYPES,
  type PublicSourceStatus,
  publicCache,
  SUPPORTED_SCOPE,
} from "../../packages/contracts/src/index";

const now = Date.parse("2026-10-01T04:00:00Z");
const catalog = {
  games: [...SUPPORTED_SCOPE.games],
  regions: [...SUPPORTED_SCOPE.regions],
  eventTypes: [...EVENT_TYPES],
  nodeTypes: [...NODE_TYPES],
  publication: { generation: 1, publishedAt: now - 1000 },
  cache: publicCache(null, now),
};

test("U01 U06 公共客户端只做无凭证 GET，不传浏览页秘密或创建身份", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const api = new PublicApiClient(async (path, init) => {
    calls.push({ path, init });
    return Response.json(catalog);
  });
  expect(await api.catalog()).toEqual(catalog);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe("/api/v2/catalog");
  expect(calls[0]?.init).toMatchObject({
    method: "GET",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
  expect(calls[0]?.init?.body).toBeUndefined();
});

test("U05 响应形状不合同时明确失败，不把错误对象或空对象当空日程", async () => {
  const api = new PublicApiClient(async () => Response.json({}));
  await expect(api.catalog()).rejects.toMatchObject({ kind: "invalid_response" });
});

test("U05 分页游标仅作不透明参数；空页的 nextCursor 不丢失", async () => {
  const calls: string[] = [];
  const api = new PublicApiClient(async (path) => {
    calls.push(path);
    return Response.json({
      publication: catalog.publication,
      cache: catalog.cache,
      window: browseWindow("all", now),
      nodes: [],
      recentChanges: [],
      recentChangesTruncated: false,
      nextCursor: "opaque+/=cursor",
    });
  });
  const result = await api.events({ games: ["genshin"], range: "3d" }, "opaque+/=cursor");
  const query = new URL(calls[0] ?? "", "https://example.test").searchParams;
  expect([...query.keys()].sort()).toEqual(["cursor", "games", "range"]);
  expect(query.get("cursor")).toBe("opaque+/=cursor");
  expect(result.nodes).toEqual([]);
  expect(result.nextCursor).toBe("opaque+/=cursor");
});

test("U02 详情按 eventId 编码，404 保留状态，不回退 synthetic 详情", async () => {
  let requested = "";
  const api = new PublicApiClient(async (path) => {
    requested = path;
    return new Response(null, { status: 404 });
  });
  await expect(api.detail("event/with ?query")).rejects.toMatchObject({ status: 404 });
  expect(requested).toBe("/api/v2/events/event%2Fwith%20%3Fquery");
});

test("U05 409 交给页面重载代次，不由传输层自动重试", async () => {
  let calls = 0;
  const api = new PublicApiClient(async () => {
    calls++;
    return new Response(null, { status: 409 });
  });
  await expect(api.events({ games: [], range: "today" })).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(1);
});

test("U05 请求取消向上传递，不成为失败提示或隐式重试", async () => {
  const controller = new AbortController();
  const api = new PublicApiClient(async (_path, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  });
  await expect(api.status(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("U05 网络失败不当作无日程；服务端限速保留可公开等待信息", async () => {
  const network = new PublicApiClient(async () => {
    throw new TypeError("synthetic network");
  });
  await expect(network.catalog()).rejects.toMatchObject({ kind: "network", status: null });
  const limited = new PublicApiClient(async () =>
    Response.json(
      {
        error: {
          code: "rate_limited",
          message: "synthetic",
          details: { code: "rate_limited", retry_after_ms: 1234 },
        },
      },
      { status: 429 },
    ),
  );
  try {
    await limited.catalog();
    throw new Error("expected a failure");
  } catch (error) {
    expect(error).toBeInstanceOf(PublicReadError);
    expect((error as PublicReadError).body?.error.code).toBe("rate_limited");
    expect((error as PublicReadError).retryAfterMs).toBe(1234);
  }
});

for (const verificationState of ["unknown", "unavailable", "verified"] as const) {
  test(`U05 maintenance_required 优先于 ${verificationState}，显示维护中`, () => {
    const source: PublicSourceStatus = {
      sourceId: "synthetic-maintenance",
      game: "genshin",
      kind: "announcement",
      verifiedAt: null,
      verificationState,
      degradationReasons: ["maintenance_required"],
    };
    expect(sourceFeedback(source)).toEqual({ label: "维护中，暂不可用", affected: true });
  });
}

test("U05 同游戏来源分别呈现；仅列表可用不把正常官方来源改为不可用", () => {
  const official: PublicSourceStatus = {
    sourceId: "synthetic-official",
    game: "genshin",
    kind: "announcement",
    verifiedAt: now,
    verificationState: "verified",
    degradationReasons: [],
  };
  const listOnly: PublicSourceStatus = {
    ...official,
    sourceId: "synthetic-list",
    degradationReasons: ["content_unavailable"],
  };
  expect(sourceFeedback(official)).toEqual({ label: "已核验", affected: false });
  expect(sourceFeedback(listOnly)).toEqual({ label: "仅列表可用，正文暂不可用", affected: true });
  expect(
    sourceFeedback({
      ...official,
      verifiedAt: null,
      verificationState: "unknown",
      degradationReasons: ["not_verified"],
    }),
  ).toEqual({ label: "核验状态未知", affected: true });
});
