// API 外壳路由与统一中间件管线（任务卡 P1-08 交付物三；主方案 §8.2、§4.2、§8.3）。
//
// 管线（§4.2 检查顺序的"结构与尺寸 → 同源/CSRF"两环 + §8.3 权限域）：
//   写 API：JSON/尺寸/未知字段/所有权字段校验 → Origin 同源校验 → 鉴权 →
//           权限域守卫 → CSRF 双提交（MAC 绑定）→ 业务 handler（限速/配额属 P2）。
//   读 API：路由与方法匹配 →（user/admin 域才鉴权与守卫）→ handler。
//   能力型：内置 /feeds/u/{token}.ics 协议路由（GET/HEAD、路径形状），不吃 Cookie、
//           不做 CSRF、不放交互登录墙（§8.3 末段），鉴权是 Feed token 自己的窄合同。
//
// 所有响应统一叠加安全头（headers.ts）并记一条白名单请求日志；错误统一走
// contracts 七类码；未预期异常折叠为 temporarily_unavailable，只记 error.name
// （错误 message 可能携带库内部串，不落盘）。
import type { CsrfKey, UnauthorizedErrorDetail } from "@hoyo/contracts";
import { type BodySchema, readJsonBody, validateJsonBody } from "./body-schema";
import { verifyCsrf } from "./csrf";
import { type Authenticator, deriveOwnerUserId, type RouteDomain, type ShellAuth } from "./domains";
import { ApiError, errorResponse } from "./errors";
import { applySecurityHeaders, CORS_ALLOW_HEADERS } from "./headers";
import { logAnomalySampled, logEvent } from "./logger";
import { sameOriginCheck } from "./origin";

/** 传给业务 handler 的上下文。 */
export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** 校验后的请求体（仅写路由；所有权字段已被拒绝，不可能出现在值中）。 */
  readonly body?: Record<string, unknown>;
  /** 服务端派生的鉴权结果。 */
  readonly auth: ShellAuth;
  /** 服务端派生的所有者（§8.2）：仅 user 域会话非空。 */
  readonly ownerUserId: string | null;
  readonly requestId: string;
  readonly env: Env;
  readonly executionContext: ExecutionContext;
}

/** 一条路由声明。 */
export interface ShellRoute {
  readonly method: "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** 精确路径，或尾通配（如 "/api/v2/x/*"，捕获段进 params.rest）。 */
  readonly pattern: string;
  readonly domain: RouteDomain;
  /** 写 API 走完整校验管线（§8.2）。 */
  readonly write: boolean;
  /** 写路由的请求体 schema（未知字段拒绝 + 认证类小字段约束都由它表达）。 */
  readonly bodySchema?: BodySchema;
  /**
   * CSRF 绑定上下文（写路由必填，除非 csrf: false）：返回该请求 CSRF token 绑定的
   * 身份串（预认证 id / 会话 token 散列，P2 提供实际值）。
   */
  readonly csrfBinding?: (info: { request: Request; auth: ShellAuth }) => Promise<string>;
  /** 仅预认证初始化端点可设 false：它是 CSRF 的签发方，验证从下一次请求开始。 */
  readonly csrf?: false;
  readonly handler: (ctx: RouteContext) => Promise<Response>;
}

/** 外壳依赖。 */
export interface ShellDeps {
  readonly authenticator: Authenticator;
  /** CSRF 密钥提供方（P1-06 Keyring.csrf()）。未提供时写路由失败关闭。 */
  readonly csrfKey?: () => Promise<CsrfKey> | CsrfKey;
  /** 业务路由（P2+ 挂载；本卡骨架为空）。 */
  readonly routes?: readonly ShellRoute[];
  /** Feed 能力端点的业务 handler（P2/P3 挂载）；未提供时协议校验后返回 404。 */
  readonly feedHandler?: (ctx: RouteContext) => Promise<Response>;
}

const FEED_PATH_PREFIX = "/feeds/u/";
const FEED_SUFFIX = ".ics";
/** Feed token 路径段字符集：URL 安全且不含路径分隔符；语义校验（token 是否登记）属 P2/P3。 */
const FEED_TOKEN_CHARSET = /^[A-Za-z0-9_.-]+$/;

