// A-P1-CRYPTO · 日志脱敏：白名单机制与禁止字段自动检查（任务卡 P1-06 交付物五；主方案 §8.3）。
import { describe, expect, it } from "vitest";
import {
  assertNoLogLeaks,
  EMAIL_DERIVED_FIELD_ALLOWLIST,
  FORBIDDEN_LOG_FIELD_RULES,
  findForbiddenLogLeaks,
  LOG_FIELD_WHITELIST,
  normalizeLogFieldName,
  sanitizeForLog,
} from "./redaction";

describe("A-P1-CRYPTO · 禁止字段清单覆盖 §8.3 逐类", () => {
  it("Cookie：各种命名风格都命中", () => {
    for (const field of [
      "cookie",
      "Cookie",
      "set-cookie",
      "set_cookie",
      "httpCookie",
      "cookies_jar",
    ]) {
      expect(findForbiddenLogLeaks({ [field]: "x" }).map((l) => l.ruleId)).toContain("cookie");
    }
  });

  it("OTP：字段名含 otp 即命中", () => {
    for (const field of ["otp", "otp_code", "OtpValue", "mail_otp_body"]) {
      expect(findForbiddenLogLeaks({ [field]: "x" }).map((l) => l.ruleId)).toContain("otp");
    }
  });

  it("恢复码：字段名含 recovery 即命中（§4.6：日志不得包含恢复码）", () => {
    for (const field of ["recovery_code", "RecoveryCode", "recovery_secret"]) {
      expect(findForbiddenLogLeaks({ [field]: "x" }).map((l) => l.ruleId)).toContain(
        "recovery-code",
      );
    }
  });

  it("完整邮箱：email 派生白名单（email_key/email_version）之外一律命中", () => {
    expect(findForbiddenLogLeaks({ email: "a@b.c" }).map((l) => l.ruleId)).toContain("email");
    expect(findForbiddenLogLeaks({ email_address: "a@b.c" }).map((l) => l.ruleId)).toContain(
      "email",
    );
    expect(findForbiddenLogLeaks({ user_email_copy: "a@b.c" }).map((l) => l.ruleId)).toContain(
      "email",
    );
    // 白名单派生键：键控摘要与版本计数不是完整邮箱
    expect(findForbiddenLogLeaks({ email_key: "ab12…", email_version: 3 })).toEqual([]);
    expect([...EMAIL_DERIVED_FIELD_ALLOWLIST]).toEqual(["email_key", "email_version"]);
  });

  it("Feed/退订 URL 与 token：feed_url、feed_token、unsubscribe_url 命中", () => {
    expect(
      findForbiddenLogLeaks({ feed_url: "https://x/feeds/u/abc.ics" }).map((l) => l.ruleId),
    ).toContain("feed-url-or-token");
    expect(findForbiddenLogLeaks({ feed_token: "…" }).map((l) => l.ruleId)).toContain(
      "feed-url-or-token",
    );
    expect(findForbiddenLogLeaks({ unsubscribe_url: "…" }).map((l) => l.ruleId)).toContain(
      "unsubscribe-url-or-token",
    );
    expect(findForbiddenLogLeaks({ one_click_unsubscribe: "…" }).map((l) => l.ruleId)).toContain(
      "unsubscribe-url-or-token",
    );
  });

  it("Push endpoint 与密钥：endpoint、push_endpoint、vapid_key、push_auth 命中", () => {
    expect(
      findForbiddenLogLeaks({ endpoint: "https://push.example/…" }).map((l) => l.ruleId),
    ).toContain("push-endpoint");
    expect(findForbiddenLogLeaks({ push_endpoint: "…" }).map((l) => l.ruleId)).toContain(
      "push-endpoint",
    );
    expect(findForbiddenLogLeaks({ vapid_key: "…" }).map((l) => l.ruleId)).toContain(
      "push-or-vapid-secret",
    );
    expect(findForbiddenLogLeaks({ push_auth: "…" }).map((l) => l.ruleId)).toContain(
      "push-or-vapid-secret",
    );
    expect(findForbiddenLogLeaks({ keys_p256dh: "…" }).map((l) => l.ruleId)).toContain(
      "push-or-vapid-secret",
    );
  });

  it("加固项：会话/Feed/receipt token 值字段命中 token-value", () => {
    for (const field of ["token", "session_token", "token_value", "receipt_token"]) {
      expect(findForbiddenLogLeaks({ [field]: "x" }).map((l) => l.ruleId)).toContain("token-value");
    }
  });

  it("嵌套结构与数组：泄漏报告带完整路径", () => {
    const leaks = findForbiddenLogLeaks({
      ctx: { mail: [{ otp: "12345678" }, { note: "ok" }] },
      request_id: "r-1",
    });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.path).toBe("$.ctx.mail[0].otp");
    expect(leaks[0]?.ruleId).toBe("otp");
  });
});

