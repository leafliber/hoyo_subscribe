import { type ApiErrorBody, isApiErrorBody } from "@hoyo/contracts";

export class AdminRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: ApiErrorBody["error"]["details"],
  ) {
    super("admin_request_failed");
  }
}

// 每次写前读取当前 CSRF；不复制用户身份逻辑，不保存凭证或登录标志。
export async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] =
      document.cookie
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("__Host-hoyo_csrf="))
        ?.slice("__Host-hoyo_csrf=".length) ?? "";
  }
  const response = await fetch(`/api/v2/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // 不把响应/网络错误的任意文本带入错误提示（尤其是登录）。
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new AdminRequestError(
      response.status,
      isApiErrorBody(value) ? value.error.details : undefined,
    );
  if (value === null || typeof value !== "object") throw new Error("unknown_result");
  // 这里只描述 P3-10 的传输形状，不重定义 proposal 的业务校验。
  return value as T;
}