const ALL_METHODS = "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS";

function notFoundResponse(): Response {
  return errorResponse(
    "validation",
    { code: "validation", fields: [{ path: "$path", reason: "not_found" }] },
    404,
  );
}

function methodNotAllowedResponse(allowedMethods: readonly string[]): Response {
  const res = errorResponse(
    "validation",
    { code: "validation", fields: [{ path: "$method", reason: "method_not_allowed" }] },
    405,
  );
  res.headers.set("allow", allowedMethods.join(", "));
  return res;
}

/** 创建 API 外壳；返回与 ExportedHandler 兼容的 fetch。 */
export function createApiShell(deps: ShellDeps): {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      const startedAt = Date.now();
      const requestId = crypto.randomUUID();
      let routeLabel = "unmatched";
      let response: Response;
      try {
        response = await dispatch(deps, request, env, ctx, requestId, (label) => {
          routeLabel = label;
        });
      } catch (error) {
        if (error instanceof ApiError) {
          response = errorResponse(error.code, error.details);
        } else {
          // 未预期异常：折叠为统一 503；只记 error.name，不落 message（可能含库内部串）。
          logEvent("error", "handler_error", {
            reason_code: error instanceof Error ? error.name : "non_error_throw",
            route: routeLabel,
          });
          response = errorResponse("temporarily_unavailable");
        }
      }
      response = applySecurityHeaders(response);
      logEvent("info", "http_request", {
        request_id: requestId,
        route: routeLabel,
        method: request.method,
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return response;
    },
  };
}

async function dispatch(
  deps: ShellDeps,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
  labelRoute: (label: string) => void,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse();
  }
  const url = new URL(request.url);

  // 内置 Feed 能力路由（§8.2 /feeds/u/{token}.ics；§8.3 不进交互登录墙）。
  if (url.pathname.startsWith(FEED_PATH_PREFIX)) {
    labelRoute("feeds:builtin");
    return handleFeeds(deps, request, url, env, ctx, requestId);
  }

  const matched = matchRoutes(deps.routes ?? [], url.pathname, request.method);
  if (matched.kind === "no_match") {
    return notFoundResponse();
  }
  labelRoute(matched.label);
  if (matched.kind === "method_mismatch") {
    return methodNotAllowedResponse(matched.allowedMethods);
  }
  const route = matched.route;

  let auth: ShellAuth = { kind: "none" };
  if (route.domain === "user" || route.domain === "admin") {
    auth = await deps.authenticator.authenticate(request, route.domain);
    guardDomain(route.domain, auth);
  }

  let body: Record<string, unknown> | undefined;
  if (route.write) {
    // §4.2 顺序：结构与尺寸 → 同源/CSRF →（限速/Turnstile/配额属 P2 handler）。
    body = validateJsonBody(requireSchema(route), await readJsonBody(request));

    const origin = sameOriginCheck(request);
    if (origin !== "ok") {
      logAnomalySampled(
        "origin_rejected",
        route.pattern,
        `${origin}\n${request.headers.get("origin") ?? ""}`,
      );
      throw unauthorized(origin);
    }

    if (route.csrf !== false) {
      const key = await resolveCsrfKey(deps);
      const binding = await resolveCsrfBinding(route, { request, auth });
      const csrf = await verifyCsrf(key, request, binding);
      if (csrf !== "ok") {
        logAnomalySampled("csrf_rejected", route.pattern, `${csrf}\n${requestId}`);
        throw unauthorized(csrf);
      }
    }
  }

  return route.handler({
    request,
    url,
    params: matched.params,
    body,
    auth,
    ownerUserId: deriveOwnerUserId(auth),
    requestId,
    env,
    executionContext: ctx,
  });
}

function unauthorized(reason: UnauthorizedErrorDetail["reason"]): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason });
}

