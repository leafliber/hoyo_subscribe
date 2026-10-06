// A-P3-PIPELINE：真实本地 D1 + DO；所有来源为合成 fetch 响应，不访问官方或发邮件。
import { env, runInDurableObject } from "cloudflare:test";
import {
  EXECUTOR_BATCH_WALL_LIMIT,
  EXPIRED_AUTH_CLEANUP,
  NOTIFICATION_PUBLICATION_TOPIC,
  PUBLIC_SNAPSHOT_WRITE_PROFILE,
  SOURCE_POLL,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wrangler = Object.values(
  import.meta.glob("../../../wrangler.jsonc", { query: "?raw", import: "default", eager: true }),
)[0];

import {
  readNoncriticalPublicationPause,
  reclaimSupersededPublicSnapshotPage,
  writeNoncriticalPublicationPause,
} from "../../calendar/public/snapshot";
import { decideCandidate } from "../../extraction/service";
import { dispatchScheduled, pipelineWatchdog, WATCHDOG_CRON } from "../../scheduled";
import { cleanupTasks, runCleanup } from "../../scheduled/cleanup";
import { splitSqlStatements } from "../../storage/split-sql";
import { boundedDatabase } from "../cron/query-budget";
import type { PipelineControls } from "./controls";
import { PipelineRuntime, PUBLICATION_JOB, SOURCE_JOB } from "./runtime";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T0 = Date.parse("2026-09-29T00:00:00Z");
let now = T0;
let rows: { ann_id: number; title: string; content: string }[];
let controls: PipelineControls | null;
let requests: string[];
function item(id = 1, title = "合成活动", start = "2026/10/01 12:00") {
  return {
    ann_id: id,
    title: `「${title}」活动说明`,
    content: `<p>【活动时间】</p><p>${start}（服务器时间） ~ 2026/10/03 12:00（服务器时间）</p>`,
  };
}
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  requests.push(url.pathname);
  const data = {
    list: [
      {
        list: rows.map((row) =>
          url.pathname.endsWith("getAnnList")
            ? { ann_id: row.ann_id, title: row.title, has_content: true }
            : row,
        ),
      },
    ],
  };
  return Response.json({ retcode: 0, message: "OK", data });
}) as typeof fetch;
function runtime(extra: Partial<ConstructorParameters<typeof PipelineRuntime>[0]> = {}) {
  return new PipelineRuntime({
    db: env.DB,
    readControls: async () => controls,
    now: () => now,
    fetchFn: fakeFetch,
    ...extra,
  });
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
}
async function drain(rt = runtime()) {
  // 测试保护界，不是生产批次阈值；每轮新实例模拟 DO 休眠后重建。
  for (let i = 0; i < 30; i++) {
    const next = await rt.nextAlarm();
    if (next === null || next > now) return;
    await rt.tick();
  }
  throw new Error("test_drain_did_not_sleep");
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    for (const sql of splitSqlStatements(migrations[path])) await env.DB.prepare(sql).run();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ...tables.map((table) => env.DB.prepare(`DELETE FROM ${table.name}`)),
  ]);
  now = T0;
  rows = [item()];
  requests = [];
  controls = {
    sources: { "zzz-ann": { enabled: true, mode: "normal" } },
    automaticPublication: true,
    model: false,
    reviewSkip: false,
  };
});
describe("A-P3-PIPELINE 持久编排与定时接线", () => {
  it("全链：历史首次导入 backfill、规则发布/outbox/快照、重复唤醒不重复、新文章非回填", async () => {
    await runtime().watchdog();
    await runtime().tick(); // 仅持久抓取页
    expect(await count("article_versions")).toBe(0);
    expect(requests).toHaveLength(2);
    await drain();
    expect(await count("article_versions")).toBe(1);
    expect(await count("candidates")).toBe(1);
    expect(await count("events")).toBe(1);
    expect(await count("event_revisions")).toBe(1);
    expect(await count("public_snapshots")).toBe(1);
    const first = await env.DB.prepare(
      "SELECT payload_json,dispatch_state FROM outbox WHERE topic = ?",
    )
      .bind(NOTIFICATION_PUBLICATION_TOPIC)
      .first<{ payload_json: string; dispatch_state: string }>();
    expect(JSON.parse(first?.payload_json ?? "{}").backfill).toBe(true);
    expect(first?.dispatch_state).toBe("dispatched");
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM occurrences WHERE kind = 'new_event'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await Promise.all([runtime().tick(), runtime().tick()]);
    expect(await count("event_revisions")).toBe(1);
    now += SOURCE_POLL * 1000;
    rows.push(item(2, "新增活动"));
    await drain();
    expect(await count("events")).toBe(2);
    const signals = (
      await env.DB.prepare("SELECT payload_json FROM outbox WHERE topic = ? ORDER BY created_at")
        .bind(NOTIFICATION_PUBLICATION_TOPIC)
        .all<{ payload_json: string }>()
    ).results;
    expect(signals.map((signal) => JSON.parse(signal.payload_json).backfill)).toEqual([
      true,
      false,
    ]);
  });
  it("Cron 无新发布也调用 unchanged 构建并解除容量暂停", async () => {
    await writeNoncriticalPublicationPause(env.DB, true, "calendar_patch_capacity", now);
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(true);
    await runtime().watchdog();
    expect(await readNoncriticalPublicationPause(env.DB)).toBe(false);
  });
  it("新事件/普通内容暂停，更改时刻仍发布；跳过原因持久保存", async () => {
    await runtime().watchdog();
    await drain();
    await writeNoncriticalPublicationPause(env.DB, true, "manual_test_pause", now);
    now += SOURCE_POLL * 1000;
    rows = [item(1, "改标题")];
    await drain();
    expect(await count("event_revisions")).toBe(1);
    expect(
      await env.DB.prepare("SELECT last_error FROM jobs WHERE kind = ? AND status = 'pending'")
        .bind(PUBLICATION_JOB)
        .first(),
    ).toEqual({ last_error: "noncritical_publication_paused" });
    now += SOURCE_POLL * 1000;
    rows = [item(1, "改标题", "2026/10/02 12:00")];
    await drain();
    expect(await count("event_revisions")).toBe(2);
    now += SOURCE_POLL * 1000;
    rows.push(item(2, "新事件"));
    await drain();
    expect(await count("events")).toBe(1);
  });
  it("D1 上限错误只调用一次，持久 failed 且告警，不随同批/后续 alarm 重试", async () => {
    const publish = vi.fn(async () => {
      throw new Error("D1_ERROR: too many SQL variables");
    });
    const log = vi.spyOn(console, "log");
    const rt = runtime({ publish });
    await rt.watchdog();
    await drain(rt);
    await rt.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT status,last_error FROM jobs WHERE kind = ?")
        .bind(PUBLICATION_JOB)
        .first(),
    ).toEqual({ status: "failed", last_error: "sql_binding_limit" });
    expect(log.mock.calls.flat().some((line) => String(line).includes("pipeline_job_failed"))).toBe(
      true,
    );
    log.mockRestore();
  });
  it("缺失 alarm/过期租约由 Cron 修复，lease_version 递增且其他执行器不被动到", async () => {
    await runtime().watchdog();
    await env.DB.prepare(
      "UPDATE jobs SET status = 'leased',lease_version = 7,lease_expires_at = ? WHERE kind = ?",
    )
      .bind(now - 1, SOURCE_JOB)
      .run();
    await env.DB.prepare(
      "INSERT INTO jobs (id,kind,payload_json,due_at,status,lease_version,lease_expires_at,created_at,updated_at) VALUES ('mail-test','other','{}',?,'leased',7,?,?,?)",
    )
      .bind(now, now - 1, now, now)
      .run();
    await runtime().watchdog();
    expect(
      await env.DB.prepare("SELECT status,lease_version FROM jobs WHERE kind = ?")
        .bind(SOURCE_JOB)
        .first(),
    ).toEqual({ status: "pending", lease_version: 8 });
    expect(
      await env.DB.prepare("SELECT status,lease_version FROM jobs WHERE id = 'mail-test'").first(),
    ).toEqual({ status: "leased", lease_version: 7 });
    // 真实 DO fetch watchdog，null 控制接口不新增来源；仍能恢复已有 D1 待办 alarm。
    await env.DB.prepare("UPDATE jobs SET due_at = ? WHERE kind = ?")
      .bind(Date.now() + WATCHDOG_INTERVAL * 1000, SOURCE_JOB)
      .run();
    await pipelineWatchdog(env);
    const stub = env.PIPELINE_DO.get(env.PIPELINE_DO.idFromName("main"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
    });
  });
  it("待人工裁定的发布待办停放，不随周期重抽；裁定后由 watchdog 放回并收尾", async () => {
    rows = [{ ann_id: 1, title: "「合成公告」说明", content: "<p>无模板</p>" }];
    await runtime().watchdog();
    await drain();
    const job = () =>
      env.DB.prepare("SELECT status,attempts,last_error FROM jobs WHERE kind = ?")
        .bind(PUBLICATION_JOB)
        .first<{ status: string; attempts: number; last_error: string | null }>();
    expect(await job()).toEqual({
      status: "awaiting_review",
      attempts: 1,
      last_error: "awaiting_review",
    });
    const candidate = await env.DB.prepare("SELECT id,review_status FROM candidates").first<{
      id: string;
      review_status: string;
    }>();
    expect(candidate?.review_status).toBe("pending");
    for (let round = 0; round < 3; round++) {
      now += WATCHDOG_INTERVAL * 1000;
      await runtime().watchdog();
      await drain();
    }
    expect((await job())?.attempts).toBe(1);
    now += WATCHDOG_INTERVAL * 1000;
    await decideCandidate(env.DB, candidate?.id ?? "", "rejected", "synthetic", "合成驳回", now);
    await runtime().watchdog();
    await drain();
    expect(await job()).toEqual({
      status: "done",
      attempts: 2,
      last_error: "candidate_rejected",
    });
  });
  it("过期租约不让 alarm 空转：只为可消费的待办排 alarm，Cron 修复后照常续跑", async () => {
    await runtime().watchdog();
    await drain();
    // 模拟部署重启：工作单元中途被打断，租约留在 leased 并已过期。
    await env.DB.prepare(
      "UPDATE jobs SET status = 'leased',lease_version = 7,lease_expires_at = ?,due_at = ? WHERE kind = ?",
    )
      .bind(now - 1, now - 1, SOURCE_JOB)
      .run();
    const next = await runtime().nextAlarm();
    expect(next === null || next > now).toBe(true);
    await drain();
    requests = [];
    await runtime().watchdog();
    expect(
      await env.DB.prepare("SELECT status,lease_version FROM jobs WHERE kind = ?")
        .bind(SOURCE_JOB)
        .first(),
    ).toEqual({ status: "pending", lease_version: 8 });
    expect(await runtime().nextAlarm()).toBe(now);
    await drain();
    expect(requests.length).toBeGreaterThan(0);
  });
  it("访问控制永久标维护不绕过；其他来源与清理继续执行", async () => {
    controls = {
      sources: {
        "genshin-ann": { enabled: true, mode: "hot" },
        "zzz-ann": { enabled: true, mode: "normal" },
      },
      automaticPublication: true,
      model: false,
      reviewSkip: false,
    };
    let restricted = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("hk4e")) {
        restricted++;
        return new Response("forbidden", { status: 403 });
      }
      return fakeFetch(input, init);
    }) as typeof fetch;
    const rt = runtime({ fetchFn });
    await rt.watchdog();
    await drain(rt);
    await rt.watchdog();
    await drain(rt);
    expect(restricted).toBe(1);
    expect(await count("events")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT verification_state FROM sources WHERE source_id = 'genshin-ann'",
      ).first(),
    ).toEqual({ verification_state: "maintenance-required" });
  });
  it("墙钟耗尽不进入发布；单批只落一篇，恢复后续页不丢内容", async () => {
    rows = [item(), item(2, "第二篇")];
    await runtime().watchdog();
    await runtime().tick();
    await runtime().tick();
    expect(await count("article_versions")).toBe(1);
    let reads = 0;
    const rt = runtime({ now: () => now + (++reads > 1 ? EXECUTOR_BATCH_WALL_LIMIT * 1000 : 0) });
    await rt.tick();
    expect(await count("events")).toBe(0);
    now += WATCHDOG_INTERVAL * 1000 + EXECUTOR_BATCH_WALL_LIMIT * 1000;
    await drain();
    expect(await count("events")).toBe(2);
  });
  it("未配置开关不自定值、不联网；Cron 周期与 EXPIRED_AUTH_CLEANUP 约束一致", async () => {
    controls = null;
    await runtime().watchdog();
    await runtime().tick();
    expect(requests).toEqual([]);
    expect(await count("jobs")).toBe(0);
    expect(wrangler).toContain(`"${WATCHDOG_CRON}"`);
    expect(WATCHDOG_INTERVAL).toBeLessThanOrEqual(EXPIRED_AUTH_CLEANUP);
  });
  it("残留 building 只回收小于 current；保留 current、上一代和未来 building", async () => {
    for (const [generation, state] of [
      [1, "building"],
      [2, "superseded"],
      [3, "current"],
      [4, "building"],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO public_snapshots (id,generation,state,created_at) VALUES (?,?,?,?)",
      )
        .bind(`snap-${generation}`, generation, state, now)
        .run();
    expect(await reclaimSupersededPublicSnapshotPage(env.DB, 1)).toMatchObject({
      snapshot_id: "snap-1",
      snapshot_deleted: true,
    });
    expect(await reclaimSupersededPublicSnapshotPage(env.DB, 1)).toMatchObject({ outcome: "done" });
    expect(await count("public_snapshots")).toBe(3);
  });
  it("清理导出逐项接线，单项失败不挡其他任务，删除账号使用分页入口", async () => {
    const calls: string[] = [];
    const spies = Object.keys(cleanupTasks).map((name) =>
      vi.spyOn(cleanupTasks, name as keyof typeof cleanupTasks).mockImplementation(async () => {
        calls.push(name);
        if (name === "challenges") throw new Error("synthetic_cleanup_failure");
        return undefined as never;
      }),
    );
    await runCleanup(env.DB, now, now + EXECUTOR_BATCH_WALL_LIMIT * 1000, () => now);
    expect(calls).toEqual([
      "registrations",
      "challenges",
      "authMaterials",
      "pendingSessions",
      "deletedAccounts",
      "adminAudit",
    ]);
    for (const spy of spies) spy.mockRestore();
    const tasks = [
      vi.fn(async () => {
        throw new Error("synthetic_watchdog_failure");
      }),
      vi.fn(async () => {}),
    ];
    await dispatchScheduled(env, tasks);
    expect(tasks[1]).toHaveBeenCalledOnce();
  });
  it("真实并发抢同一来源只有一轮网络请求，重放不重复文章与候选", async () => {
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      started();
      await gate;
      return fakeFetch(input, init);
    }) as typeof fetch;
    const rt = runtime({ fetchFn });
    await rt.watchdog();
    const first = rt.tick();
    await entered;
    await rt.tick();
    unblock();
    await first;
    expect(requests).toHaveLength(2);
    await drain();
    expect(await count("article_versions")).toBe(1);
    expect(await count("candidates")).toBe(1);
  });
  it("新增来源仍标历史回填，截断保留真实正文并留下缺口信号", async () => {
    await runtime().watchdog();
    await drain();
    controls = {
      sources: {
        "zzz-ann": { enabled: true, mode: "normal" },
        "hsr-ann": { enabled: true, mode: "normal" },
      },
      automaticPublication: true,
      model: false,
      reviewSkip: false,
    };
    await runtime().watchdog();
    await drain();
    const pending = (
      await env.DB.prepare("SELECT payload_json FROM jobs WHERE kind = ?")
        .bind(PUBLICATION_JOB)
        .all<{ payload_json: string }>()
    ).results;
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => JSON.parse(row.payload_json).backfill === true)).toBe(true);
    now += SOURCE_POLL * 1000;
    const { SOURCE_LIMIT_PROFILE } = await import("@hoyo/contracts");
    const truncated = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("getAnnContent")
        ? new Response("x".repeat(SOURCE_LIMIT_PROFILE.responseCapCeilingBytes + 1), {
            headers: { "content-type": "application/json" },
          })
        : fakeFetch(input, init)) as typeof fetch;
    await drain(runtime({ fetchFn: truncated }));
    expect(await count("article_versions")).toBe(2);
    expect(await count("events")).toBe(1);
  });
  it("真实清理：预占释放、挑战与回执密文清空、pending 撤销、账号分页清完才释放容量", async () => {
    const { reserveRegistrationSlot, ACCOUNTS_TOTAL_CAPACITY_KEY } = await import(
      "../../accounts/admission/registration"
    );
    await reserveRegistrationSlot(env.DB, {
      reservationId: "expired-reservation",
      emailKey: "synthetic-reservation",
      now: now - 2,
      challengeDeadline: now - 1,
      attempt: true,
    });
    await env.DB.prepare(
      `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at) VALUES ('cleanup-user',1,'active','synthetic-user','synthetic-binding',X'01',1,?,?)`,
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at) VALUES ('cleanup-session','cleanup-user','synthetic-hash','pending','synthetic','unknown',?,?,?,?,0,0,?,?)`,
    )
      .bind(now - 2, now + 1, now - 1, now - 2, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO auth_challenges (id,purpose,email_key,address_version,preauth_id,mac,deadline,receipt_ciphertext,receipt_expires_at,delivery_address_ciphertext,pending_session_id,created_at,updated_at) VALUES ('cleanup-challenge','login','synthetic-user',1,'synthetic-preauth','synthetic-mac',?,X'01',?,X'01','cleanup-session',?,?)`,
    )
      .bind(now - 1, now - 1, now - 2, now - 2)
      .run();
    const { OUTBOX_UNRESERVED_PERIOD_KEY } = await import("@hoyo/contracts");
    await env.DB.prepare(
      `INSERT INTO mail_outbox (id,idempotency_key,purpose,priority,address_version,payload_kind,status,payload_ref,payload_ciphertext,period_key,created_at,updated_at) VALUES ('cleanup-outbox','synthetic-idempotency','existing_auth',0,1,'auth_otp','pending','cleanup-challenge',X'01',?,?,?)`,
    )
      .bind(OUTBOX_UNRESERVED_PERIOD_KEY, now, now)
      .run();
    await reserveRegistrationSlot(env.DB, {
      reservationId: "future-reservation",
      emailKey: "synthetic-future",
      now,
      challengeDeadline: now + EXPIRED_AUTH_CLEANUP * 1000,
      attempt: true,
    });
    await env.DB.prepare(
      `INSERT INTO auth_challenges (id,purpose,email_key,address_version,preauth_id,mac,deadline,receipt_ciphertext,receipt_expires_at,delivery_address_ciphertext,created_at,updated_at) VALUES ('future-challenge','login','synthetic-future',1,'future-preauth','synthetic-mac',?,X'01',?,X'01',?,?)`,
    )
      .bind(now + EXPIRED_AUTH_CLEANUP * 1000, now + EXPIRED_AUTH_CLEANUP * 1000, now, now)
      .run();
    await runtime().watchdog();
    expect(
      await env.DB.prepare(
        "SELECT state FROM admission_reservations WHERE id = 'expired-reservation'",
      ).first(),
    ).toEqual({ state: "released" });
    expect(
      await env.DB.prepare(
        "SELECT receipt_ciphertext,delivery_address_ciphertext FROM auth_challenges WHERE id = 'cleanup-challenge'",
      ).first(),
    ).toEqual({ receipt_ciphertext: null, delivery_address_ciphertext: null });
    expect(
      await env.DB.prepare(
        "SELECT payload_ciphertext FROM mail_outbox WHERE id = 'cleanup-outbox'",
      ).first(),
    ).toEqual({ payload_ciphertext: null });
    expect(
      await env.DB.prepare("SELECT state FROM sessions WHERE id = 'cleanup-session'").first(),
    ).toEqual({ state: "revoked" });
    expect(
      await env.DB.prepare(
        "SELECT state FROM admission_reservations WHERE id = 'future-reservation'",
      ).first(),
    ).toEqual({ state: "reserved" });
    expect(
      await env.DB.prepare(
        "SELECT receipt_ciphertext IS NOT NULL AS receipt, delivery_address_ciphertext IS NOT NULL AS address FROM auth_challenges WHERE id = 'future-challenge'",
      ).first(),
    ).toEqual({ receipt: 1, address: 1 });
    const { ACCOUNT_DELETING_STATUS } = await import("@hoyo/contracts");
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = 'cleanup-user'")
      .bind(ACCOUNT_DELETING_STATUS)
      .run();
    await env.DB.prepare("UPDATE capacity_state SET value = 1 WHERE key = ?")
      .bind(ACCOUNTS_TOTAL_CAPACITY_KEY)
      .run();
    await runtime().watchdog();
    expect(
      await env.DB.prepare(
        "SELECT deletion_completed_at FROM users WHERE id = 'cleanup-user'",
      ).first(),
    ).toEqual({ deletion_completed_at: null });
    for (let i = 0; i < 3; i++) {
      now += WATCHDOG_INTERVAL * 1000;
      await runtime().watchdog();
    }
    expect(
      (
        await env.DB.prepare(
          "SELECT deletion_completed_at FROM users WHERE id = 'cleanup-user'",
        ).first<{ deletion_completed_at: number | null }>()
      )?.deletion_completed_at,
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT value FROM capacity_state WHERE key = ?")
        .bind(ACCOUNTS_TOTAL_CAPACITY_KEY)
        .first(),
    ).toEqual({ value: 0 });
  });
  it("D1 实测计量样本：单来源两节点发布、无变更轮询、空闲 Cron", async () => {
    let measured = { reads: 0, writes: 0, queries: 0 };
    const tally = (result: D1Result) => {
      measured.reads += result.meta.rows_read;
      measured.writes += result.meta.rows_written;
      measured.queries++;
    };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind") return (...params: unknown[]) => wrap(target.bind(...params));
          if (key === "first")
            return async (column?: string) => {
              const result = await target.all<Record<string, unknown>>();
              tally(result);
              const row = result.results[0] ?? null;
              return column === undefined ? row : (row?.[column] ?? null);
            };
          if (key === "all" || key === "run")
            return async () => {
              const result = await target[key]();
              tally(result);
              return result;
            };
          return Reflect.get(target, key, target);
        },
      });
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const result of results) tally(result);
            return results;
          };
        return Reflect.get(target, key, target);
      },
    });
    const rt = runtime({ db });
    await rt.watchdog();
    await drain(rt);
    console.log("P3-11 D1 sample initial", JSON.stringify(measured));
    measured = { reads: 0, writes: 0, queries: 0 };
    now += SOURCE_POLL * 1000;
    await drain(rt);
    console.log("P3-11 D1 sample unchanged", JSON.stringify(measured));
    measured = { reads: 0, writes: 0, queries: 0 };
    await rt.watchdog();
    console.log("P3-11 D1 sample idle-cron", JSON.stringify(measured));
    expect(measured.queries).toBeGreaterThan(0);
  });
  it("残留 building 的节点分页删除后才删代次，current 节点完整保留", async () => {
    await runtime().watchdog();
    await drain();
    await env.DB.prepare(
      "INSERT INTO public_snapshots (id,generation,state,created_at) VALUES ('abandoned',0,'building',?)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO public_snapshot_nodes (snapshot_id,milestone_id,node_json) SELECT 'abandoned',milestone_id,node_json FROM public_snapshot_nodes",
    ).run();
    expect(await reclaimSupersededPublicSnapshotPage(env.DB, 1)).toMatchObject({
      snapshot_id: "abandoned",
      nodes_deleted: 1,
      snapshot_deleted: false,
    });
    expect(await reclaimSupersededPublicSnapshotPage(env.DB, 1)).toMatchObject({
      snapshot_id: "abandoned",
      nodes_deleted: 1,
      snapshot_deleted: true,
    });
    expect(await count("public_snapshot_nodes")).toBe(2);
  });
  it("通知 outbox 可独立唤醒、每次派发一项；坏项失败不形成即时 alarm 重试环", async () => {
    rows.push(item(2, "第二活动"));
    await runtime().watchdog();
    await drain();
    await env.DB.prepare("UPDATE jobs SET status = 'done'").run();
    await env.DB.prepare("UPDATE outbox SET dispatch_state = 'pending' WHERE topic = ?")
      .bind(NOTIFICATION_PUBLICATION_TOPIC)
      .run();
    expect(await runtime().nextAlarm()).toBe(now);
    await runtime().tick();
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM outbox WHERE topic = ? AND dispatch_state = 'pending'",
        )
          .bind(NOTIFICATION_PUBLICATION_TOPIC)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await runtime().tick();
    expect(await runtime().nextAlarm()).toBeNull();
    await env.DB.prepare(
      "INSERT INTO outbox (id,topic,dedupe_key,payload_json,dispatch_state,created_at) VALUES ('bad',?,'bad','{}','pending',?)",
    )
      .bind(NOTIFICATION_PUBLICATION_TOPIC, now)
      .run();
    await runtime().tick();
    expect(await runtime().nextAlarm()).toBeNull();
    expect(
      await env.DB.prepare("SELECT dispatch_state FROM outbox WHERE id = 'bad'").first(),
    ).toEqual({ dispatch_state: "failed" });
  });
  it("热点轮询间隔来自 pollIntervalSeconds；旧租约不能写回持久页", async () => {
    const { SOURCE_HOT_POLL } = await import("@hoyo/contracts");
    controls = {
      sources: { "zzz-ann": { enabled: true, mode: "hot" } },
      automaticPublication: true,
      model: false,
      reviewSkip: false,
    };
    rows = [];
    await runtime().watchdog();
    await drain();
    expect(await runtime().nextAlarm()).toBe(now + SOURCE_HOT_POLL * 1000);
    now += SOURCE_HOT_POLL * 1000;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await env.DB.prepare(
        "UPDATE jobs SET lease_version = lease_version + 1, lease_owner = 'new-owner' WHERE kind = ?",
      )
        .bind(SOURCE_JOB)
        .run();
      return fakeFetch(input, init);
    }) as typeof fetch;
    await runtime({ fetchFn }).tick();
    const job = await env.DB.prepare("SELECT payload_json,lease_owner FROM jobs WHERE kind = ?")
      .bind(SOURCE_JOB)
      .first<{ payload_json: string; lease_owner: string }>();
    expect(JSON.parse(job?.payload_json ?? "{}").page).toBeUndefined();
    expect(job?.lease_owner).toBe("new-owner");
  });
  it("容量暂停时混合候选不夹带新事件；状态和分类更正复用同一判断", async () => {
    await runtime().watchdog();
    await drain();
    const version = await env.DB.prepare("SELECT id FROM article_versions LIMIT 1").first<{
      id: string;
    }>();
    const { extractArticleVersion } = await import("./extract");
    const { isCriticalPublication } = await import("./critical");
    const { candidate } = await extractArticleVersion(env.DB, version?.id ?? "missing", now);
    const event = candidate.proposal.events[0];
    const corrected = { ...event, status: "postponed" as const };
    const changed = { ...candidate, proposal: { ...candidate.proposal, events: [corrected] } };
    expect(await isCriticalPublication(env.DB, changed)).toBe(true);
    expect(
      await isCriticalPublication(env.DB, {
        ...candidate,
        proposal: { ...candidate.proposal, events: [{ ...event, event_type: "gacha" }] },
      }),
    ).toBe(true);
    expect(
      await isCriticalPublication(env.DB, {
        ...changed,
        proposal: {
          ...changed.proposal,
          events: [corrected, { ...event, event_key: "another_event" }],
        },
      }),
    ).toBe(false);
  });
  it("返工 R1：Cron 在墙钟与回收查询预算内循环回收，六个千节点旧代两轮内回收完毕", async () => {
    await runtime().watchdog();
    await drain();
    const event = await env.DB.prepare("SELECT id FROM events LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO milestones (id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
      SELECT 'load-'||value,?,'load-'||value,'start','synthetic',?,'UTC','synthetic','official_explicit','datetime',?,? FROM json_each(?)`)
      .bind(event?.id, now, now, now, JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)))
      .run();
    await env.DB.prepare("UPDATE public_snapshots SET generation = 8").run();
    for (let generation = 1; generation <= 7; generation++) {
      await env.DB.prepare(
        "INSERT INTO public_snapshots (id,generation,state,created_at) VALUES (?,?,'superseded',?)",
      )
        .bind(`load-snapshot-${generation}`, generation, now)
        .run();
      await env.DB.prepare(
        "INSERT INTO public_snapshot_nodes (snapshot_id,milestone_id,node_json) SELECT ?,id,'{}' FROM milestones WHERE id LIKE 'load-%'",
      )
        .bind(`load-snapshot-${generation}`)
        .run();
    }
    let pages = 0,
      removed = 0;
    const started = performance.now();
    const reclaim: typeof reclaimSupersededPublicSnapshotPage = async (db, size) => {
      const result = await reclaimSupersededPublicSnapshotPage(db, size);
      pages++;
      removed += result.nodes_deleted;
      return result;
    };
    // 单次调用的总查询数受平台上限约束；回收用尽预算后推迟到下一周期，不越界报错。
    const counted = boundedDatabase(env.DB, Number.POSITIVE_INFINITY);
    await runtime({ reclaim, db: counted.db }).watchdog();
    expect(counted.used()).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit);
    expect(removed).toBeGreaterThan(0);
    expect(await count("public_snapshot_nodes")).toBeGreaterThan(1002);
    await runtime({ reclaim }).watchdog();
    expect(await count("public_snapshots")).toBe(2);
    expect(await count("public_snapshot_nodes")).toBe(1002);
    console.log(
      "P3-11 R1 reclaim local",
      JSON.stringify({ removed, pages, elapsedMs: performance.now() - started }),
    );
  });
  it("返工 R1：墙钟耗尽停止回收，下一 Cron 从剩余节点恢复", async () => {
    await runtime().watchdog();
    await drain();
    await env.DB.prepare(
      "INSERT INTO public_snapshots (id,generation,state,created_at) VALUES ('wall-old',0,'building',?)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO public_snapshot_nodes (snapshot_id,milestone_id,node_json) SELECT 'wall-old',milestone_id,node_json FROM public_snapshot_nodes",
    ).run();
    let pages = 0;
    const reclaim: typeof reclaimSupersededPublicSnapshotPage = async (db) => {
      pages++;
      const page = await reclaimSupersededPublicSnapshotPage(db, 1);
      now += EXECUTOR_BATCH_WALL_LIMIT * 1000;
      return page;
    };
    await runtime({ reclaim }).watchdog();
    expect(pages).toBe(1);
    expect(await count("public_snapshots")).toBe(2);
    await runtime().watchdog();
    expect(await count("public_snapshots")).toBe(1);
  });
  it("返工 R3：旧租约在来源页结束时不能写回 sources.cursor_json 或成功水位", async () => {
    await runtime().watchdog();
    await runtime().tick();
    const before = await env.DB.prepare(
      "SELECT cursor_json,last_success_at,updated_at FROM sources WHERE source_id = 'zzz-ann'",
    ).first();
    const payload = (
      await env.DB.prepare("SELECT payload_json FROM jobs WHERE kind = ?")
        .bind(SOURCE_JOB)
        .first<{ payload_json: string }>()
    )?.payload_json;
    let stolen = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            // 在保存当前页最后一篇后抢走租约，确保运行真正走到来源游标 UPDATE。
            await target
              .prepare(
                "UPDATE jobs SET lease_version = lease_version + 1,lease_owner = 'new-owner' WHERE kind = ?",
              )
              .bind(SOURCE_JOB)
              .run();
            stolen = true;
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    now++;
    await runtime({ db }).tick();
    expect(stolen).toBe(true);
    expect(await count("article_versions")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT cursor_json,last_success_at,updated_at FROM sources WHERE source_id = 'zzz-ann'",
      ).first(),
    ).toEqual(before);
    expect(
      (
        await env.DB.prepare("SELECT payload_json FROM jobs WHERE kind = ?")
          .bind(SOURCE_JOB)
          .first<{ payload_json: string }>()
      )?.payload_json,
    ).toBe(payload);
  });
  async function prepareFailureLane(
    lane: "source" | "publication" | "notification",
    fail: () => void,
  ) {
    await runtime().watchdog();
    await runtime().tick();
    if (lane !== "source") await runtime().tick();
    const deps: Partial<ConstructorParameters<typeof PipelineRuntime>[0]> = {};
    let kind = SOURCE_JOB;
    if (lane === "source") {
      deps.db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              fail();
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } else if (lane === "publication") {
      kind = PUBLICATION_JOB;
      const { publishApprovedCandidate } = await import("../../publishing/publish");
      deps.publish = async (...args) => {
        fail();
        return publishApprovedCandidate(...args);
      };
    } else {
      await drain();
      kind = "pipeline_notification";
      await env.DB.prepare("DELETE FROM jobs WHERE kind = ?").bind(kind).run();
      await env.DB.prepare("UPDATE outbox SET dispatch_state = 'pending' WHERE topic = ?")
        .bind(NOTIFICATION_PUBLICATION_TOPIC)
        .run();
      const { generatePublicationOccurrences } = await import("../../mail/occurrences/generate");
      deps.notify = async (...args) => {
        fail();
        return generatePublicationOccurrences(...args);
      };
    }
    const before =
      (
        await env.DB.prepare("SELECT attempts FROM jobs WHERE kind = ?")
          .bind(kind)
          .first<{ attempts: number }>()
      )?.attempts ?? 0;
    return { deps, kind, before };
  }
  it("返工 R2：通知已提交但确认中断，下一 watchdog 只修复任务状态", async () => {
    const { kind } = await prepareFailureLane("notification", () => undefined);
    const { generatePublicationOccurrences } = await import("../../mail/occurrences/generate");
    const notify = vi.fn(async (...args: Parameters<typeof generatePublicationOccurrences>) => {
      await generatePublicationOccurrences(...args);
      throw new Error("synthetic acknowledgement interrupted");
    });
    await runtime({ notify }).tick();
    expect(
      await env.DB.prepare("SELECT dispatch_state FROM outbox WHERE topic = ?")
        .bind(NOTIFICATION_PUBLICATION_TOPIC)
        .first(),
    ).toEqual({ dispatch_state: "dispatched" });
    expect(
      await env.DB.prepare("SELECT status FROM jobs WHERE kind = ?").bind(kind).first(),
    ).toEqual({ status: "pending" });
    expect(await runtime().nextAlarm()).toBe(now + WATCHDOG_INTERVAL * 1000);
    now += WATCHDOG_INTERVAL * 1000;
    await runtime().watchdog();
    await runtime({ notify }).tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT status FROM jobs WHERE kind = ?").bind(kind).first(),
    ).toEqual({ status: "done" });
  });
  for (const lane of ["source", "publication", "notification"] as const) {
    it(`返工 R2 malformed ${lane}：真实坏载荷进入 failed 而不是永久重试`, async () => {
      const { kind } = await prepareFailureLane(lane, () => undefined);
      if (lane === "notification")
        await env.DB.prepare("UPDATE outbox SET payload_json = '{}' WHERE topic = ?")
          .bind(NOTIFICATION_PUBLICATION_TOPIC)
          .run();
      else
        await env.DB.prepare("UPDATE jobs SET payload_json = '{}' WHERE kind = ?").bind(kind).run();
      await runtime().tick();
      expect(
        await env.DB.prepare("SELECT status,last_error FROM jobs WHERE kind = ?")
          .bind(kind)
          .first(),
      ).toEqual({ status: "failed", last_error: "invalid_data" });
    });

    it(`返工 R2 transient ${lane}：跨 watchdog 重试、同批不重试、逐次持久次数原因并告警`, async () => {
      let calls = 0;
      const { deps, kind, before } = await prepareFailureLane(lane, () => {
        calls++;
        if (calls <= 2) throw new Error("D1_ERROR: temporary overload synthetic");
      });
      const log = vi.spyOn(console, "log");
      for (let attempt = 1; attempt <= 2; attempt++) {
        await runtime(deps).tick();
        expect(calls).toBe(attempt);
        expect(
          await env.DB.prepare("SELECT status,attempts,last_error,due_at FROM jobs WHERE kind = ?")
            .bind(kind)
            .first(),
        ).toEqual({
          status: "pending",
          attempts: before + attempt,
          last_error: "transient_or_unknown",
          due_at: now + WATCHDOG_INTERVAL * 1000,
        });
        await runtime(deps).tick();
        expect(calls).toBe(attempt);
        now += WATCHDOG_INTERVAL * 1000 - 1;
        await runtime(deps).tick();
        expect(calls).toBe(attempt);
        now++;
        await runtime().watchdog();
      }
      await runtime(deps).tick();
      expect(calls).toBe(3);
      expect(
        (
          await env.DB.prepare("SELECT status FROM jobs WHERE kind = ?")
            .bind(kind)
            .first<{ status: string }>()
        )?.status,
      ).not.toBe("failed");
      const alerts = log.mock.calls
        .flat()
        .filter((line) => String(line).includes('"reason_code":"transient_or_unknown"'))
        .map((line) => JSON.parse(String(line)) as { count: number });
      expect(alerts.map((alert) => alert.count)).toEqual([before + 1, before + 2]);
      log.mockRestore();
      if (lane === "notification")
        expect(
          (
            await env.DB.prepare("SELECT dispatch_state FROM outbox WHERE topic = ?")
              .bind(NOTIFICATION_PUBLICATION_TOPIC)
              .first<{ dispatch_state: string }>()
          )?.dispatch_state,
        ).toBe("dispatched");
    });
    for (const [message, reason] of [
      ["D1_ERROR: too many SQL variables", "sql_binding_limit"],
      ["D1_ERROR: Exceeded maximum number of queries", "sql_statement_limit"],
      ["D1_TYPE_ERROR: invalid synthetic shape", "invalid_data"],
    ]) {
      it(`返工 R2 terminal ${lane} ${reason}：确定性错误保留 failed，不再自动重试`, async () => {
        const fail = vi.fn(() => {
          throw new Error(message);
        });
        const { deps, kind, before } = await prepareFailureLane(lane, fail);
        const log = vi.spyOn(console, "log");
        await runtime(deps).tick();
        now += WATCHDOG_INTERVAL * 1000;
        await runtime().watchdog();
        await runtime(deps).tick();
        expect(fail).toHaveBeenCalledTimes(1);
        expect(
          await env.DB.prepare("SELECT status,attempts,last_error FROM jobs WHERE kind = ?")
            .bind(kind)
            .first(),
        ).toEqual({ status: "failed", attempts: before + 1, last_error: reason });
        expect(
          log.mock.calls
            .flat()
            .some(
              (line) =>
                String(line).includes(`"reason_code":"${reason}"`) &&
                String(line).includes(`"count":${before + 1}`),
            ),
        ).toBe(true);
        log.mockRestore();
        if (lane === "notification")
          expect(
            (
              await env.DB.prepare("SELECT dispatch_state FROM outbox WHERE topic = ?")
                .bind(NOTIFICATION_PUBLICATION_TOPIC)
                .first<{ dispatch_state: string }>()
            )?.dispatch_state,
          ).toBe("failed");
      });
    }
  }
});

describe("A-P3-SOURCE-RETIRE 已下线来源的遗留待办（ADR-0016）", () => {
  async function seedSourceJob(sourceId: string) {
    await env.DB.prepare(
      "INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?)",
    )
      .bind(
        `pipeline:source:${sourceId}`,
        SOURCE_JOB,
        JSON.stringify({ sourceId }),
        now - 1,
        now,
        now,
      )
      .run();
  }
  const jobOf = (sourceId: string) =>
    env.DB.prepare("SELECT status,last_error FROM jobs WHERE id = ?")
      .bind(`pipeline:source:${sourceId}`)
      .first();

  it("米游社轮询待办直接结束：不发请求、不记失败、不再续排", async () => {
    await seedSourceJob("miyoushe-news");
    const log = vi.spyOn(console, "log");
    const rt = runtime();
    await rt.tick();
    expect(await jobOf("miyoushe-news")).toEqual({ status: "done", last_error: "source_retired" });
    expect(requests).toEqual([]);
    expect(log.mock.calls.flat().some((line) => String(line).includes("pipeline_job_failed"))).toBe(
      false,
    );
    expect(await rt.nextAlarm()).toBeNull();
    // watchdog 只为注册来源补排待办，不会把已下线来源的待办复活。
    await rt.watchdog();
    expect(await jobOf("miyoushe-news")).toEqual({ status: "done", last_error: "source_retired" });
  });

  it("既不在注册表也不在下线名单的来源 ID 仍按数据错误终止", async () => {
    await seedSourceJob("forged-source");
    await runtime().tick();
    expect(await jobOf("forged-source")).toEqual({ status: "failed", last_error: "invalid_data" });
  });
});
