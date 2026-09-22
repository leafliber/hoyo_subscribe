// A-P2-PREAUTH · 预认证 Cookie 与纯函数单元（任务卡 P2-01 交付物一/二）。
// 覆盖：__Host-preauth 值的签发/验证闭环、防篡改、过期判定、Cookie 序列化五属性、
// 邮箱/全局配额纯判定边界、近似限速门的镜像语义（[R16] 建议性）。

import {
  AUTH_CHALLENGES_MAX,
  AUTH_CHALLENGES_PER_EMAIL,
  EMAIL_AUTH_INTENTS_DAY,
  OTP_COOLDOWN,
} from "@hoyo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { testKeyring } from "../../shell/test-support";
import { Keyring } from "../../storage/crypto/keyring";
import {
  initialPreauthExpiry,
  mintPreauthCookieValue,
  PREAUTH_COOKIE_NAME,
  serializePreauthSetCookie,
  verifyPreauthCookieValue,
} from "./cookie";
import { type AuthQuotaSnapshot, decideAuthQuota, intentsDayStartMs } from "./quota";
import { InMemoryAuthRateGate } from "./rate-gate";

const T0 = 1_800_000_000_000;
const SECOND = 1_000;

describe("A-P2-PREAUTH __Host-preauth Cookie 值（§4.3 前半）", () => {
  it("签发→验证闭环：MAC 认证的签发/截止信息可被服务端重建", async () => {
    const key = (await testKeyring).csrf();
    const { value, context } = await mintPreauthCookieValue(key, T0);
    expect(context.expiresAt).toBe(initialPreauthExpiry(T0));
    const verified = await verifyPreauthCookieValue(key, value, T0 + 1);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.context.preauthId).toBe(context.preauthId);
      expect(verified.context.issuedAt).toBe(T0);
      expect(verified.context.expiresAt).toBe(context.expiresAt);
    }
  });

  it("两次签发产生不同的随机值（不同标签页各自建立上下文）", async () => {
    const key = (await testKeyring).csrf();
    const a = await mintPreauthCookieValue(key, T0);
    const b = await mintPreauthCookieValue(key, T0);
    expect(a.context.preauthId).not.toBe(b.context.preauthId);
  });

  it("篡改截止时间被 MAC 拒绝（bad_mac，不接受未认证的截止信息）", async () => {
    const key = (await testKeyring).csrf();
    const { value } = await mintPreauthCookieValue(key, T0);
    const parts = value.split(".");
    parts[2] = String(Number(parts[2]) + 60_000);
    const verified = await verifyPreauthCookieValue(key, parts.join("."), T0);
    expect(verified).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("过期 Cookie 在 MAC 成立时按 expired 拒绝（判定在 MAC 之后，无时间侧信道）", async () => {
    const key = (await testKeyring).csrf();
    const { value } = await mintPreauthCookieValue(key, T0);
    const atExpiry = initialPreauthExpiry(T0);
    const verified = await verifyPreauthCookieValue(key, value, atExpiry);
    expect(verified).toEqual({ ok: false, reason: "expired" });
  });

  it("结构损坏（段数不对 / 非整数）按 malformed 拒绝", async () => {
    const key = (await testKeyring).csrf();
    expect(await verifyPreauthCookieValue(key, "abc", T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyPreauthCookieValue(key, "a.b.c.d.e", T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyPreauthCookieValue(key, "id.notanumber.1234.mac", T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("换密钥环签发的 Cookie 不被验证（MAC 绑定服务端秘密）", async () => {
    const other = await Keyring.create({
      masterSecret: crypto.getRandomValues(new Uint8Array(32)),
      otpPepper: crypto.getRandomValues(new Uint8Array(32)),
      unsubscribeMacCurrentKeyId: "other",
    });
    const { value } = await mintPreauthCookieValue((await testKeyring).csrf(), T0);
    const verified = await verifyPreauthCookieValue(other.csrf(), value, T0);
    expect(verified).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("Cookie 名与序列化：__Host- 前缀 + Secure/HttpOnly/SameSite=Lax/Path=/，无 Domain", () => {
    expect(PREAUTH_COOKIE_NAME).toBe("__Host-preauth");
    const cookie = serializePreauthSetCookie("v", 60);
    expect(cookie.startsWith("__Host-preauth=v;")).toBe(true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=60");
    expect(cookie.toLowerCase()).not.toContain("domain");
  });
});

describe("A-P2-PREAUTH 邮箱与全局配额纯判定（§4.2 第 5 步口径）", () => {
  const clean: AuthQuotaSnapshot = {
    emailIntentsToday: 0,
    emailLastIntentAt: null,
    emailOpenChallenges: 0,
    globalOpenChallenges: 0,
  };

  it("无历史即通过；冷却期内拒绝并给出可公开的等待毫秒", () => {
    expect(decideAuthQuota(clean, T0)).toEqual({ ok: true });
    const cooldown = decideAuthQuota({ ...clean, emailLastIntentAt: T0 - 10 * SECOND }, T0);
    expect(cooldown).toEqual({
      ok: false,
      rejection: { reason: "cooldown", retryAfterMs: (OTP_COOLDOWN - 10) * SECOND },
    });
    // 恰好冷却结束（间隔 >= OTP_COOLDOWN）不再拒绝。
    expect(
      decideAuthQuota({ ...clean, emailLastIntentAt: T0 - OTP_COOLDOWN * SECOND }, T0),
    ).toEqual({
      ok: true,
    });
  });

  it("当日意图数达到 EMAIL_AUTH_INTENTS_DAY 即拒绝（等号属触发侧）", () => {
    const decision = decideAuthQuota({ ...clean, emailIntentsToday: EMAIL_AUTH_INTENTS_DAY }, T0);
    expect(decision).toEqual({ ok: false, rejection: { reason: "intents_day" } });
    expect(
      decideAuthQuota({ ...clean, emailIntentsToday: EMAIL_AUTH_INTENTS_DAY - 1 }, T0),
    ).toEqual({
      ok: true,
    });
  });

  it("同邮箱有效挑战达到 AUTH_CHALLENGES_PER_EMAIL 拒绝；全站达到 AUTH_CHALLENGES_MAX 拒绝", () => {
    expect(
      decideAuthQuota({ ...clean, emailOpenChallenges: AUTH_CHALLENGES_PER_EMAIL }, T0),
    ).toEqual({ ok: false, rejection: { reason: "open_challenges" } });
    expect(decideAuthQuota({ ...clean, globalOpenChallenges: AUTH_CHALLENGES_MAX }, T0)).toEqual({
      ok: false,
      rejection: { reason: "challenges_max" },
    });
  });

  it("意图计数窗口起点随 UTC 日推进（跨日重置由窗口起点承载）", () => {
    const dayStart = intentsDayStartMs(T0);
    expect(dayStart % (24 * 60 * 60 * SECOND)).toBe(0);
    expect(intentsDayStartMs(dayStart + 24 * 60 * 60 * SECOND - 1)).toBe(dayStart);
    expect(intentsDayStartMs(dayStart + 24 * 60 * 60 * SECOND)).toBe(
      dayStart + 24 * 60 * 60 * SECOND,
    );
  });
});

describe("A-P2-PREAUTH 近似限速门（[R16]：只挡突发，镜像是建议性的）", () => {
  let gate: InMemoryAuthRateGate;

  beforeEach(() => {
    gate = new InMemoryAuthRateGate();
  });

  it("无镜像历史放行；受理后 OTP_COOLDOWN 内的重复申请被挡（保护 Turnstile 配额）", () => {
    const email = "burst@mirror.test";
    expect(gate.check({ canonicalEmail: email, now: T0 })).toEqual({ allowed: true });
    gate.recordIntent(email, T0);
    const rejected = gate.check({ canonicalEmail: email, now: T0 + 10 * SECOND });
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.reason).toBe("cooldown_mirror");
      expect(rejected.retryAfterMs).toBe((OTP_COOLDOWN - 10) * SECOND);
    }
    // 冷却结束即放行（精确判定仍由第 5 步 D1 读负责）。
    expect(gate.check({ canonicalEmail: email, now: T0 + OTP_COOLDOWN * SECOND })).toEqual({
      allowed: true,
    });
  });

  it("当日镜像次数达到 EMAIL_AUTH_INTENTS_DAY 拒绝；跨 UTC 日窗口重置", () => {
    const email = "daily@mirror.test";
    for (let i = 0; i < EMAIL_AUTH_INTENTS_DAY; i++) {
      gate.recordIntent(email, T0 + i * (OTP_COOLDOWN + 1) * SECOND);
    }
    const last = T0 + (EMAIL_AUTH_INTENTS_DAY - 1) * (OTP_COOLDOWN + 1) * SECOND;
    // 过了最后一次的冷却、但仍在当日 → intents_day_mirror（判定顺序：冷却先行）。
    const sameDay = gate.check({ canonicalEmail: email, now: last + (OTP_COOLDOWN + 1) * SECOND });
    expect(sameDay).toEqual({
      allowed: false,
      reason: "intents_day_mirror",
      retryAfterMs: expect.any(Number),
    });
    // 新的一天窗口重置——镜像只挡当日，不做跨日惩罚。
    expect(gate.check({ canonicalEmail: email, now: T0 + 24 * 60 * 60 * SECOND })).toEqual({
      allowed: true,
    });
  });

  it("不同邮箱互不影响（镜像按规范邮箱分窗）", () => {
    gate.recordIntent("a@mirror.test", T0);
    expect(gate.check({ canonicalEmail: "b@mirror.test", now: T0 + 1 })).toEqual({ allowed: true });
  });
});
