// A-P4-OUTBOX · DO/定时接线与故障分级。本地 D1，环境未启用邮件，替身没有 send_email 调用。
import { env, runInDurableObject } from "cloudflare:test";
import { MAIL_METADATA_TTL, MATCH_PAGE, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { statusRoute } from "../../accounts/admission/status";
import { makeLifecycleRoutes } from "../../accounts/lifecycle/routes";
import { makeChallengeRoutes } from "../../auth/challenges/routes";
import { pruneMailJobPage } from "../../mail/outbox/cleanup";
import type { SendDeps } from "../../mail/outbox/send";
import { mailAdmissionHook } from "../../mail/provider/admission";
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
    const response = await statusRoute.handler({ env } as Parameters<ShellRoute["handler"]>[0]);
    expect(await response.json()).toMatchObject({ mail_sending_available: false });
  });
});
