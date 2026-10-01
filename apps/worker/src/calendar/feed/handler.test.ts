// A-P3-ICS：真实本地 D1、公开整代及 HTTP 外壳；无真实账户/发信/网络来源。
import { createExecutionContext, env } from "cloudflare:test";
import {
  CAL_PATCH_MIN_DAYS,
  decideCalendarPatch,
  FEED_BASE_NODE_MAX,
  FEED_FUTURE_DAYS,
  FEED_MAX_STALE,
  FEED_PAST_DAYS,
  FEED_PATCH_NODE_MAX,
  FEED_RESPONSE_MAX_BYTES,
  feedNaturalExitAt,
  type PublicSnapshotNode,
  personalCalendarNodes,
  type SubscriptionConfig,
  TimeValueSchema,
} from "@hoyo/contracts";
import ICAL from "ical.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiShell } from "../../shell/router";
import { generateSecretToken } from "../../storage/crypto/random";
import { splitSqlStatements } from "../../storage/split-sql";
import { makeFeedHandler } from "./handler";
import { FeedPublicCache } from "./public-read";
import { hashFeedToken } from "./store";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const day = 86_400_000,
  T = Date.parse("2026-09-30T12:00:00Z");
let at = T,
  token = "",
  hash = "";
let metrics: string[] = [];
let handler: ReturnType<typeof makeFeedHandler>;
const config: SubscriptionConfig = {
  schema_version: 3,
  revision: 1,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["limited_event"], node_types: ["start"], alarms_enabled: true },
  notifications: {
    rule_ids: ["limited_start_1h"],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  },
};
type StampedNode = PublicSnapshotNode & { public_changed_at: number };
function node(id: string, ms = T): StampedNode {
  return {
    game: "genshin",
    region: "CN",
    public_ical_revision: 1,
    public_changed_at: T,
    patch: null,
    tombstone: false,
    source_projection_json: null,
    projection: {
      event_id: "synthetic-event",
      milestone_id: id,
      event: {
        event_type: "limited_event",
        status: "scheduled",
        title: "中文😀合成活动",
        summary: "官方说明,分号;",
        official_url: "https://example.invalid/event",
        human_locked: false,
      },
      milestone: {
        milestone_key: id,
        node_type: "start",
        title: "开始",
        human_locked: false,
        time: TimeValueSchema.parse({
          precision: "datetime",
          utc_ms: ms,
          source_timezone: "UTC",
          raw_expression: "明确时间",
          time_basis: "official_explicit",
        }),
      },
    },
  };
}
function nodes(n = 10) {
  return Array.from({ length: n }, (_, i) => node(`synthetic-${i}`));
}
async function run(sql: string, ...args: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
async function one<T>(sql: string, ...args: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}
async function snapshot(values: readonly StampedNode[], generation = 1) {
  await run("UPDATE public_snapshots SET state='superseded' WHERE state='current'");
  const id = `synthetic-generation-${generation}`;
  await run(
    "INSERT INTO public_snapshots(id,generation,state,built_at,published_at,created_at,node_count) VALUES (?,?,'current',?,?,?,?)",
    id,
    generation,
    at,
    at,
    at,
    values.length,
  );
  // 用真实 FK 约束；分别提交绑定小的语句，测试加载不受被测 Feed 输出上限影响。
  for (const value of values) {
    await run(
      `INSERT INTO milestones(id,event_id,milestone_key,node_type,title,source_timezone,raw_expression,time_basis,time_precision,public_ical_revision,human_locked,created_at,updated_at)
      VALUES (?,'synthetic-event',?,'start','合成','UTC','明确','official_explicit','unknown',1,0,?,?) ON CONFLICT(id) DO NOTHING`,
      value.projection.milestone_id,
      value.projection.milestone_id,
      T,
      T,
    );
    await run(
      "INSERT INTO public_snapshot_nodes(snapshot_id,milestone_id,node_json) VALUES (?,?,?)",
      id,
      value.projection.milestone_id,
      JSON.stringify(value),
    );
  }
}
function expiryBaseline(): StampedNode[] {
  return nodes().map((n, i) => {
    if (i === 0)
      return { ...n, tombstone: true, patch: decideCalendarPatch(n.projection, null, null, T) };
    return node(n.projection.milestone_id, T + (i < 6 ? -FEED_PAST_DAYS : FEED_FUTURE_DAYS) * day);
  });
}
async function replaceAndReclaim(values: readonly StampedNode[]) {
  await snapshot(values, 2);
  await snapshot(values, 3);
  await run("DELETE FROM public_snapshot_nodes WHERE snapshot_id='synthetic-generation-1'");
  await run("DELETE FROM public_snapshots WHERE generation=1");
}
function request(method = "GET", etag?: string, db = env.DB) {
  const shell = createApiShell({
    authenticator: {
      async authenticate() {
        throw new Error("Feed 不应查 Cookie");
      },
    },
    feedHandler: handler,
  });
  const req = new Request(`https://example.invalid/feeds/u/${token}.ics`, {
    method,
    headers: etag ? { "if-none-match": etag } : {},
  });
  return shell.fetch(req, { ...env, DB: db }, createExecutionContext());
}
async function events(response: Response) {
  const component = new ICAL.Component(ICAL.parse(await response.text()));
  return component.getAllSubcomponents("vevent").map((event) => new ICAL.Event(event));
}
async function fresh() {
  await run("UPDATE sources SET last_success_at=?", at);
}
async function saveNodes(types: string[]) {
  await run(
    "UPDATE user_subscriptions SET calendar_json=?, revision=revision+1",
    JSON.stringify({ ...config.calendar, node_types: types, alarms_enabled: false }),
  );
  await run("UPDATE calendar_feeds SET view_revision=view_revision+1,changed_at=?", at);
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
}, 60_000);
beforeEach(async () => {
  at = T;
  metrics = [];
  token = generateSecretToken().base64url;
  hash = (await hashFeedToken(token)) ?? "";
  for (const table of [
    "public_snapshot_nodes",
    "public_snapshots",
    "milestones",
    "events",
    "calendar_feeds",
    "user_subscriptions",
    "users",
    "sources",
  ])
    await run(`DELETE FROM ${table}`);
  await run(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,recovery_epoch,created_at,updated_at) VALUES ('synthetic-user',1,'active','synthetic-key','synthetic-binding',X'00',1,0,?,?)`,
    T,
    T,
  );
  await run(
    `INSERT INTO user_subscriptions(user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES ('synthetic-user','initialized',3,1,?,?,?,?,?)`,
    JSON.stringify(config.scope),
    JSON.stringify(config.calendar),
    JSON.stringify(config.notifications),
    T,
    T,
  );
  await run(
    `INSERT INTO calendar_feeds(user_id,namespace,state,token_hash,token_ciphertext,token_generation,view_revision,recovery_epoch,changed_at,created_at,updated_at) VALUES ('synthetic-user','synthetic-namespace','enabled',?,X'00',1,0,0,?,?,?)`,
    hash,
    T,
    T,
    T,
  );
  await run(
    `INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,human_locked,created_at,updated_at) VALUES ('synthetic-event','genshin','CN','limited_event','scheduled','合成',1,1,0,?,?)`,
    T,
    T,
  );
  await run(
    `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,last_success_at,created_at,updated_at) VALUES ('genshin-ann','genshin','cn','synthetic','[]','[]','{}','{}','verified-working',?,?,?)`,
    T,
    T,
    T,
  );
  handler = makeFeedHandler({ now: () => at, metric: (name) => metrics.push(name) });
});
describe("A-P3-ICS Feed HTTP 读路径与完整快照", () => {
  it("无需 Cookie；实际内容 ETag 稳定，HEAD/304 仍更新成功事实", async () => {
    await snapshot(nodes());
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const tag = response.headers.get("etag") ?? "";
    const list = await events(response);
    expect(list).toHaveLength(10);
    expect(new Set(list.map((x) => x.uid)).size).toBe(10);
    expect(list[0]?.sequence).toBe(1);
    expect(list[0]?.component.getFirstSubcomponent("valarm")?.getFirstPropertyValue("action")).toBe(
      "DISPLAY",
    );
    at++;
    expect((await request("HEAD")).headers.get("etag")).toBe(tag);
    expect(await (await request("HEAD")).text()).toBe("");
    const unchanged = await request("GET", `W/${tag}`);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(await one("SELECT last_served_at,last_served_node_count FROM calendar_feeds")).toEqual({
      last_served_at: at,
      last_served_node_count: 10,
    });
  });
  it("用户隐藏后完整快照空集合，重新加入同 UID、更高序列；换 token 不降序", async () => {
    await snapshot(nodes());
    const before = await events(await request());
    await saveNodes([]);
    expect(await events(await request())).toHaveLength(0);
    await saveNodes(["start"]);
    const rejoined = await events(await request());
    expect(rejoined.map((x) => x.uid)).toEqual(before.map((x) => x.uid));
    expect(rejoined[0]?.sequence).toBe(3);
    token = generateSecretToken().base64url;
    await run(
      "UPDATE calendar_feeds SET token_hash=?,token_generation=token_generation+1",
      await hashFeedToken(token),
    );
    expect((await events(await request())).map((x) => [x.uid, x.sequence])).toEqual(
      rejoined.map((x) => [x.uid, x.sequence]),
    );
  });
  it("自然退出和自然进入不改公共版本；窗口收缩有逐项证据", async () => {
    await snapshot(nodes());
    await request();
    at += day * (FEED_PAST_DAYS + 1);
    await fresh();
    expect(await events(await request())).toHaveLength(0);
    expect(metrics).not.toContain("feed_shrink_guard");
    await snapshot([node("future", at + day * (FEED_FUTURE_DAYS + 1))], 2);
    expect(await events(await request())).toHaveLength(0);
    at += day;
    await fresh();
    expect((await events(await request()))[0]?.sequence).toBe(1);
  });
  it("每日拉取其间两次无关重建并回收基线，10 中 6 条自然滑出，连续五天照常输出", async () => {
    const values = nodes().map((n, i) =>
      node(n.projection.milestone_id, i < 6 ? T - FEED_PAST_DAYS * day : T),
    );
    await snapshot(values);
    expect(await events(await request())).toHaveLength(10);
    for (let d = 1; d <= 5; d++) {
      at = T + d * day;
      await fresh();
      await snapshot(values, d * 2);
      await snapshot(values, d * 2 + 1);
      // 真实只保留 current 与上一代；不引用已回收基线。
      await run(
        "DELETE FROM public_snapshot_nodes WHERE snapshot_id IN (SELECT id FROM public_snapshots WHERE generation < ?)",
        d * 2,
      );
      await run("DELETE FROM public_snapshots WHERE generation < ?", d * 2);
      const response = await request();
      expect(response.status).toBe(200);
      expect(await events(response)).toHaveLength(4);
      expect(
        await one(
          "SELECT last_served_node_count,last_served_generation FROM calendar_feeds WHERE token_hash=?",
          hash,
        ),
      ).toEqual({ last_served_node_count: 4, last_served_generation: d * 2 + 1 });
    }
    expect(metrics).not.toContain("feed_shrink_guard");
  });
  it("基线已回收但当前代仍含更正时间证据，到期立即恢复窗口输出", async () => {
    const values = nodes().map((n, i) => {
      if (i >= 6) return node(n.projection.milestone_id, T + 2 * CAL_PATCH_MIN_DAYS * day);
      const next = node(
        n.projection.milestone_id,
        T + (FEED_FUTURE_DAYS + 2 * CAL_PATCH_MIN_DAYS) * day,
      );
      return { ...next, patch: decideCalendarPatch(n.projection, next.projection, null, T) };
    });
    await snapshot(values);
    expect(await events(await request())).toHaveLength(10);
    at++;
    await snapshot(values, 2);
    at++;
    await snapshot(values, 3);
    await run("DELETE FROM public_snapshot_nodes WHERE snapshot_id='synthetic-generation-1'");
    await run("DELETE FROM public_snapshots WHERE generation=1");
    at = (values[0]?.patch?.retain_until ?? 0) + 1;
    await fresh();
    const response = await request();
    expect(response.status).toBe(200);
    expect(await events(response)).toHaveLength(4);
    expect(metrics).not.toContain("feed_shrink_guard");
  });
  it("基线回收后当前代按旧时刻仍不足原条数，不以新增节点补齐缺失证据", async () => {
    await snapshot(nodes());
    expect((await request()).status).toBe(200);
    at += day;
    await fresh();
    const remaining = nodes().slice(0, 4);
    const additions = nodes(6).map((n) => ({
      ...node(`new-${n.projection.milestone_id}`, T - FEED_PAST_DAYS * day),
      public_changed_at: at,
    }));
    await snapshot([...remaining, ...additions], 2);
    await snapshot([...remaining, ...additions], 3);
    await run("DELETE FROM public_snapshot_nodes WHERE snapshot_id='synthetic-generation-1'");
    await run("DELETE FROM public_snapshots WHERE generation=1");
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ calendar: { reason: "shrink_guard" } });
  });
  it("展示时间早于事实时间：更正到期重新进入，兜底上界覆盖事实时间退出", async () => {
    const factAt = T + (FEED_FUTURE_DAYS + CAL_PATCH_MIN_DAYS) * day;
    const values = nodes().map((old) => {
      const fact = node(old.projection.milestone_id, factAt);
      const next = {
        ...fact,
        projection: {
          ...fact.projection,
          event: { ...fact.projection.event, status: "cancelled" as const },
        },
      };
      return {
        ...next,
        public_ical_revision: 2,
        patch: decideCalendarPatch(old.projection, next.projection, null, T),
      };
    });
    const exit = (Math.floor(factAt / day) + FEED_PAST_DAYS + 1) * day;
    await snapshot(values);
    const initial = await events(await request());
    expect(initial).toHaveLength(values.length);
    expect(initial.every((event) => event.startDate.toJSDate().getTime() === T)).toBe(true);
    expect(await one("SELECT last_served_natural_exit_at FROM calendar_feeds")).toEqual({
      last_served_natural_exit_at: exit,
    });
    at = values[0]?.patch?.retain_until ?? 0;
    expect(at).toBeLessThan(exit);
    await fresh();
    const reentered = await events(await request());
    expect(reentered).toHaveLength(values.length);
    expect(reentered.every((event) => event.startDate.toJSDate().getTime() === factAt)).toBe(true);
    expect(reentered.map((event) => [event.uid, event.sequence])).toEqual(
      initial.map((event) => [event.uid, event.sequence]),
    );
    await replaceAndReclaim([]);
    for (const instant of [at, exit - 1]) {
      at = instant;
      await fresh();
      expect((await request()).status).toBe(503);
      expect(await one("SELECT last_served_natural_exit_at FROM calendar_feeds")).toEqual({
        last_served_natural_exit_at: exit,
      });
    }
    at = exit;
    await fresh();
    expect(await events(await request())).toHaveLength(0);
  });
  it("基线已回收、到期墓碑与自然滑出证据已清掉，差额超比例时等到自然退出上界", async () => {
    const values = expiryBaseline();
    const exit = feedNaturalExitAt(personalCalendarNodes(config, values, T), T);
    await snapshot(values);
    expect(await events(await request())).toHaveLength(10);
    expect(await one("SELECT last_served_natural_exit_at FROM calendar_feeds")).toEqual({
      last_served_natural_exit_at: exit,
    });
    at = (values[0]?.patch?.retain_until ?? 0) + 1;
    await fresh();
    // 模拟 P3-13 裁剪：墓碑、5 条自然滑出的历史证据均已删除；k=6/10。
    await replaceAndReclaim(values.slice(6));
    for (const instant of [at, exit - 1]) {
      at = instant;
      await fresh();
      expect((await request()).status).toBe(503);
      expect(
        await one(
          "SELECT last_served_natural_exit_at,last_served_at,last_served_node_count FROM calendar_feeds",
        ),
      ).toEqual({
        last_served_natural_exit_at: exit,
        last_served_at: T,
        last_served_node_count: 10,
      });
    }
    at = exit;
    await fresh();
    // 旧行缺值不能猜测回填；同一份当前代次仍拒绝。
    await run("UPDATE calendar_feeds SET last_served_natural_exit_at=NULL");
    expect((await request()).status).toBe(503);
    await run("UPDATE calendar_feeds SET last_served_natural_exit_at=?", exit);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await events(response)).toHaveLength(0);
    expect(await one("SELECT last_served_node_count,last_served_at FROM calendar_feeds")).toEqual({
      last_served_node_count: 0,
      last_served_at: exit,
    });
  });
  it.each(["reschedule", "classification"])(
    "基线回收且墓碑清理后再有一条 %s，差额 2/10 不阻塞有证据的窗口收缩",
    async (change) => {
      const values = expiryBaseline();
      await snapshot(values);
      expect((await request()).status).toBe(200);
      const oldExit =
        (
          await one<{ last_served_natural_exit_at: number }>(
            "SELECT last_served_natural_exit_at FROM calendar_feeds",
          )
        )?.last_served_natural_exit_at ?? 0;
      at = (values[0]?.patch?.retain_until ?? 0) + 1;
      await fresh();
      const remaining = values.slice(1).map((n, i) => {
        if (i !== 5) return n;
        const next =
          change === "reschedule"
            ? node(n.projection.milestone_id, T + (FEED_FUTURE_DAYS + 1) * day)
            : {
                ...n,
                projection: {
                  ...n.projection,
                  event: { ...n.projection.event, event_type: "gacha" as const },
                },
              };
        return {
          ...next,
          public_ical_revision: 2,
          public_changed_at: at,
          patch: decideCalendarPatch(n.projection, next.projection, n.patch, at),
        };
      });
      // 仍存在的 5 条历史节点解释自然滑出；无法重算的只有墓碑和事后修订，共 2 条。
      await replaceAndReclaim(remaining);
      expect(at).toBeLessThan(oldExit);
      const response = await request();
      expect(response.status).toBe(200);
      expect(await events(response)).toHaveLength(change === "reschedule" ? 4 : 3);
      expect(metrics).not.toContain("feed_shrink_guard");
    },
  );
  it("无解释 10→0 返回 503、告警及诊断，不覆盖成功基线", async () => {
    await snapshot(nodes());
    await request();
    at++;
    await snapshot([], 2);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ calendar: { reason: "shrink_guard" } });
    expect(metrics).toContain("feed_shrink_guard");
    expect(
      await one(
        "SELECT last_served_node_count,last_served_at,last_guard_blocked_at,last_output_diagnostic FROM calendar_feeds",
      ),
    ).toEqual({
      last_served_node_count: 10,
      last_served_at: T,
      last_guard_blocked_at: at,
      last_output_diagnostic: "shrink_guard",
    });
  });
  it("无关的官方取消不解释其余缺失；真实全体取消仍完整输出", async () => {
    const old = nodes();
    await snapshot(old);
    await request();
    const cancelled = old.map((value) => {
      const projection = {
        ...value.projection,
        event: { ...value.projection.event, status: "cancelled" as const },
      };
      return {
        ...value,
        projection,
        public_ical_revision: 2,
        public_changed_at: at,
        patch: decideCalendarPatch(value.projection, projection, null, at),
      };
    });
    await snapshot(cancelled.slice(0, 5), 2);
    expect((await request()).status).toBe(503);
    await snapshot(cancelled, 3);
    const response = await request();
    expect(response.status).toBe(200);
    expect(
      (await events(response)).every(
        (x) => x.component.getFirstPropertyValue("status") === "CANCELLED",
      ),
    ).toBe(true);
  });
  it("小日历不误报；只有已核验来源才能返回真正空日历", async () => {
    await snapshot(nodes(4));
    await request();
    await snapshot([], 2);
    expect(await events(await request())).toHaveLength(0);
    await run("DELETE FROM sources");
    expect((await request()).status).toBe(503);
  });
  it("热公共缓存不续来源水位；边界可用，超时后 HEAD/304 都拒绝", async () => {
    await snapshot(nodes());
    const tag = (await request()).headers.get("etag") ?? "";
    at += FEED_MAX_STALE * 1000;
    expect((await request("GET", tag)).status).toBe(304);
    at++;
    for (const method of ["GET", "HEAD"]) expect((await request(method, tag)).status).toBe(503);
    await fresh();
    expect((await request()).status).toBe(200);
  });
  it.each([
    "UPDATE calendar_feeds SET state='disabled'",
    "UPDATE calendar_feeds SET token_hash='revoked',token_generation=2",
    "UPDATE users SET recovery_epoch=recovery_epoch+1",
    "UPDATE users SET status='deleting'",
  ])("热缓存/HEAD/304 仍核验撤销：%s", async (sql) => {
    await snapshot(nodes());
    const tag = (await request()).headers.get("etag") ?? "";
    await run(sql);
    for (const method of ["GET", "HEAD"]) expect((await request(method, tag)).status).toBe(404);
  });
  it("授权数据库不可用即 503，缓存不可绕过；普通 auth_epoch 变化不影响地址", async () => {
    await snapshot(nodes());
    await request();
    await run("UPDATE users SET auth_epoch=auth_epoch+1");
    expect((await request()).status).toBe(200);
    const unavailable = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return () => {
            throw new Error("synthetic database unavailable");
          };
        return Reflect.get(target, key);
      },
    });
    expect((await request("HEAD", undefined, unavailable)).status).toBe(503);
  });
  it("当前代次缺行或缺失拒绝输出，不用热缓存旧代兜底", async () => {
    await snapshot(nodes());
    await request();
    await snapshot(nodes(), 2);
    await run("DELETE FROM public_snapshot_nodes WHERE snapshot_id='synthetic-generation-2'");
    expect((await request()).status).toBe(503);
    expect(await one("SELECT last_served_generation FROM calendar_feeds")).toEqual({
      last_served_generation: 1,
    });
    await run("UPDATE public_snapshots SET state='superseded' WHERE state='current'");
    expect((await request()).status).toBe(503);
  });
  it.each(["GET", "HEAD"])(
    "%s 在组装后最终 CAS 前来源过期，不能返回 200/304 或更新成功基线",
    async (method) => {
      await snapshot(nodes());
      const tag = (await request()).headers.get("etag") ?? "";
      const before = await one("SELECT last_served_natural_exit_at FROM calendar_feeds");
      let clockReads = 0;
      handler = makeFeedHandler({
        now: () => {
          clockReads++;
          // 第一次为组装时刻；第二次已序列化且完成守卫，紧接着最终 CAS。
          if (clockReads === 2) at = T + FEED_MAX_STALE * 1000 + 1;
          return at;
        },
      });
      const response = await request(method, tag);
      expect(response.status).toBe(503);
      expect(clockReads).toBe(3);
      expect(await one("SELECT last_served_natural_exit_at FROM calendar_feeds")).toEqual(before);
      expect(
        await one(
          "SELECT last_served_at,last_output_diagnostic FROM calendar_feeds WHERE token_hash=?",
          hash,
        ),
      ).toEqual({ last_served_at: T, last_output_diagnostic: "source_stale" });
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.json()).toMatchObject({ calendar: { reason: "source_stale" } });
    },
  );
  it("组装期间配置变化有界重读，不返回旧选择", async () => {
    await snapshot(nodes());
    let changed = false;
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (sql.startsWith("UPDATE calendar_feeds SET"))
              return new Proxy(stmt, {
                get(s, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => {
                      const bound = s.bind(...args);
                      return new Proxy(bound, {
                        get(b, m) {
                          if (m === "run")
                            return async () => {
                              if (!changed) {
                                changed = true;
                                await saveNodes([]);
                              }
                              return b.run();
                            };
                          const v = Reflect.get(b, m);
                          return typeof v === "function" ? v.bind(b) : v;
                        },
                      });
                    };
                  const v = Reflect.get(s, k);
                  return typeof v === "function" ? v.bind(s) : v;
                },
              });
            return stmt;
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(await events(await request("GET", undefined, racing))).toHaveLength(0);
  });
  it("最终 CAS 前撤销或切代，HEAD/304 不放行旧响应；连续配置竞态只重试一次", async () => {
    await snapshot(nodes());
    const tag = (await request()).headers.get("etag") ?? "";
    let calls = 0;
    const intercept = (effect: () => Promise<void>): D1Database =>
      new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!sql.startsWith("UPDATE calendar_feeds SET")) return stmt;
              return new Proxy(stmt, {
                get(s, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => {
                      const bound = s.bind(...args);
                      return new Proxy(bound, {
                        get(b, m) {
                          if (m === "run")
                            return async () => {
                              calls++;
                              await effect();
                              return b.run();
                            };
                          const v = Reflect.get(b, m);
                          return typeof v === "function" ? v.bind(b) : v;
                        },
                      });
                    };
                  const v = Reflect.get(s, k);
                  return typeof v === "function" ? v.bind(s) : v;
                },
              });
            };
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    let response = await request(
      "HEAD",
      tag,
      intercept(async () => {
        await run("UPDATE calendar_feeds SET state='disabled'");
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    await run("UPDATE calendar_feeds SET state='enabled'");
    calls = 0;
    response = await request(
      "GET",
      tag,
      intercept(async () => {
        if (calls === 1)
          await snapshot(
            nodes().map((n) => ({ ...n, public_ical_revision: 2, public_changed_at: T + 1 })),
            2,
          );
      }),
    );
    expect(response.status).toBe(200);
    expect((await events(response))[0]?.sequence).toBe(2);
    expect(calls).toBe(2);
    calls = 0;
    response = await request(
      "HEAD",
      tag,
      intercept(async () => {
        await saveNodes(["start"]);
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(calls).toBe(2);
  });
  it("同令牌并发组装被限制且释放后可重试，不使用客户端 IP", async () => {
    await snapshot(nodes());
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cache = new FeedPublicCache();
    const original = cache.read.bind(cache);
    cache.read = async (...args) => {
      entered();
      await gate;
      return original(...args);
    };
    handler = makeFeedHandler({ now: () => at, cache });
    const pending = request();
    await started;
    try {
      expect((await request()).status).toBe(429);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
    expect((await request()).status).toBe(200);
  });
  it("基础节点超限、共享更正超限与字节超限各有诊断，不截断", async () => {
    await snapshot(nodes(FEED_BASE_NODE_MAX + 1));
    let response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ calendar: { reason: "base_node_limit" } });
    const patches = nodes(FEED_PATCH_NODE_MAX + 1).map((value) => {
      const next = node(value.projection.milestone_id, T + day * (FEED_FUTURE_DAYS + 20));
      return { ...next, patch: decideCalendarPatch(value.projection, next.projection, null, T) };
    });
    await snapshot(patches, 2);
    response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ calendar: { reason: "patch_node_limit" } });
    const large = nodes(FEED_BASE_NODE_MAX).map((value) => ({
      ...value,
      projection: {
        ...value.projection,
        event: {
          ...value.projection.event,
          summary: "字".repeat(Math.ceil(FEED_RESPONSE_MAX_BYTES / FEED_BASE_NODE_MAX)),
        },
      },
    }));
    await snapshot(large, 3);
    response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ calendar: { reason: "response_byte_limit" } });
  }, 60_000);
});
