// A-P1-SHELL：异常请求日志采样（§8.3；ENGINEERING.md §5.5）。
import { describe, expect, it } from "vitest";
import { ANOMALY_LOG_SAMPLING, anomalySampleBucket, shouldSampleAnomaly } from "./sampling";

describe("A-P1-SHELL 异常请求日志采样（确定性 1/N）", () => {
  it("确定性：同一指纹重复判断恒一致（重放攻击不因重复而多记）", () => {
    for (const fingerprint of ["csrf:x:1", "origin:evil.example", "a", "", "中文指纹"]) {
      const first = shouldSampleAnomaly(fingerprint);
      for (let i = 0; i < 100; i++) {
        expect(shouldSampleAnomaly(fingerprint)).toBe(first);
      }
      expect(anomalySampleBucket(fingerprint)).toBe(anomalySampleBucket(fingerprint));
    }
  });

  it("桶值域合法：0 ≤ bucket < ANOMALY_LOG_SAMPLING", () => {
    for (let i = 0; i < 1000; i++) {
      const bucket = anomalySampleBucket(`fp-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(ANOMALY_LOG_SAMPLING);
    }
  });

  it("散布性：1000 个指纹中 true 与 false 都出现，落盘占比在 1/N 附近（不是全采也不是不采）", () => {
    let sampled = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (shouldSampleAnomaly(`fp-${i}`)) {
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(0);
    expect(sampled).toBeLessThan(total);
    // 期望 ~total/N；允许 [total/(4N), total*4/N] 的宽松区间（哈希散布，非精确比例断言）。
    expect(sampled).toBeGreaterThan(total / (4 * ANOMALY_LOG_SAMPLING));
    expect(sampled).toBeLessThan((total * 4) / ANOMALY_LOG_SAMPLING);
  });
});
