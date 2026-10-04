// A-P3-VERSION · 版本相对时间锚点与确定性推导（纯函数）。
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  deriveVersionTime,
  nextKnownVersion,
  parseVersionAnchor,
  versionDerivationBasis,
} from "./version-time";

const tz = "UTC+08:00";
const window71 = {
  version: "7.1",
  updateStartMs: Date.parse("2026-09-22T22:00:00Z"), // 北京时间 2026-09-23 06:00
  versionEndMs: Date.parse("2026-11-03T22:00:00Z"),
};

describe("A-P3-VERSION 版本锚点", () => {
  it("只认整体就是锚点的官方写法", () => {
    expect(parseVersionAnchor("7.1版本更新后")).toEqual({ version: "7.1", kind: "update" });
    expect(parseVersionAnchor("自7.1版本更新后")).toEqual({ version: "7.1", kind: "update" });
    expect(parseVersionAnchor("「3.2」版本更新完成后")).toEqual({ version: "3.2", kind: "update" });
    expect(parseVersionAnchor(" 4.6版本结束前 ")).toEqual({ version: "4.6", kind: "end" });
    expect(parseVersionAnchor("4.6版本结束时")).toEqual({ version: "4.6", kind: "end" });
    // "结束后"用在开始节点时等于"下一版本更新后"，不能推成时刻。
    for (const raw of [
      "4.6版本结束后",
      "7.1版本期间",
      "7.1版更后",
      "7.1版本更新后永久开放",
      "版本更新后",
      "2026/10/13 17:59",
    ])
      expect(parseVersionAnchor(raw)).toBeNull();
  });

  it("推导依据写明取哪个版本的哪项时间；非锚点没有依据文本", () => {
    expect(versionDerivationBasis("7.1版本更新后")).toContain("7.1 版本更新开始当天");
    expect(versionDerivationBasis("7.1版本更新后")).toContain("不推出几点");
    expect(versionDerivationBasis("4.6版本结束")).toContain("4.6 版本的结束时间");
    expect(versionDerivationBasis("样例：第三日12时；由公告起始日确定推导")).toBeNull();
  });

  it("版本号按数值比较", () => {
    expect(compareVersions("7.10", "7.9")).toBeGreaterThan(0);
    expect(compareVersions("8.0", "7.9")).toBeGreaterThan(0);
    expect(compareVersions("4.6", "4.6")).toBe(0);
  });

  it("下一版本只认紧接着的版本号，不跳过未知版本", () => {
    expect(nextKnownVersion("7.1", ["7.2", "7.3"])).toBe("7.2");
    expect(nextKnownVersion("7.1", ["7.3", "8.1"])).toBeNull();
    expect(nextKnownVersion("4.8", ["5.0", "5.1"])).toBe("5.0");
    expect(nextKnownVersion("4.8", ["4.9", "5.0"])).toBe("4.9");
    expect(nextKnownVersion("7.9", ["7.10"])).toBe("7.10");
  });
});

describe("A-P3-VERSION 确定性推导", () => {
  it("更新后只推到北京时间的更新日期，不推出时刻", () => {
    expect(deriveVersionTime("7.1版本更新后", window71, tz)).toEqual({
      precision: "date",
      date: "2026-09-23",
      source_timezone: tz,
      raw_expression: "7.1版本更新后",
      time_basis: "deterministic_derived",
    });
  });

  it("版本结束推到确认过的结束时刻；北京时间跨日的边界按北京日期", () => {
    expect(deriveVersionTime("7.1版本结束", window71, tz)).toEqual({
      precision: "datetime",
      utc_ms: window71.versionEndMs,
      source_timezone: tz,
      raw_expression: "7.1版本结束",
      time_basis: "deterministic_derived",
    });
    const lateUtc = { ...window71, updateStartMs: Date.parse("2026-09-22T16:30:00Z") };
    expect(deriveVersionTime("7.1版本更新后", lateUtc, tz)).toMatchObject({ date: "2026-09-23" });
  });

  it("版本不匹配、字段未确认或无法识别时保持未定", () => {
    expect(deriveVersionTime("7.2版本更新后", window71, tz)).toBeNull();
    expect(deriveVersionTime("7.1版本结束", { ...window71, versionEndMs: null }, tz)).toBeNull();
    expect(deriveVersionTime("7.1版本更新后", { ...window71, updateStartMs: null }, tz)).toBeNull();
    expect(deriveVersionTime("7.1版本期间", window71, tz)).toBeNull();
    expect(deriveVersionTime("7.1版本更新后", undefined, tz)).toBeNull();
  });
});
