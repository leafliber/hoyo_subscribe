import { describe, expect, it } from "vitest";
import { CanonicalEmailSchema, canonicalizeEmail } from "./email";

describe("A-P1-CONTRACT 邮箱身份规范化（主方案 §4.1）", () => {
  it("大小写不同的输入得到同一身份键：大小写登录同账号", () => {
    expect(canonicalizeEmail("User@Example.com")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
    expect(canonicalizeEmail("uSER@EXAMPLE.COM")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
    expect(canonicalizeEmail("USER@Example.COM")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
    expect(CanonicalEmailSchema.parse("  User@Example.COM  ")).toBe("user@example.com");
  });

  it("去除两端空白；域名小写并去掉末尾根点", () => {
    expect(canonicalizeEmail("  user@example.com  ")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
    expect(canonicalizeEmail("\tuser@example.com\n")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
    expect(canonicalizeEmail("user@Sub.Example.COM")).toEqual({
      ok: true,
      canonical: "user@sub.example.com",
    });
    expect(canonicalizeEmail("user@example.com.")).toEqual({
      ok: true,
      canonical: "user@example.com",
    });
  });

  it("点号不被删除：本地部分的点是身份的一部分", () => {
    expect(canonicalizeEmail("First.Last@Example.com")).toEqual({
      ok: true,
      canonical: "first.last@example.com",
    });
    expect(canonicalizeEmail("u.s.e.r@example.com")).toEqual({
      ok: true,
      canonical: "u.s.e.r@example.com",
    });
  });

  it("加号与标签不被删除", () => {
    expect(canonicalizeEmail("user+tag@Example.com")).toEqual({
      ok: true,
      canonical: "user+tag@example.com",
    });
    expect(canonicalizeEmail("user+news@gmail.com")).toEqual({
      ok: true,
      canonical: "user+news@gmail.com",
    });
    expect(canonicalizeEmail("newsletter+2026w38@mihoyo.com")).toEqual({
      ok: true,
      canonical: "newsletter+2026w38@mihoyo.com",
    });
  });

  it("不做供应商特例合并：gmail 去点、googlemail、别名一律不等价", () => {
    const a = canonicalizeEmail("u.s.e.r@gmail.com");
    const b = canonicalizeEmail("user@gmail.com");
    expect(a.ok && b.ok && a.canonical !== b.canonical).toBe(true);

    const c = canonicalizeEmail("user@googlemail.com");
    expect(c).toEqual({ ok: true, canonical: "user@googlemail.com" });

    const d = canonicalizeEmail("user+promo@outlook.com");
    const e = canonicalizeEmail("user@outlook.com");
    expect(d.ok && e.ok && d.canonical !== e.canonical).toBe(true);
  });

  it("结构性错误逐条返回原因（首版 ASCII）", () => {
    expect(canonicalizeEmail("")).toEqual({ ok: false, reason: "empty" });
    expect(canonicalizeEmail("   ")).toEqual({ ok: false, reason: "empty" });
    expect(canonicalizeEmail("no-at-sign")).toEqual({ ok: false, reason: "missing_at" });
    expect(canonicalizeEmail("@example.com")).toEqual({ ok: false, reason: "empty_local_part" });
    expect(canonicalizeEmail("user@")).toEqual({ ok: false, reason: "empty_domain" });
    expect(canonicalizeEmail("a@b@c.example")).toEqual({ ok: false, reason: "at_in_local_part" });
    expect(canonicalizeEmail("a b@example.com")).toEqual({
      ok: false,
      reason: "whitespace_inside",
    });
    expect(canonicalizeEmail("a\u00a0b@example.com")).toEqual({
      ok: false,
      reason: "whitespace_inside",
    });
    expect(canonicalizeEmail("旅行者@mihoyo.com")).toEqual({ ok: false, reason: "non_ascii" });
    expect(canonicalizeEmail("user@米哈游.com")).toEqual({ ok: false, reason: "non_ascii" });
  });

  it("规范化失败时 Zod schema 拒绝输入", () => {
    expect(CanonicalEmailSchema.safeParse("not-an-email").success).toBe(false);
    expect(CanonicalEmailSchema.safeParse("a@b@c.example").success).toBe(false);
    expect(CanonicalEmailSchema.safeParse("用户@example.com").success).toBe(false);
    expect(CanonicalEmailSchema.safeParse("User@Example.com").success).toBe(true);
  });
});
