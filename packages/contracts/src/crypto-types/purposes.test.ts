// A-P1-CRYPTO · 密钥用途清单与 key_id 形状（任务卡 P1-06 交付物一；主方案 §8.3）。
// 类型层隔离的运行时面：清单完整性、唯一性、key_id 纯函数校验。
// 类型层混用编译错误的证明在 apps/worker/src/storage/crypto/purpose-isolation.types.ts。
import { describe, expect, it } from "vitest";
import { isValidUnsubscribeKeyId, KEY_PURPOSES } from "./purposes";

describe("A-P1-CRYPTO · 密钥用途清单（§8.3；P2-01 验收增补 preauth-cookie）", () => {
  it("清单与合同原文一一对应（八个）+ 增补项居末，顺序即合同顺序", () => {
    expect([...KEY_PURPOSES]).toEqual([
      "otp-mac",
      "email-lookup",
      "field-encryption",
      "unsubscribe-mac",
      "csrf",
      "vapid",
      "admin",
      "recovery-epoch",
      "preauth-cookie",
    ]);
  });

  it("用途不重复", () => {
    expect(new Set(KEY_PURPOSES).size).toBe(KEY_PURPOSES.length);
  });
});

describe("A-P1-CRYPTO · 退订 MAC key_id 形状（§7.6）", () => {
  it.each(["k1", "2026w37", "a", "rotate-2"])("合法：%s", (keyId) => {
    expect(isValidUnsubscribeKeyId(keyId)).toBe(true);
  });

  it.each([
    "", // 空
    "-lead", // 前导连字符
    "trail-", // 尾随连字符
    "dou--ble", // 连续连字符
    "UPPER", // 大小写歧义
    "有中文字", // 非 ASCII
    "with space", // 空白
    "over-sixteen-chars", // 超 16 字符
  ])("非法：%s", (keyId) => {
    expect(isValidUnsubscribeKeyId(keyId)).toBe(false);
  });
});
