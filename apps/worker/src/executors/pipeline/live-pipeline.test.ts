// ADR-0030 · 直播兑换码来源全链：发现 → 兑换码条数据 → 文章版本 → 规则模板 → 发布兑换码事件。
// 真实本地 D1；官方接口全部是合成响应（字段按官方直播页前端构造），不访问官方。
import { env } from "cloudflare:test";
import { REDEEM_CODE_REVEAL_GRACE, SOURCE_POLL } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import indexActive from "../../../../../fixtures/sources/miyolive/synthetic-index-active.json";
import codesActive from "../../../../../fixtures/sources/miyolive/synthetic-refresh-code.json";
import { eventIdentity, milestoneIdentity } from "../../extraction/identity";
import { readEventDetail, readEvents, readRedeemCodes } from "../../public/read";
import { splitSqlStatements } from "../../storage/split-sql";
import type { PipelineControls } from "./controls";
import { PipelineRuntime } from "./runtime";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
// ADR-0034 第 7 条：所有者在正式 D1 上执行的一次性清理 SQL，这里原样执行同一份文件。
const runbooks = import.meta.glob("../../../../../docs/runbooks/*.sql", {
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
    codes: {
      code: string;
      eventId: string | null;
      expiresAt: number | null;
      expiryText: string | null;
    }[];
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
    // 页面模板没有兑换码说明：兑换码"没写有效期"，日历只有发放节点。
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
    expect(JSON.parse(source?.cursor_json ?? "{}").lives).toMatchObject([
      { actId: ACT, firstSeenAtMs: at("20:10:00"), closedAtMs: now, checkedAtMs: at("20:10:00") },
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

describe("ADR-0034 取到兑换码才进日程；截止时间与整点核对", () => {
  const HOME = "bbs-api.miyoushe.com/apihub/api/home/new";
  const INDEX = "api-takumi.mihoyo.com/event/miyolive/index";
  const CODES = "api-takumi-static.mihoyo.com/event/miyolive/refreshCode";
  const beijing = (text: string) => Date.parse(`${text}+08:00`);
  const sourceDue = async () =>
    (
      await rows<{ due_at: number }>(
        "SELECT due_at FROM jobs WHERE id = 'pipeline:source:zzz-live'",
      )
    )[0]?.due_at;
  const shownCodes = async () => (await redeemCodes()).codes.map((code) => code.code);
  /** 直播已收尾：官方 is_end 为真，三个兑换码都已发放。 */
  function endedLive(tip: boolean) {
    if (!tip) indexBody.data.template = JSON.stringify({ actTitle: "合成", codeVisible: true });
    indexBody.data.live.is_end = true;
    codeList[2] = { ...codeList[2], code: "ZZZ33SYNTHC3" };
    now = at("20:40:00");
  }
  /** 管理员登记截止时间（接口本身见 redeem-expiry.test.ts）：写登记表，并把来源待办提前到现在。 */
  async function register(expression: string, instant: number) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO redeem_live_expiry(source_id,act_id,expires_at,expression,created_at,updated_at)
         VALUES ('zzz-live',?,?,?,?,?) ON CONFLICT(source_id,act_id) DO UPDATE SET
           expires_at=excluded.expires_at, expression=excluded.expression, updated_at=excluded.updated_at`,
      ).bind(ACT, instant, expression, now, now),
      env.DB.prepare(
        "UPDATE jobs SET due_at = ? WHERE id = 'pipeline:source:zzz-live' AND status = 'pending'",
      ).bind(now),
    ]);
  }

  it("官方只预告了发放时刻、码还空着时不进日程；取到兑换码的这一轮发布并更新日历，官方改了发放时刻也不产生改期", async () => {
    // 2026-10-09 绝区零 3.3 实测：预告 19:49，实际 19:43:30 发放，官方随之把 to_get_time 改成实际时刻；
    // 官方没写兑换码说明。
    now = at("19:40:00");
    indexBody.data.template = JSON.stringify({ actTitle: "合成", codeVisible: true });
    codeList = [{ ...codeList[0], code: "", to_get_time: String(at("19:49:00") / 1000) }];
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    expect(await rows("SELECT id FROM article_versions")).toEqual([]);
    expect(await rows("SELECT id FROM events")).toEqual([]);
    expect(await shownCodes()).toEqual([]);
    expect(await sourceDue()).toBe(at("19:49:00") + REDEEM_CODE_REVEAL_GRACE * 1000);

    now = at("19:49:00") + REDEEM_CODE_REVEAL_GRACE * 1000;
    codeList = [
      { ...codeList[0], code: "PHOENIX1021", to_get_time: String(at("19:43:30") / 1000) },
    ];
    requests = [];
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    const [event] = await rows<{ id: string; summary: string }>("SELECT id, summary FROM events");
    expect(event?.summary).toBe("兑换码：PHOENIX1021");
    expect(
      await rows("SELECT milestone_key, time_exact_ms, raw_expression FROM milestones"),
    ).toEqual([
      {
        milestone_key: "codes_release",
        time_exact_ms: at("19:43:30"),
        raw_expression: "2026/10/09 19:43:30",
      },
    ]);
    // 同一轮里发布并重建公共快照：日历已经有这个兑换码事件，且没有改期记录。
    const current = await rows<{ id: string }>(
      "SELECT id FROM public_snapshots WHERE state = 'current'",
    );
    expect(current).toHaveLength(1);
    expect(
      await rows(
        "SELECT n.milestone_id FROM public_snapshot_nodes n JOIN milestones m ON m.id = n.milestone_id WHERE n.snapshot_id = ? AND m.event_id = ?",
        current[0]?.id,
        event?.id,
      ),
    ).toHaveLength(1);
    expect(await rows("SELECT patch_kind FROM calendar_patches")).toEqual([]);
    expect((await redeemCodes()).codes.map((code) => [code.code, code.eventId])).toEqual([
      ["PHOENIX1021", event?.id],
    ]);
  });

  it("直播收尾后没有截止时间：只在北京时间整点核对；兑换码从官方列表消失即从条里收回，正文与日历不变", async () => {
    endedLive(false);
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    // is_end 只表示直播节目结束：兑换码仍有效，照常显示，直到官方列表里不再有它。
    expect(await shownCodes()).toEqual(["ZZZ33SYNTHA1", "ZZZ33SYNTHB2", "ZZZ33SYNTHC3"]);
    expect((await redeemCodes()).codes.every((code) => code.expiresAt === null)).toBe(true);
    // 下一次采集排在 21:00 整点，早于常规间隔（20:40 + 30 分钟）。
    expect(await sourceDue()).toBe(at("21:00:00"));

    now = at("21:00:00");
    requests = [];
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    expect(await sourceDue()).toBe(now + SOURCE_POLL * 1000);

    // 常规间隔到了：只请求首页，这场直播等下一个整点（0 点）。
    now += SOURCE_POLL * 1000;
    requests = [];
    await drain();
    expect(requests).toEqual([HOME]);

    const versions = await rows("SELECT id FROM article_versions");
    const [before] = await rows<{ summary: string; event_revision: number }>(
      "SELECT summary, event_revision FROM events",
    );
    codeList.splice(1, 1);
    now = beijing("2026-10-10T00:00:00");
    requests = [];
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    expect(await shownCodes()).toEqual(["ZZZ33SYNTHA1", "ZZZ33SYNTHC3"]);
    expect(await rows("SELECT code, gone_at FROM redeem_codes WHERE gone_at IS NOT NULL")).toEqual([
      { code: "ZZZ33SYNTHB2", gone_at: now },
    ]);
    expect(await rows("SELECT id FROM article_versions")).toEqual(versions);
    expect(await rows("SELECT summary, event_revision FROM events")).toEqual([before]);
    expect(await sourceDue()).toBe(beijing("2026-10-10T00:30:00"));

    // 不再有 24 小时显示上限：发放 30 小时后官方仍列出的照常显示。
    now = at("19:45:00") + 30 * 3_600_000;
    expect(await shownCodes()).toEqual(["ZZZ33SYNTHA1", "ZZZ33SYNTHC3"]);
  });

  it("直播收尾后有截止时间（官方说明认出）：不再请求这场直播，到截止时间从条里收回", async () => {
    endedLive(true);
    await runtime().watchdog();
    await drain();
    expect(requests).toEqual([HOME, INDEX, CODES]);
    expect(await sourceDue()).toBe(now + SOURCE_POLL * 1000);
    now += SOURCE_POLL * 1000;
    requests = [];
    await drain();
    expect(requests).toEqual([HOME]);
    now = beijing("2026-10-10T11:59:59");
    expect(await shownCodes()).toHaveLength(3);
    now = beijing("2026-10-10T12:00:00");
    expect(await shownCodes()).toEqual([]);
  });

  it("管理员登记截止时间：条立即按它显示；采集不再请求官方，把它写进正文，日历出现兑换码过期；改动即改期", async () => {
    endedLive(false);
    await runtime().watchdog();
    await drain();
    expect(await rows("SELECT milestone_key FROM milestones")).toEqual([
      { milestone_key: "codes_release" },
    ]);

    const first = beijing("2026-10-11T23:59:59");
    await register("2026/10/11 23:59:59", first);
    expect((await redeemCodes()).codes.map((code) => [code.expiresAt, code.expiryText])).toEqual(
      Array(3).fill([first, "2026/10/11 23:59:59"]),
    );
    requests = [];
    await drain();
    expect(requests).toEqual([HOME]);
    expect(
      await rows(
        "SELECT time_exact_ms, raw_expression, time_basis FROM milestones WHERE milestone_key = 'codes_expiry'",
      ),
    ).toEqual([
      {
        time_exact_ms: first,
        raw_expression: "2026/10/11 23:59:59",
        time_basis: "official_explicit",
      },
    ]);
    const [before] = await rows<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM events",
    );

    now += 60_000;
    const second = beijing("2026-10-12T12:00:00");
    await register("2026/10/12 12:00", second);
    requests = [];
    await drain();
    expect(requests).toEqual([HOME]);
    expect(
      await rows("SELECT time_exact_ms FROM milestones WHERE milestone_key = 'codes_expiry'"),
    ).toEqual([{ time_exact_ms: second }]);
    const [after] = await rows<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM events",
    );
    expect(after?.schedule_revision).toBeGreaterThan(before?.schedule_revision ?? 0);
    expect(
      await rows(
        "SELECT patch_kind, old_time_exact_ms, new_time_exact_ms FROM calendar_patches WHERE superseded_at IS NULL",
      ),
    ).toEqual([{ patch_kind: "rescheduled", old_time_exact_ms: first, new_time_exact_ms: second }]);
    // 截止时间一到，条里收回；有截止时间后不再核对官方状态。
    now = second;
    expect(await shownCodes()).toEqual([]);
  });

  it("官方已返回活动已结束的直播也能登记截止时间：不再请求官方，正文与日历照样更新，条里重新显示到截止时间", async () => {
    indexBody.data.template = JSON.stringify({ actTitle: "合成", codeVisible: true });
    await runtime().watchdog();
    await drain();
    now = at("20:30:00");
    closed = true;
    await drain();
    expect(await shownCodes()).toEqual([]);

    const expiry = beijing("2026-10-11T23:59:59");
    await register("2026/10/11 23:59:59", expiry);
    requests = [];
    await drain();
    expect(requests).toEqual([HOME]);
    expect(
      await rows("SELECT time_exact_ms FROM milestones WHERE milestone_key = 'codes_expiry'"),
    ).toEqual([{ time_exact_ms: expiry }]);
    expect(await shownCodes()).toEqual(["ZZZ33SYNTHA1", "ZZZ33SYNTHB2"]);
  });
});

describe("ADR-0034 第 7 条 一次性清理 2026-10-09 那条错误的改期", () => {
  const REAL_ACT = "ea202609241643161324";
  const EVENT = "e55afff692f1118b5bfa41a8af258c6b4757dfe2db30cbd8d930b24b0003b8bf";
  const MILESTONE = "3143c4fdf86d0451a684abed24106eb78934e8a0dc1bc4a5d984034918bfed88";
  const cleanupSql = String(
    runbooks["../../../../../docs/runbooks/redeem-reschedule-cleanup-2026-10-09.sql"],
  );
  const runCleanup = async () => {
    for (const sql of splitSqlStatements(cleanupSql)) await env.DB.prepare(sql).run();
  };
  type Detail = {
    event: { changes: unknown[]; milestones: { id: string; change?: unknown }[] };
  };
  const detail = async () =>
    (await (
      await readEventDetail(env.DB, new URL(`https://hoyo.test/api/v2/events/${EVENT}`), EVENT, now)
    ).json()) as Detail;
  const recentChanges = async () =>
    (
      (await (
        await readEvents(env.DB, new URL("https://hoyo.test/api/v2/events?range=7d&games=zzz"), now)
      ).json()) as { recentChanges: unknown[] }
    ).recentChanges;

  it("同一活动 ID 得到线上同一个事件与节点 ID", async () => {
    expect(await eventIdentity("zzz-live", REAL_ACT, "redeem_codes")).toBe(EVENT);
    expect(await milestoneIdentity(EVENT, "codes_release")).toBe(MILESTONE);
  });

  /** 用真实活动 ID 走一遍采集与发布：先按 from 发布开始节点，官方再把发放时刻改成 to，产生一次改期。 */
  async function reproduce(from: string, to: string) {
    homeLives = [
      {
        title: "前瞻特别节目",
        app_path: `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${REAL_ACT}`,
      },
    ];
    indexBody.data.template = JSON.stringify({ actTitle: "合成", codeVisible: true });
    now = at("19:50:00");
    codeList = [{ ...codeList[0], code: "PHOENIX1021", to_get_time: String(at(from) / 1000) }];
    await runtime().watchdog();
    await drain();
    now = at("19:56:00");
    codeList = [{ ...codeList[0], code: "PHOENIX1021", to_get_time: String(at(to) / 1000) }];
    await env.DB.prepare("UPDATE jobs SET due_at = ? WHERE id = 'pipeline:source:zzz-live'")
      .bind(now)
      .run();
    await drain();
  }

  it("复现线上的改期（19:49 → 19:43:30）；执行清理后重建快照，详情与近期变更不再有改期；再执行一次没有副作用", async () => {
    await reproduce("19:49:00", "19:43:30");
    expect(
      await rows(
        "SELECT milestone_id, patch_kind, old_time_exact_ms, new_time_exact_ms FROM calendar_patches",
      ),
    ).toEqual([
      {
        milestone_id: MILESTONE,
        patch_kind: "rescheduled",
        old_time_exact_ms: 1_791_546_540_000,
        new_time_exact_ms: 1_791_546_210_000,
      },
    ]);
    expect((await detail()).event.changes).toHaveLength(1);
    expect(await recentChanges()).toHaveLength(1);
    const [before] = await rows<{ time_exact_ms: number; schedule_revision: number }>(
      "SELECT m.time_exact_ms, e.schedule_revision FROM milestones m JOIN events e ON e.id = m.event_id",
    );

    now = at("20:40:00");
    await runCleanup();
    expect(await rows("SELECT id FROM calendar_patches")).toEqual([]);
    expect(
      await rows(
        "SELECT action, target_type, target_id, reason FROM audit_log WHERE action = 'calendar_patch_withdraw'",
      ),
    ).toEqual([
      {
        action: "calendar_patch_withdraw",
        target_type: "milestone",
        target_id: MILESTONE,
        reason: "evidence_reviewed",
      },
    ]);
    // 下一次 Cron 看门狗重建公共快照。
    await runtime().watchdog();
    const after = await detail();
    expect(after.event.changes).toEqual([]);
    expect(after.event.milestones.map((milestone) => milestone.change ?? null)).toEqual([null]);
    expect(await recentChanges()).toEqual([]);
    expect(
      await rows(
        "SELECT dispatch_state FROM outbox WHERE dedupe_key = 'manual:adr0034-redeem-reschedule-cleanup-2026-10-09'",
      ),
    ).toEqual([{ dispatch_state: "dispatched" }]);
    // 事件、节点时间与修订号都不动。
    expect(
      await rows(
        "SELECT m.time_exact_ms, e.schedule_revision FROM milestones m JOIN events e ON e.id = m.event_id",
      ),
    ).toEqual([before]);

    // 再执行一次：不多删、不重复记审计，也不会把"待重建"打开成没有请求的状态（否则重建器会报错）。
    await runCleanup();
    expect(
      (
        await rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar_patch_withdraw'",
        )
      )[0]?.n,
    ).toBe(1);
    expect(
      await rows("SELECT value_json FROM system_state WHERE key = 'public_snapshot_pending'"),
    ).toEqual([{ value_json: '{"pending":false}' }]);
    await runtime().watchdog();
    expect((await detail()).event.changes).toEqual([]);
  });

  it("对不上的更正（同一节点、别的时刻）一条也不删", async () => {
    await reproduce("19:50:00", "19:44:00");
    const patches = await rows("SELECT id, old_time_exact_ms FROM calendar_patches");
    expect(patches).toHaveLength(1);
    now = at("20:40:00");
    await runCleanup();
    expect(await rows("SELECT id, old_time_exact_ms FROM calendar_patches")).toEqual(patches);
    await runtime().watchdog();
    expect((await detail()).event.changes).toHaveLength(1);
  });
});
