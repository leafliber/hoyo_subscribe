// A-P1-CRYPTO · 两类存储策略边界（任务卡 P1-06 交付物三；主方案 §8.3、§4.1、§4.3、§4.4、§6.1）。
// 登记表与合同清单逐条对账；数值期限与参数注册表对账（不出现第二份字面常量）。
import { describe, expect, it } from "vitest";
import { AUTH_COMPLETION_TTL, EXPIRED_AUTH_CLEANUP } from "../params/registry";
import {
  AUTH_COMPLETION_RECEIPT_MAX_SECONDS,
  CONTROLLED_CIPHERTEXT_STORAGE,
  HASH_ONLY_SECRET_STORAGE,
} from "./storage-policy";

describe("A-P1-CRYPTO · 只存 hash/MAC 的秘密（§8.3）", () => {
  it("类别与合同清单一一对应：会话 token、恢复码、Feed token 校验值、OTP 验证 MAC", () => {
    expect(HASH_ONLY_SECRET_STORAGE.map((entry) => entry.id)).toEqual([
      "session-token",
      "recovery-code",
      "feed-token-verification",
      "otp-verification-mac",
    ]);
  });

  it("每条登记都带合同出处，且不承诺可解密", () => {
    for (const entry of HASH_ONLY_SECRET_STORAGE) {
      expect(entry.citation).toMatch(/^§/);
      expect(entry.stores.length).toBeGreaterThan(0);
    }
  });
});

describe("A-P1-CRYPTO · 受控密文例外（§8.3：有明确理由、必须可解密）", () => {
  it("类别与合同清单一一对应：OTP 发信载荷、完成回执、Feed token 复制密文、投递地址", () => {
    expect(CONTROLLED_CIPHERTEXT_STORAGE.map((entry) => entry.id)).toEqual([
      "otp-mail-payload",
      "auth-completion-receipt",
      "feed-token-owner-copy",
      "delivery-email-address",
    ]);
  });

  it("每条例外都有明确理由（why）与清除规则（clearRule）", () => {
    for (const entry of CONTROLLED_CIPHERTEXT_STORAGE) {
      expect(entry.why.length).toBeGreaterThan(0);
      expect(entry.clearRule.length).toBeGreaterThan(0);
      expect(entry.citation).toMatch(/^§/);
    }
  });

  it("完成回执硬上限 = AUTH_COMPLETION_TTL（§4.4：仅在 AUTH_COMPLETION_TTL 内可取）", () => {
    const receipt = CONTROLLED_CIPHERTEXT_STORAGE.find(
      (entry) => entry.id === "auth-completion-receipt",
    );
    expect(receipt?.hardClearBoundSeconds).toBe(AUTH_COMPLETION_TTL);
    expect(AUTH_COMPLETION_RECEIPT_MAX_SECONDS).toBe(AUTH_COMPLETION_TTL);
  });

  it("OTP 发信载荷的兜底清理 = EXPIRED_AUTH_CLEANUP（§4.3：过期即不能授权）", () => {
    const payload = CONTROLLED_CIPHERTEXT_STORAGE.find((entry) => entry.id === "otp-mail-payload");
    expect(payload?.hardClearBoundSeconds).toBe(EXPIRED_AUTH_CLEANUP);
  });
});

describe("A-P1-CRYPTO · 两类边界互斥", () => {
  it("同一 id 不得同时出现在两类登记中（边界清晰）", () => {
    const hashIds = new Set<string>(HASH_ONLY_SECRET_STORAGE.map((entry) => entry.id));
    const cipherIds = CONTROLLED_CIPHERTEXT_STORAGE.map((entry) => entry.id);
    for (const id of cipherIds) {
      expect(hashIds.has(id)).toBe(false);
    }
    expect(new Set(cipherIds).size).toBe(cipherIds.length);
  });
});
