// A-P1-SHELL：结构化日志与脱敏（§8.3；任务卡交付物五——直接消费 P1-06 redaction）。
import { ANOMALY_LOG_SAMPLING, LOG_FIELD_WHITELIST, shouldSampleAnomaly } from "@hoyo/contracts";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Authenticator, ShellAuth } from "./domains";
import { emitSanitizedLogLine, logAnomalySampled, logEvent } from "./logger";
import { createApiShell, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl } from "./test-support";

let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

function emittedLines(): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

describe("A-P1-SHELL 日志脱敏白名单生效（§8.3 禁止项不落盘）", () => {
  it("★ 构造含禁止字段（Cookie/OTP/恢复码/完整邮箱/Feed URL/Push endpoint/密钥）的日志事件：键与值都不落盘", () => {
    logEvent("info", "probe_event", {
      cookie: "session=supersecret",
      otp_code: "12345678",
      recovery_code: "R-9x",
      email: "user@example.com",
      feed_url: "https://app.test/feeds/u/abcdefghijklmnop.ics",
      push_endpoint: "https://push.example/d/1234",
      vapid_key: "k-xyz",
      // 白名单内的合法字段作为对照：应当保留。
      user_id: "u_1",
      reason_code: "probe",
    });
    const line = emittedLines().join("\n");
    expect(line).toContain("probe_event");
    expect(line).toContain("u_1");
    for (const forbidden of [
      "session=supersecret",
      "12345678",
      "R-9x",
      "user@example.com",
      "abcdefghijklmnop.ics",
      "push.example",
      "k-xyz",
      "cookie",
      "otp",
      "recovery",
      "email",
      "feed_url",
      "push_endpoint",
      "vapid",
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("白名单键的值也做值级脱敏：字符串里的完整邮箱与带 token 路径替换为占位符", () => {
    logEvent("warn", "value_redaction_probe", {
      cursor: "after user@example.com at /feeds/u/abcdefghijklmnopqrst.ics",
    });
    const line = emittedLines().join("\n");
    expect(line).toContain("[redacted:email]");
    expect(line).toContain("[redacted:token-url]");
    expect(line).not.toContain("user@example.com");
    expect(line).not.toContain("abcdefghijklmnopqrst.ics");
  });

  it("emitSanitizedLogLine 防御性断言命中（脱敏后仍带禁止字段）→ 整条丢弃留固定占位", () => {
    emitSanitizedLogLine({ level: "info", event: "x", otp: "12345678" });
    const lines = emittedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("log_line_dropped_by_redaction");
    expect(lines[0]).not.toContain("12345678");
  });

  it("请求日志只含白名单键（http_request 行形状）", async () => {
    const route: ShellRoute = {
      method: "GET",
      pattern: "/api/v2/logging-probe",
      domain: "public",
      write: false,
      handler: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    };
    const shell = createApiShell({
      authenticator: {
        async authenticate(): Promise<ShellAuth> {
          return { kind: "none" };
        },
      } satisfies Authenticator,
      routes: [route],
    });
    await shell.fetch(new Request(siteUrl("/api/v2/logging-probe")), fakeEnv, fakeExecutionContext);
    const httpRequestLine = emittedLines().find((line) => line.includes("http_request"));
    expect(httpRequestLine).toBeDefined();
    const parsed = JSON.parse(httpRequestLine as string) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(LOG_FIELD_WHITELIST.has(key)).toBe(true);
    }
    expect(parsed.route).toBe("/api/v2/logging-probe");
    expect(parsed.status).toBe(200);
  });
});

describe("A-P1-SHELL 异常请求日志采样（§8.3：不把每次攻击变成一条持久记录）", () => {
  it("同指纹恒同判；落盘行只含 kind 与 route，指纹（可能含 Origin/IP）不落盘", () => {
    const fingerprint = "origin=https://evil.example&ip=203.0.113.9";
    const first = logAnomalySampled("origin_rejected", "/api/v2/auth/challenges", fingerprint);
    for (let i = 0; i < 10; i++) {
      expect(logAnomalySampled("origin_rejected", "/api/v2/auth/challenges", fingerprint)).toBe(
        first,
      );
    }
    if (first) {
      const line = emittedLines().join("\n");
      expect(line).toContain("request_anomaly");
      expect(line).toContain("origin_rejected");
      expect(line).not.toContain("evil.example");
      expect(line).not.toContain("203.0.113.9");
    }
  });

  it("不同指纹中确有采样命中与未命中（1/N 而非全采/不采）", () => {
    let logged = 0;
    for (let i = 0; i < 200; i++) {
      if (logAnomalySampled("csrf_rejected", "/p", `fp-${i}`)) {
        logged++;
      }
    }
    expect(logged).toBeGreaterThan(0);
    expect(logged).toBeLessThan(200);
    // 与 contracts 采样函数的判定一致（同一来源，不另写一套）。
    expect(logAnomalySampled("csrf_rejected", "/p", "fp-0")).toBe(
      shouldSampleAnomaly("csrf_rejected\n/p\nfp-0"),
    );
    expect(ANOMALY_LOG_SAMPLING).toBeGreaterThan(1);
  });
});