/** 域守卫（§8.3）：user/admin 会话互不通用；能力 token 与无身份都不算会话。 */
function guardDomain(domain: "user" | "admin", auth: ShellAuth): void {
  if (auth.kind === "session" && auth.domain === domain) {
    return;
  }
  if (auth.kind === "session") {
    throw unauthorized("wrong_domain");
  }
  throw unauthorized("no_session");
}

function requireSchema(route: ShellRoute): BodySchema {
  if (route.bodySchema === undefined) {
    // 写路由缺 schema 是接线错误：失败关闭（503），不静默放行未校验请求体。
    throw new Error(`write route missing bodySchema: ${route.pattern}`);
  }
  return route.bodySchema;
}

async function resolveCsrfBinding(
  route: ShellRoute,
  info: { request: Request; auth: ShellAuth },
): Promise<string> {
  if (route.csrfBinding === undefined) {
    // 写路由缺绑定是接线错误：失败关闭，不得退化为"无绑定"。
    throw new Error(`write route missing csrfBinding: ${route.pattern}`);
  }
  return route.csrfBinding(info);
}

async function resolveCsrfKey(deps: ShellDeps): Promise<CsrfKey> {
  if (deps.csrfKey === undefined) {
    // 无 CSRF 密钥即无写 API（失败关闭，不降级为免 CSRF）。
    throw new ApiError("temporarily_unavailable");
  }
  return deps.csrfKey();
}

type RouteMatch =
  | { readonly kind: "no_match" }
  | { readonly kind: "method_mismatch"; readonly label: string; readonly allowedMethods: string[] }
  | {
      readonly kind: "matched";
      readonly label: string;
      readonly route: ShellRoute;
      readonly params: Readonly<Record<string, string>>;
    };

/** 匹配路由：先按路径（精确/尾通配）；方法不匹配时收集该路径允许的全部方法。 */
function matchRoutes(routes: readonly ShellRoute[], pathname: string, method: string): RouteMatch {
  let matched: { route: ShellRoute; params: Record<string, string> } | null = null;
  const allowed = new Set<string>();
  let label = pathname;
  for (const route of routes) {
    const params = matchPattern(route.pattern, pathname);
    if (params === null) {
      continue;
    }
    label = route.pattern;
    allowed.add(route.method);
    if (route.method === method && matched === null) {
      matched = { route, params };
    }
  }
  if (matched !== null) {
    return { kind: "matched", label, route: matched.route, params: matched.params };
  }
  if (allowed.size === 0) {
    return { kind: "no_match" };
  }
  return { kind: "method_mismatch", label, allowedMethods: [...allowed] };
}

/** 精确匹配；尾通配 "/prefix/*" 捕获余下路径到 params.rest。 */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  if (!pattern.endsWith("/*")) {
    return pattern === pathname ? {} : null;
  }
  const prefix = pattern.slice(0, -2);
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  return rest.length === 0 ? null : { rest };
}

/** 内置 Feed 协议路由：方法 GET/HEAD、路径形状校验；鉴权与内容属 feedHandler（P2/P3）。 */
function handleFeeds(
  deps: ShellDeps,
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Response | Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowedResponse(["GET", "HEAD"]);
  }
  const segment = url.pathname.slice(FEED_PATH_PREFIX.length);
  const token = segment.endsWith(FEED_SUFFIX) ? segment.slice(0, -FEED_SUFFIX.length) : "";
  if (token.length === 0 || !FEED_TOKEN_CHARSET.test(token)) {
    return notFoundResponse();
  }
  const feedContext: RouteContext = {
    request,
    url,
    params: { token },
    auth: { kind: "capability" },
    ownerUserId: null,
    requestId,
    env,
    executionContext: ctx,
  };
  if (deps.feedHandler === undefined) {
    return notFoundResponse();
  }
  return deps.feedHandler(feedContext);
}

/** 预检响应：严格同源——不输出 Access-Control-Allow-Origin（跨源浏览器读不到任何响应）。 */
function preflightResponse(): Response {
  const headers = new Headers();
  headers.set("allow", ALL_METHODS);
  headers.set("access-control-allow-methods", ALL_METHODS);
  headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  return new Response(null, { status: 204, headers });
}
