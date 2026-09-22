// Worker 侧错误响应构造（任务卡 P1-08；主方案 §8.2 末段、ENGINEERING.md §5.3）。
//
// 形状、状态映射与默认文案全部来自 @hoyo/contracts/src/errors（唯一定义源），
// 本模块只做两件事：把错误变成 Response；提供一个可抛出的 ApiError 让路由用
// 业务语义中断。文案恒为 contracts 固定文案——本模块刻意**不提供**自定义 message
// 的口子，避免任何调用方把用户输入或存在性信息写进错误响应。
import {
  API_ERROR_STATUS,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiErrorDetail,
  buildApiErrorBody,
} from "@hoyo/contracts";

/** 带业务错误码的可抛出错误；路由/中间件抛出后由外壳统一转成错误响应。 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly details?: ApiErrorDetail,
  ) {
    super(`api_error:${code}`);
    this.name = "ApiError";
  }
}

/**
 * 按 contracts 映射构造错误响应（JSON 体 + 状态码；安全头由路由层统一叠加）。
 * `statusOverride` 仅供传输层状态（404/405）复用七类码时覆盖状态码——错误码集合
 * 仍只有七类，映射仍是唯一来源。
 */
export function errorResponse(
  code: ApiErrorCode,
  details?: ApiErrorDetail,
  statusOverride?: number,
): Response {
  const body: ApiErrorBody = buildApiErrorBody(code, details);
  return new Response(JSON.stringify(body), {
    status: statusOverride ?? API_ERROR_STATUS[code],
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 正常 JSON 响应（安全头由路由层统一叠加）。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
