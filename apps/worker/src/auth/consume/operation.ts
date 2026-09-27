// P2-03 · 验证与完成共用的操作幂等键读取（主方案 §4.4）。
// 客户端在两次同源写请求中重用 Idempotency-Key；挑战 ID 不充当该键。

import { ApiError } from "../../shell";

const OPERATION_KEY_MAX_LENGTH = 128; // 请求字段尺寸，与 P2-02 幂等键一致；非业务配额。

export function requireOperationKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > OPERATION_KEY_MAX_LENGTH) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "idempotency-key", reason: "missing_or_invalid" }],
    });
  }
  return value;
}
