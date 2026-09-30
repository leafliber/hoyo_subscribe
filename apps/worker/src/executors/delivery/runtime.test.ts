// A-P4-OUTBOX · DO/定时接线与故障分级。本地 D1，环境未启用邮件，替身没有 send_email 调用。
import { env, runInDurableObject } from "cloudflare:test";
import { MAIL_METADATA_TTL, MATCH_PAGE, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { statusRoute } from "../../accounts/admission/status";
import { makeLifecycleRoutes } from "../../accounts/lifecycle/routes";
import * as recentAuth from "../../auth/challenges/recent-auth";
import * as resend from "../../auth/challenges/resend";
import { makeChallengeRoutes } from "../../auth/challenges/routes";
import * as admissionPipeline from "../../auth/preauth/pipeline";
import { startDueOccurrenceExpansion } from "../../mail/occurrences/expand";
import { pruneMailJobPage } from "../../mail/outbox/cleanup";
import type { SendDeps } from "../../mail/outbox/send";
import { mailAdmissionHook } from "../../mail/provider/admission";
import { mailAvailable, requireMailAvailable } from "../../mail/provider/availability";
import { deliveryWatchdog, dispatchScheduled } from "../../scheduled";
import type { ShellRoute } from "../../shell";
import { testKeyring } from "../../shell/test-support";
import { splitSqlStatements } from "../../storage/split-sql";
import { DeliveryRuntime } from "./runtime";

const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const T = Date.parse("2026-09-30T12:00:00Z");
const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
function deps(extra: Partial<SendDeps> = {}): SendDeps {
  return {
    db: env.DB,
    now: () => T,
    origin: "https://synthetic.example",
    fieldKey: async () => (await testKeyring).fieldEncryption(),
    available: async () => false,
    pause: async () => {},
    provider: {
      send: async () => {
        throw Error("must_not_send");
      },
    },
    ...extra,
  };
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(splitSqlStatements(migrations[path] ?? "").map((s) => env.DB.prepare(s)));
});
beforeEach(async () => {
  await env.DB.exec("DELETE FROM jobs");
  await env.DB.exec("DELETE FROM system_state");
  await env.DB.exec("DELETE FROM occurrences");
  await env.DB.exec("DELETE FROM milestones");
  await env.DB.exec("DELETE FROM events");
});
describe("A-P4-OUTBOX Delivery 执行器", () => {
  it("真实 DO watchdog 修复缺失 alarm，固定 main；Cron 某执行器失败不跳过 Delivery", async () => {
    const due = Date.now() + WATCHDOG_INTERVAL * 1000;
    await run(
      "INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('synthetic-expansion','occurrence_email_expansion','{}',?,'pending',?,?)",
      due,
      T,
      T,
    );
    const stub = env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName("main"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
    await dispatchScheduled(env, [
      async () => {
        throw Error("synthetic_pipeline_failure");
      },
      deliveryWatchdog,
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(due);
      await state.storage.deleteAlarm();
    });
    expect((await stub.fetch("https://delivery.internal/unknown")).status).toBe(404);
  });
  it("不因一个坏展开载荷永久重试：failed+固定原因，其他页继续", async () => {
    await run(
      "INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('synthetic-bad','occurrence_email_expansion','{}',?,'pending',?,?)",
      T,
      T,
      T,
    );
    await run(
      "INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at) VALUES ('synthetic-bad-second','occurrence_email_expansion','{}',?,'pending',?,?)",
      T,
      T,
      T,
    );
    await new DeliveryRuntime(deps()).tick();
    expect(
      (
        await env.DB.prepare("SELECT status FROM jobs WHERE id='synthetic-bad-second'").first<{
          status: string;
        }>()
      )?.status,
    ).toBe("failed");
    expect(
      await env.DB.prepare(
        "SELECT status,last_error,attempts FROM jobs WHERE id='synthetic-bad'",
      ).first(),
    ).toEqual({ status: "failed", last_error: "invalid_data", attempts: 1 });
  });
  it.each([false, true])(
    "全局失败分级 terminal=%s，下一 watchdog 重试或 failed 停止",
    async (terminal) => {
      await run(
        "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
        T,
      );
      const runtime = new DeliveryRuntime(
        deps({
          available: async () => {
            throw Error(terminal ? "too many SQL variables" : "temporary D1 failure");
          },
        }),
      );
      await runtime.tick();
      expect(await runtime.nextAlarm()).toBe(terminal ? null : T + WATCHDOG_INTERVAL * 1000);
      expect(
        await env.DB.prepare(
          "SELECT status,last_error FROM jobs WHERE id='delivery:backoff'",
        ).first(),
      ).toEqual({
        status: terminal ? "failed" : "pending",
        last_error: terminal ? "sql_binding_limit" : "transient_or_unknown",
      });
      expect(await mailAvailable(env.DB, T)).toBe(false);
      // 公开状态与生成前闸门读同一状态；executor failed 与 false 在同一事务落库。
      if (terminal) {
        expect(
          await env.DB.prepare(
            "SELECT value_json FROM system_state WHERE key='mail_sending_available'",
          ).first(),
        ).toEqual({ value_json: "false" });
        await expect(requireMailAvailable(env.DB)).rejects.toThrow();
        const configured = {
          ...env,
          AUTH_MAIL_FROM: "auth@synthetic.example",
          BIZ_MAIL_FROM: "biz@synthetic.example",
          SITE_ORIGIN: "https://synthetic.example",
          CRYPTO_MASTER_SECRET: "synthetic",
          CRYPTO_OTP_PEPPER: "synthetic",
          CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
        };
        expect(
          await (
            await statusRoute.handler({
              env: configured,
              url: new URL("https://synthetic.example/api/v2/status"),
            } as unknown as Parameters<ShellRoute["handler"]>[0])
          ).json(),
        ).toMatchObject({ mail_sending_available: false });
      } else expect(await mailAvailable(env.DB, T + WATCHDOG_INTERVAL * 1000)).toBe(true);
    },
  );
  it("元数据清理受注册表分页/保留约束；未完成未知结果保留", async () => {
    const old = T - MAIL_METADATA_TTL * 1000 - 1;
    for (let n = 0; n < MATCH_PAGE + 1; n++)
      await run(
        "INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at,completed_at) VALUES (?,'mail_send','{}',?,'done',?,?,?)",
        `synthetic_${n}`,
        old,
        old,
        old,
        old,
      );
    expect(await pruneMailJobPage(env.DB, T)).toBe(MATCH_PAGE);
    expect(await pruneMailJobPage(env.DB, T)).toBe(1);
    expect(await pruneMailJobPage(env.DB, T)).toBe(0);
  });
});
describe("A-P4-OUTBOX 认证路由故障门", () => {
  it("申请、重发、换邮箱验证码在缺配置时不访问密钥、不生成 OTP；公开状态提示", async () => {
    const keys = vi.fn(async () => {
      throw Error("must_not_generate");
    });
    const common = {
      keys,
      mail: mailAdmissionHook,
      rateGate: { check: () => ({ allowed: true as const }), recordIntent: () => {} },
      turnstile: () => ({ verify: async () => "passed" as const }),
    };
    const routes = [...makeChallengeRoutes(common), ...makeLifecycleRoutes(common)];
    for (const path of [
      "/api/v2/auth/challenges",
      "/api/v2/auth/challenges/resend",
      "/api/v2/me/recent-auth/challenges",
    ]) {
      const route = routes.find((r) => r.pattern === path);
      if (!route) throw Error("route");
      const ctx = {
        env,
        body: { action: "email_change", role: "new_address" },
      } as unknown as Parameters<ShellRoute["handler"]>[0];
      await expect(route.handler(ctx)).rejects.toThrow();
    }
    expect(keys).not.toHaveBeenCalled();
    const response = await statusRoute.handler({
      env,
      url: new URL("https://synthetic.example/api/v2/status"),
    } as unknown as Parameters<ShellRoute["handler"]>[0]);
    expect(await response.json()).toMatchObject({ mail_sending_available: false });
  });
});

it("A-P4-OUTBOX DO 正忙时申请、重发、换邮箱认证请求照常返回，不等待串行唤醒", async () => {
  const stub = env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName("synthetic-busy-auth"));
  await runInDurableObject(stub, async (instance, state) => {
    const object = instance as unknown as {
      runtime: DeliveryRuntime;
      alarm(): Promise<void>;
      fetch(request: Request): Promise<Response>;
    };
    const entered = deferred(),
      release = deferred(),
      pending: Promise<unknown>[] = [];
    // 真实 DO 实例/串行队列；只替换认证业务结果与 alarm 工作，不执行任何发送。
    const spies = [
      vi
        .spyOn(admissionPipeline, "runPreauthAdmission")
        .mockResolvedValue(new Response(null, { status: 202 })),
      vi.spyOn(resend, "runResendOtp").mockResolvedValue(new Response(null, { status: 202 })),
      vi.spyOn(recentAuth, "startRecentOtp").mockResolvedValue("synthetic-challenge"),
      vi.spyOn(object.runtime, "watchdog").mockResolvedValue(),
      vi.spyOn(object.runtime, "nextAlarm").mockResolvedValue(null),
      vi.spyOn(object.runtime, "tick").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      }),
    ];
    const busy = object.alarm();
    await entered.promise;
    let wakeFinished = 0;
    const common = {
      keys: () => testKeyring,
      rateGate: { check: () => ({ allowed: true as const }), recordIntent: () => {} },
      turnstile: () => ({ verify: async () => "passed" as const }),
      mail: {
        check: async () => {},
        committed: async () => {
          await object.fetch(new Request("https://delivery.internal/wake", { method: "POST" }));
          wakeFinished++;
        },
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const routes = [...makeChallengeRoutes(common), ...makeLifecycleRoutes(common)];
      const responses = Promise.all(
        [
          "/api/v2/auth/challenges",
          "/api/v2/auth/challenges/resend",
          "/api/v2/me/recent-auth/challenges",
        ].map(async (path) => {
          const route = routes.find((r) => r.pattern === path);
          if (!route) throw Error("route");
          return route.handler({
            env,
            body: { email: "synthetic@example.com", action: "email_change", role: "new_address" },
            request: new Request(`https://synthetic.example${path}`),
            auth: {
              kind: "session",
              domain: "user",
              userId: "synthetic",
              sessionId: "synthetic",
              sessionTokenHash: "synthetic",
            },
            executionContext: {
              waitUntil(p: Promise<unknown>) {
                pending.push(p);
              },
            },
          } as unknown as Parameters<ShellRoute["handler"]>[0]);
        }),
      );
      const got = await Promise.race([
        responses,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("HTTP waited for busy DO")), 2000);
        }),
      ]);
      expect(got.map((r) => r.status)).toEqual([202, 202, 202]);
      expect(pending).toHaveLength(3);
      expect(wakeFinished).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      await busy;
      await Promise.all(pending);
      for (const spy of spies) spy.mockRestore();
      await state.storage.deleteAlarm();
    }
    expect(wakeFinished).toBe(3);
  });
});

