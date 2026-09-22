// A-P1-CRYPTO · 随机生成器（任务卡 P1-06 交付物四；主方案 §4.3、§4.5、附录 A.2）。
// 重点：SECRET_BITS 强度与唯一性；OTP_DIGITS 均匀性的卡方检验——
// 直接 byte % 10 的偏置（0–5 多 1/256）在同样本量下卡方值会到 ~100+，
// 远超上界，因此这条测试同时是拒绝采样不被退化成取模的回归测试。
import { OTP_DIGITS, SECRET_BITS } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { generateOtpCode, generateSecretToken } from "./random";

describe("A-P1-CRYPTO · 强随机秘密（SECRET_BITS，§4.5）", () => {
  it("长度 = SECRET_BITS/8 字节；base64url 形态 43 字符无填充", () => {
    const token = generateSecretToken();
    expect(token.bytes.byteLength).toBe(SECRET_BITS / 8);
    expect(token.base64url).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("批量生成不重复（2,000 次）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      seen.add(generateSecretToken().base64url);
    }
    expect(seen.size).toBe(2000);
  });
});

describe("A-P1-CRYPTO · 验证码均匀随机（OTP_DIGITS，§4.3）", () => {
  it("形状：恒为 OTP_DIGITS 位纯数字", () => {
    const shape = new RegExp(`^\\d{${OTP_DIGITS}}$`);
    for (let i = 0; i < 200; i++) {
      expect(generateOtpCode()).toMatch(shape);
    }
  });

  it("均匀性卡方检验：60,000 码 × 8 位 = 480,000 数字，df=9 卡方值落在随机带内", () => {
    const codes = 60_000;
    const draws = codes * OTP_DIGITS;
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < codes; i++) {
      for (const char of generateOtpCode()) {
        counts[Number(char)] += 1;
      }
    }
    const expected = draws / 10;
    const chiSquare = counts.reduce(
      (sum, observed) => sum + (observed - expected) ** 2 / expected,
      0,
    );
    // df=9 时 P(χ²<0.8)≈2e-4、P(χ²>30)≈2e-4：越界即分布异常（过偏或过"完美"都算异常）。
    // 取模偏置实现（0–5 各多 1/256）在此样本量下 χ²≈117，必然被拦截。
    expect(chiSquare).toBeGreaterThan(0.8);
    expect(chiSquare).toBeLessThan(30);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(draws);
  });

  it("逐位独立性抽查：同一位置上前缀样本不塌缩到少数值", () => {
    const firstDigitCounts = new Array<number>(10).fill(0);
    const n = 2000;
    for (let i = 0; i < n; i++) {
      firstDigitCounts[Number(generateOtpCode()[0])] += 1;
    }
    // 每个数字都应出现（200 样本/值量级下 P(某值 0 次)≈(0.9)^2000≈0）
    expect(firstDigitCounts.every((c) => c > 0)).toBe(true);
  });
});
