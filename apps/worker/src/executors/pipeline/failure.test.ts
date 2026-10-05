// P3-06 获准跨卡：仅覆盖新增 D1 单值上限分级。
import { describe, expect, it } from "vitest";
import { classifyPipelineFailure } from "./failure";

describe("A-P3-SOURCE-RETIRE 已下线来源（ADR-0016）", () => {
  it("读取已下线来源的历史文章是确定性错误：终止，不跨 watchdog 重试", () => {
    expect(classifyPipelineFailure(new Error("来源已下线：miyoushe-news"))).toEqual({
      terminal: true,
      reason: "invalid_data",
    });
  });
});

describe("P3-06 D1 确定性单值上限", () => {
  it.each(["SQLITE_TOOBIG", "string or blob too big"])("%s 及包装 cause 均终止重试", (message) => {
    for (const error of [new Error(message), new Error("D1_ERROR", { cause: new Error(message) })])
      expect(classifyPipelineFailure(error)).toEqual({ terminal: true, reason: "sql_value_limit" });
    expect(classifyPipelineFailure(new Error("network failure"))).toEqual({
      terminal: false,
      reason: "transient_or_unknown",
    });
  });
});
