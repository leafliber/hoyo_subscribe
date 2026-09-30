// P3-06 获准跨卡：仅覆盖新增 D1 单值上限分级。
import { describe, expect, it } from "vitest";
import { classifyPipelineFailure } from "./failure";

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