describe("A-P1-CRYPTO · 值级自动检查", () => {
  it("字符串值含完整邮箱即命中，即使字段名无害", () => {
    const leaks = findForbiddenLogLeaks({ note: "发给 somebody@example.com 的邮件" });
    expect(leaks.map((l) => l.ruleId)).toContain("value-full-email");
  });

  it("字符串值含带 token 的 Feed/退订路径即命中", () => {
    const leaks = findForbiddenLogLeaks({ route: "/feeds/u/abcdefghijklmnopqrst.ics" });
    expect(leaks.map((l) => l.ruleId)).toContain("value-token-url");
    const leaks2 = findForbiddenLogLeaks({ detail: "GET /unsubscribe/v1.k1.QWERTYUIOPASDFGH" });
    expect(leaks2.map((l) => l.ruleId)).toContain("value-token-url");
  });

  it("普通路由不含 token 路径段，不误报", () => {
    expect(findForbiddenLogLeaks({ route: "/api/subscription", note: "保存配置" })).toEqual([]);
  });
});

describe("A-P1-CRYPTO · assertNoLogLeaks 自动检查入口", () => {
  it("干净记录通过", () => {
    expect(() =>
      assertNoLogLeaks({
        ts: 1,
        level: "info",
        event: "saved",
        request_id: "r-1",
        email_key: "ab",
      }),
    ).not.toThrow();
  });

  it("命中即抛错并指明路径与规则", () => {
    let message = "";
    try {
      assertNoLogLeaks({ outer: { set_cookie: "session=…" } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("$.outer.set_cookie");
    expect(message).toContain("cookie");
    expect(message).toContain("§8.3");
  });
});

describe("A-P1-CRYPTO · 白名单序列化 sanitizeForLog", () => {
  it("白名单外的键被丢弃，白名单内的保留", () => {
    const input = {
      ts: 1,
      event: "challenge_created",
      request_id: "r-1",
      email_key: "ab", // 白名单内
      email: "user@example.com", // 白名单外 → 丢弃
      otp: "87654321", // 白名单外 → 丢弃
      nested: { state: "pending", cookie: "x" }, // nested 整键在白名单外 → 丢弃
    };
    expect(sanitizeForLog(input)).toEqual({
      ts: 1,
      event: "challenge_created",
      request_id: "r-1",
      email_key: "ab",
    });
  });

  it("每层对象都按白名单过滤：白名单内的嵌套对象里仍有害的键被丢弃", () => {
    const input = {
      table: "auth_challenges",
      row: { generation: 2, mac: "ab", receipt_ciphertext: "blob" }, // row 键不在白名单
    };
    expect(sanitizeForLog(input)).toEqual({ table: "auth_challenges" });
  });

  it("保留的字符串值做值级脱敏：完整邮箱与带 token 路径替换为占位符", () => {
    const input = {
      reason_code:
        "address user@example.com bounced; retry /feeds/u/abcdefghijklmnopqrst.ics later",
      note: "此键在白名单外，整体丢弃", // 对照：值级脱敏只作用于保留下来的键
    };
    const out = sanitizeForLog(input) as Record<string, unknown>;
    expect(typeof out.reason_code).toBe("string");
    expect(out.note).toBeUndefined();
    expect(out.reason_code).not.toContain("user@example.com");
    expect(out.reason_code).not.toContain("abcdefghijklmnopqrst");
    expect(out.reason_code).toContain("[redacted:email]");
    expect(out.reason_code).toContain("[redacted:token-url]");
  });

  it("数组逐项递归、原始值原样、不改输入", () => {
    const input = [{ status: 200, otp: "1" }, "plain", 3, null];
    const out = sanitizeForLog(input) as unknown[];
    expect(out).toEqual([{ status: 200 }, "plain", 3, null]);
    expect(input).toEqual([{ status: 200, otp: "1" }, "plain", 3, null]);
  });

  it("字段名规范化后比对白名单（大小写与连字符不绕过）", () => {
    expect(normalizeLogFieldName("Request-Id")).toBe("request_id");
    const out = sanitizeForLog({ "REQUEST-ID": "r-9", OTP: "1" }) as Record<string, unknown>;
    expect(out["REQUEST-ID"]).toBe("r-9");
    expect(out.OTP).toBeUndefined();
  });

  it("白名单本身不含禁止字段规则会放行的键（两张清单互检）", () => {
    for (const key of LOG_FIELD_WHITELIST) {
      const hits = FORBIDDEN_LOG_FIELD_RULES.filter((rule) => rule.matches(key));
      expect(hits).toEqual([]);
    }
  });
});
