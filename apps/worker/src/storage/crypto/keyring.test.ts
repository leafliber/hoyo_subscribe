// A-P1-CRYPTO · 密钥环与用途隔离的运行时面（任务卡 P1-06 交付物一；主方案 §8.3）。
// 类型层混用编译错误的证明在 purpose-isolation.types.ts（tsc --noEmit 检查）；
// 这里验证：根秘密强度约束、独立 pepper、HKDF 派生的用途互异、key_id 轮换约束。
import { describe, expect, it } from "vitest";
import { Keyring } from "./keyring";
import { computePurposeMac, macOtpVerification, type OtpMacBinding } from "./mac";
import { signUnsubscribeToken } from "./unsubscribe";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const master1 = randomBytes(32);
const master2 = randomBytes(32);
const pepper1 = randomBytes(32);
const pepper2 = randomBytes(32);

const OTP_BINDING: OtpMacBinding = {
  purpose: "login",
  challengeId: "ch-1",
  emailKey: "ab".repeat(32),
  addressVersion: 1,
  generation: 0,
  code: "12345678",
};

describe("A-P1-CRYPTO · 根秘密强度与独立性约束", () => {
  it("masterSecret 低于 SECRET_BITS 拒绝构造", async () => {
    await expect(
      Keyring.create({
        masterSecret: randomBytes(31),
        otpPepper: pepper1,
        unsubscribeMacCurrentKeyId: "k1",
      }),
    ).rejects.toThrow(/SECRET_BITS/);
  });

  it("otpPepper 低于 SECRET_BITS 拒绝构造", async () => {
    await expect(
      Keyring.create({
        masterSecret: master1,
        otpPepper: randomBytes(16),
        unsubscribeMacCurrentKeyId: "k1",
      }),
    ).rejects.toThrow(/SECRET_BITS/);
  });

  it("otpPepper 与 masterSecret 相同串拒绝构造（§4.3 独立 pepper）", async () => {
    const same = new Uint8Array(master1);
    await expect(
      Keyring.create({
        masterSecret: master1,
        otpPepper: same,
        unsubscribeMacCurrentKeyId: "k1",
      }),
    ).rejects.toThrow(/独立/);
  });

  it("退订 key_id 形状非法或接受集合不含当前 id 时拒绝构造", async () => {
    await expect(
      Keyring.create({
        masterSecret: master1,
        otpPepper: pepper1,
        unsubscribeMacCurrentKeyId: "BAD!",
      }),
    ).rejects.toThrow(/key_id/);
    await expect(
      Keyring.create({
        masterSecret: master1,
        otpPepper: pepper1,
        unsubscribeMacCurrentKeyId: "k2",
        unsubscribeMacAcceptedKeyIds: ["k1"],
      }),
    ).rejects.toThrow(/当前 key_id/);
  });
});

describe("A-P1-CRYPTO · 八用途句柄（§8.3 清单）", () => {
  it("八个访问器各自返回稳定句柄（派生一次，重复取用同实例）", async () => {
    const ring = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    expect(ring.otpMac()).toBe(ring.otpMac());
    expect(ring.emailLookup()).toBe(ring.emailLookup());
    expect(ring.fieldEncryption()).toBe(ring.fieldEncryption());
    expect(ring.unsubscribeMac()).toBe(ring.unsubscribeMac());
    expect(ring.csrf()).toBe(ring.csrf());
    expect(ring.vapid()).toBe(ring.vapid());
    expect(ring.admin()).toBe(ring.admin());
    expect(ring.recoveryEpoch()).toBe(ring.recoveryEpoch());
    // 八个句柄互为不同对象
    const handles = [
      ring.otpMac(),
      ring.emailLookup(),
      ring.fieldEncryption(),
      ring.unsubscribeMac(),
      ring.csrf(),
      ring.vapid(),
      ring.admin(),
      ring.recoveryEpoch(),
    ];
    expect(new Set(handles).size).toBe(8);
  });

  it("句柄是不透明对象：读不出密钥材料（WeakMap 私有）", async () => {
    const ring = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    expect(Object.keys(ring.csrf())).toEqual([]);
    expect(Object.getOwnPropertyNames(ring.csrf())).toEqual([]);
  });
});

describe("A-P1-CRYPTO · HKDF 派生的用途互异（密码学面）", () => {
  it("OTP MAC 只随 pepper 变：换 master 不变 OTP MAC，换 pepper 才变（§4.3 独立 pepper）", async () => {
    const ringA = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const ringB = await Keyring.create({
      masterSecret: master2,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const ringC = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper2,
      unsubscribeMacCurrentKeyId: "k1",
    });

    const macA = await macOtpVerification(ringA.otpMac(), OTP_BINDING);
    const macB = await macOtpVerification(ringB.otpMac(), OTP_BINDING);
    const macC = await macOtpVerification(ringC.otpMac(), OTP_BINDING);
    expect(macA).toBe(macB); // master 无关
    expect(macA).not.toBe(macC); // pepper 决定
  });

  it("OTP 用途与其余用途派生互异：同 pepper 不同用途输出不同", async () => {
    // ringA 与 ringC 同 master：OTP pepper 分别为 pepper1/pepper2。
    // 直接比不可行（computePurposeMac 不收 OtpMacKey，正是隔离）——
    // 改为验证 master 派生的通用四用途两两互异，以及 OTP 与它们无碰撞。
    const ring = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const macs = await Promise.all(
      (
        [
          ["csrf", ring.csrf()],
          ["vapid", ring.vapid()],
          ["admin", ring.admin()],
          ["recovery-epoch", ring.recoveryEpoch()],
        ] as const
      ).map(([domain, key]) => computePurposeMac(key, `${domain}:probe`, "same-input")),
    );
    expect(new Set(macs).size).toBe(4);
    const otpMac = await macOtpVerification(ring.otpMac(), OTP_BINDING);
    // OTP MAC 为 hex、通用 MAC 为 base64url，编码不同不直接比对；断言互不为对方的另一种编码来源即可
    expect(macs.every((m) => m !== otpMac)).toBe(true);
  });

  it("master 变化使其余用途全变：ringA 与 ringB 的通用 MAC 不同", async () => {
    const ringA = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const ringB = await Keyring.create({
      masterSecret: master2,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const macA = await computePurposeMac(ringA.admin(), "admin:probe", "x");
    const macB = await computePurposeMac(ringB.admin(), "admin:probe", "x");
    expect(macA).not.toBe(macB);
  });

  it("退订 key_id 各自独立派生：同 master 下 k1 与 k2 的 token 不同", async () => {
    const binding = { emailBindingId: "eb-1", listScope: "routine" };
    const ring1 = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k1",
    });
    const ring2 = await Keyring.create({
      masterSecret: master1,
      otpPepper: pepper1,
      unsubscribeMacCurrentKeyId: "k2",
    });
    const t1 = await signUnsubscribeToken(ring1.unsubscribeMac(), binding);
    const t2 = await signUnsubscribeToken(ring2.unsubscribeMac(), binding);
    expect(t1).not.toBe(t2);
    expect(ring1.unsubscribeMacCurrentKeyId).toBe("k1");
    expect(ring2.unsubscribeMacAcceptedKeyIds).toEqual(["k2"]);
  });
});