it.each([false, true])(
  "A-P4-OUTBOX 一个发生项起步失败 terminal=%s 独立停下，其他发生项仍展开",
  async (terminal) => {
    await run(
      `INSERT INTO events(id,game,region,event_type,status,title,event_revision,schedule_revision,created_at,updated_at)
    VALUES ('start-event','genshin','CN','limited_event','scheduled','synthetic',1,1,?,?)`,
      T,
      T,
    );
    await run(
      `INSERT INTO milestones(id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
    VALUES ('start-node','start-event','main','start','synthetic',?,'Asia/Shanghai','synthetic','official_explicit','datetime',?,?)`,
      T,
      T,
      T,
    );
    for (const id of ["bad", "good"])
      await run(
        `INSERT INTO occurrences(id,event_id,milestone_id,schedule_revision,kind,due_at,expires_at,created_at)
    VALUES (?,'start-event','start-node',1,?,?,?,?)`,
        id,
        id,
        T,
        T + WATCHDOG_INTERVAL * 1000 * 2,
        T,
      );
    let reads = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes('MAX("order")') && ++reads === 1)
              throw Error(terminal ? "too many SQL variables" : "temporary D1 failure");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await startDueOccurrenceExpansion(db, T, 2)).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT status,attempts,lease_version FROM jobs WHERE id='occurrence:bad:start'",
      ).first(),
    ).toEqual({ status: terminal ? "failed" : "pending", attempts: 1, lease_version: 1 });
    expect(
      await env.DB.prepare("SELECT id FROM jobs WHERE id='occurrence:good:email'").first(),
    ).not.toBeNull();
    expect(await startDueOccurrenceExpansion(db, T, 2)).toBe(0);
    expect(await startDueOccurrenceExpansion(db, T + WATCHDOG_INTERVAL * 1000, 2)).toBe(
      terminal ? 0 : 1,
    );
    expect(
      await env.DB.prepare("SELECT id FROM jobs WHERE id='delivery:backoff'").first(),
    ).toBeNull();
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
