// 安全响应头与严格同源 CORS（任务卡 P1-08 交付物四；主方案 §8.3）。
//
// 合同原文："使用 CSP、no-referrer、严格同源 CORS；认证和退订页面不加载第三方追踪代码。"
//
// 严格同源 CORS 的实现取向：API **从不**输出 Access-Control-Allow-Origin（也不输出
// 通配符），浏览器因此无法跨源读取任何响应；同源页面本就不需要 CORS 头。所有响应
// 带 Vary: Origin，避免共享缓存把带 Origin 的响应错配给另一源。
//
// API / Feed 响应一律使用 CSP_STRICT（无任何执行源）。若后续任务卡由 Worker 直接
// 输出 HTML（认证、退订确认页），必须使用 CSP_HTML_SAME_ORIGIN：脚本与样式仅同源，
// 禁止任何第三方源——§8.3"认证和退订页面不加载第三方追踪代码"的强制面。
export const CSP_STRICT =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** 认证/退订等 HTML 页面专用 CSP：仅同源资源，第三方脚本在策略层被禁止（§8.3）。 */
export const CSP_HTML_SAME_ORIGIN =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const REFERRER_POLICY = "no-referrer";

/** 预检允许的请求头（严格同源：只放行外壳自己要求的两个非简单头）。 */
export const CORS_ALLOW_HEADERS = "content-type, x-csrf-token";

/** 给响应叠加安全头。Response 头部不可变，这里统一克隆重建。 */
export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CSP_STRICT);
  headers.set("referrer-policy", REFERRER_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("vary", appendVaryOrigin(headers.get("vary")));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 合并既有 Vary 值与 Origin，不重复。 */
function appendVaryOrigin(existing: string | null): string {
  if (existing === null) {
    return "Origin";
  }
  const parts = existing
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.some((p) => p.toLowerCase() === "origin")) {
    parts.push("Origin");
  }
  return parts.join(", ");
}
