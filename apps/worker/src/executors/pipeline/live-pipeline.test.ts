// ADR-0030 · 直播兑换码来源全链：发现 → 兑换码条数据 → 文章版本 → 规则模板 → 发布兑换码事件。
// 真实本地 D1；官方接口全部是合成响应（字段按官方直播页前端构造），不访问官方。
import { env } from "cloudflare:test";
import { REDEEM_CODE_REVEAL_GRACE, SOURCE_POLL } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import indexActive from "../../../../../fixtures/sources/miyolive/synthetic-index-active.json";
import codesActive from "../../../../../fixtures/sources/miyolive/synthetic-refresh-code.json";
import { readRedeemCodes } from "../../public/read";
import { splitSqlStatements } from "../../storage/split-sql";
import type { PipelineControls } from "./controls";
import { PipelineRuntime } from "./runtime";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const ACT = "ea202610091930001";
const LIVE_URL = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${ACT}`;
const at = (time: string) => Date.parse(`2026-10-09T${time}+08:00`);
let now = at("20:10:00");
let controls: PipelineControls;
let requests: string[];
let homeStatus = 200;
let homeLives: unknown[] = [];
let closed = false;
let codeList: { title: string; code: string; img: string; to_get_time: string }[];
let indexBody: typeof indexActive.body;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  requests.push(`${url.hostname}${url.pathname}`);
  if (url.hostname === "bbs-api.miyoushe.com") {
    if (homeStatus !== 200) return new Response("", { status: homeStatus });
    return json({
      retcode: 0,
      message: "OK",
      data: { navigator: [], lives: homeLives, carousels: null },
    });
  }
  if (closed) return json({ data: null, message: "活动已结束 (-500012)", retcode: -500012 });
  if (url.pathname.endsWith("/index")) return json(indexBody);
  return json({ retcode: 0, message: "OK", data: { code_list: codeList } });
}) as typeof fetch;

function runtime() {
  return new PipelineRuntime({
    db: env.DB,
    readControls: async () => controls,
    now: () => now,
    fetchFn: fakeFetch,
  });
}
async function drain() {
  for (let i = 0; i < 40; i++) {
    const rt = runtime();
    const next = await rt.nextAlarm();
    if (next === null || next > now) return;
    await rt.tick();
  }
  throw new Error("test_drain_did_not_sleep");
}
async function rows<T>(sql: string, ...params: unknown[]) {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
}
async function redeemCodes() {
  const response = await readRedeemCodes(
    env.DB,
    new URL("https://hoyo.test/api/v2/redeem-codes"),
    now,
  );
  return (await response.json()) as {
    codes: { code: string; eventId: string | null; expiresAt: number | null }[];
  };
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    for (const sql of splitSqlStatements(migrations[path])) await env.DB.prepare(sql).run();
});
beforeEach(async () => {
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ...tables.map((table) => env.DB.prepare(`DELETE FROM ${table.name}`)),
  ]);
  now = at("20:10:00");
  requests = [];
  homeStatus = 200;
  homeLives = [{ title: "前瞻特别节目", app_path: LIVE_URL }];
  closed = false;
  codeList = structuredClone(codesActive.body.data.code_list);
  indexBody = structuredClone(indexActive.body);
  // 公告的「自动发布」关着：兑换码事件仍随来源开关发布（ADR-0030），公告规则候选不受影响。
  controls = {
    sources: { "zzz-live": { enabled: true, mode: "normal" } },
    automaticPublication: false,
    model: false,
    reviewSkip: false,
  };
});

describe("ADR-0030 直播兑换码来源全链", () => {
  it("发现直播 → 兑换码条立即可读 → 兑换码事件随来源开关发布（不经「自动发布」）→ 按发放时刻补取", async () => {
    await runtime().watchdog();
    await drain();
    // 一次采集：首页 1 次 + 活动 2 次。
    expect(requests).toEqual([
      "bbs-api.miyoushe.com/apihub/api/home/new",
      "api-takumi.mihoyo.com/event/miyolive/index",
      "api-takumi-static.mihoyo.com/event/miyolive/refreshCode",
    ]);
    const expiry = Date.parse("2026-10-10T12:00:00+08:00");
    expect(
      await rows(
        "SELECT act_id, code, revealed_at, expires_at, expiry_text, live_closed_at FROM redeem_codes ORDER BY revealed_at",
      ),
    ).toEqual([
      {
        act_id: ACT,
        code: "ZZZ33SYNTHA1",
        revealed_at: at("19:45:00"),
        expires_at: expiry,
        expiry_text: "10月10日12:00",
        live_closed_at: null,
      },
      {
        act_id: ACT,
        code: "ZZZ33SYNTHB2",
        revealed_at: at("20:05:00"),
        expires_at: expiry,
        expiry_text: "10月10日12:00",
        live_closed_at: null,
      },
    ]);
    const [event] = await rows<{
      id: string;
      event_type: string;
      title: string;
      summary: string;
      event_revision: number;
    }>("SELECT id, event_type, title, summary, event_revision FROM events");
    expect(event).toMatchObject({
      event_type: "redeem_code",
      title: "《绝区零》3.3版本「重返天空的旅程」前瞻特别节目兑换码",
      summary: "兑换码：ZZZ33SYNTHA1、ZZZ33SYNTHB2",
    });
    expect(
      await rows(
        "SELECT milestone_key, node_type, title, time_exact_ms, raw_expression, time_basis FROM milestones ORDER BY node_type DESC",
      ),
    ).toEqual([
      {
        milestone_key: "codes_release",
        node_type: "start",
        title: "兑换码发放",
        time_exact_ms: at("19:45:00"),
        raw_expression: "2026/10/09 19:45",
        time_basis: "official_explicit",
      },
      {
        milestone_key: "codes_expiry",
        node_type: "end",
        title: "兑换码过期",
        time_exact_ms: expiry,
        raw_expression: "10月10日12:00",
        time_basis: "deterministic_derived",
      },
    ]);
    expect(
      (
        await rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM public_snapshots WHERE state = 'current'",
        )
      )[0]?.n,
    ).toBe(1);
    const visible = await redeemCodes();
    expect(visible.codes.map((code) => [code.code, code.eventId, code.expiresAt])).toEqual([
      ["ZZZ33SYNTHA1", event?.id, expiry],
      ["ZZZ33SYNTHB2", event?.id, expiry],
    ]);
    // 第三个兑换码 20:25 发放：下一次采集排在发放时刻后 REDEEM_CODE_REVEAL_GRACE，而不是 30 分钟后。
    const [job] = await rows<{ due_at: number }>(
      "SELECT due_at FROM jobs WHERE id = 'pipeline:source:zzz-live'",
    );
    expect(job?.due_at).toBe(at("20:25:00") + REDEEM_CODE_REVEAL_GRACE * 1000);
    expect(job?.due_at).toBeLessThan(now + SOURCE_POLL * 1000);

    // 到点后补取：第三个兑换码出现，新增一版正文，事件简介更新。
    now = at("20:26:00");
    codeList[2] = { ...codeList[2], code: "ZZZ33SYNTHC3" };
    requests = [];
    await drain();
    expect(requests).toHaveLength(3);
    expect(
      (await rows("SELECT code FROM redeem_codes ORDER BY revealed_at")).map(
        (row) => (row as { code: string }).code,
      ),
    ).toEqual(["ZZZ33SYNTHA1", "ZZZ33SYNTHB2", "ZZZ33SYNTHC3"]);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM article_versions"))[0]?.n).toBe(2);
    const [updated] = await rows<{ summary: string; event_revision: number }>(
      "SELECT summary, event_revision FROM events",
    );
    expect(updated?.summary).toBe("兑换码：ZZZ33SYNTHA1、ZZZ33SYNTHB2、ZZZ33SYNTHC3");
    expect(updated?.event_revision).toBeGreaterThan(event?.event_revision ?? 0);

    // 没有待发放的兑换码后回到常规间隔；内容不变不产生新版本。
    const [after] = await rows<{ due_at: number }>(
      "SELECT due_at FROM jobs WHERE id = 'pipeline:source:zzz-live'",
    );
    expect(after?.due_at).toBe(now + SOURCE_POLL * 1000);

    // 官方有效期一过，条里就不再显示。
    now = Date.parse("2026-10-10T12:00:00+08:00");
    expect((await redeemCodes()).codes).toEqual([]);
  });

  it("官方返回活动已结束：记下时刻、以后不再请求；没写有效期的兑换码随之从条里收回", async () => {
    // 页面模板没有兑换码说明：兑换码"没写有效期"，日历只有发放节点，条里按显示上限。
    indexBody.data.template = JSON.stringify({ actTitle: "合成", codeVisible: true });
    await runtime().watchdog();
    await drain();
    const undated = await redeemCodes();
    expect(undated.codes.map((code) => code.expiresAt)).toEqual([null, null]);
    expect(await rows("SELECT milestone_key FROM milestones")).toEqual([
      { milestone_key: "codes_release" },
    ]);
    now = at("20:30:00");
    closed = true;
    requests = [];
    await drain();
    // 这一轮仍按上次排定的发放补取时刻到期：首页 + 活动信息（已结束，不再请求兑换码接口）。
    expect(requests).toEqual([
      "bbs-api.miyoushe.com/apihub/api/home/new",
      "api-takumi.mihoyo.com/event/miyolive/index",
    ]);
    const closedRows = await rows<{ live_closed_at: number | null }>(
      "SELECT live_closed_at FROM redeem_codes",
    );
    expect(closedRows.map((row) => row.live_closed_at)).toEqual([now, now]);
    expect((await redeemCodes()).codes).toEqual([]);
    const [source] = await rows<{ cursor_json: string }>(
      "SELECT cursor_json FROM sources WHERE source_id = 'zzz-live'",
    );
    expect(JSON.parse(source?.cursor_json ?? "{}").lives).toEqual([
      { actId: ACT, firstSeenAtMs: at("20:10:00"), closedAtMs: now },
    ]);
    // 下一轮只请求首页：已结束的活动即使首页仍挂着链接也不再请求。
    now += SOURCE_POLL * 1000;
    requests = [];
    await drain();
    expect(requests).toEqual(["bbs-api.miyoushe.com/apihub/api/home/new"]);
  });

  it("首页没有直播入口时用管理员登记的活动 ID；公开接口无缓存副本、不接受查询参数", async () => {
    homeLives = [];
    await env.DB.prepare(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('redeem_live_hints:zzz-live',?,?)",
    )
      .bind(JSON.stringify([{ act_id: ACT, added_at: now - 60_000 }]), now)
      .run();
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual([
      "bbs-api.miyoushe.com/apihub/api/home/new",
      "api-takumi.mihoyo.com/event/miyolive/index",
      "api-takumi-static.mihoyo.com/event/miyolive/refreshCode",
    ]);
    const response = await readRedeemCodes(
      env.DB,
      new URL("https://hoyo.test/api/v2/redeem-codes"),
      now,
    );
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(((await response.json()) as { codes: unknown[] }).codes).toHaveLength(2);
    await expect(
      readRedeemCodes(env.DB, new URL("https://hoyo.test/api/v2/redeem-codes?game=zzz"), now),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("首页 403：来源停用并标维护，不写兑换码、不请求活动接口（规则 6）", async () => {
    homeStatus = 403;
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual(["bbs-api.miyoushe.com/apihub/api/home/new"]);
    expect(
      await rows("SELECT verification_state FROM sources WHERE source_id = 'zzz-live'"),
    ).toEqual([{ verification_state: "maintenance-required" }]);
    expect(await rows("SELECT code FROM redeem_codes")).toEqual([]);
  });

  it("来源开关关着时不采集、不发布", async () => {
    controls = { ...controls, sources: { "zzz-live": { enabled: false, mode: "normal" } } };
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual([]);
    expect(await rows("SELECT id FROM events")).toEqual([]);
  });
});
