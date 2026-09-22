// API 错误模型（任务卡 P1-08 交付物一；主方案 §8.2 末段、ENGINEERING.md §5.3、前端 v1.0 §11.3）。
//
// 合同原文："错误至少区分 validation、unauthorized、conflict、rate_limited、
// capacity_reached、quota_paused、temporarily_unavailable；认证存在性敏感结果折叠。"
//
// 本文件是这七类错误的**唯一定义源**：错误码枚举、HTTP 状态映射、默认文案与响应体形状
// 都只在这里定义一次，Worker 构造响应、前端映射用户下一步（§11.3）共同消费。
// 纯数据 + 纯函数，无运行时依赖，Worker 与 Web 均可直接 import。
//
// 约束：
// - `message` 一律取 DEFAULT_API_ERROR_MESSAGES 的固定文案，不回显任何用户输入
//   （存在性折叠与日志/秘密红线在错误文案上同样成立）。
// - `details` 是结构化、按 code 判别的机器可读字段；前端据此执行 §11.3 的具体下一步，
//   不得解析 message 文案反推行为。

/** 七类错误码（§8.2 末段原文顺序；集合与顺序都是合同）。 */
export const API_ERROR_CODES = [
  "validation",
  "unauthorized",
  "conflict",
  "rate_limited",
  "capacity_reached",
  "quota_paused",
  "temporarily_unavailable",
] as const satisfies readonly string[];

/** 错误码类型。 */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * 错误码 → HTTP 状态的单一映射（Worker 生成响应时消费；前端以 body.code 为准做
 * 行为分支，但状态映射本身只有一个来源）。
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  validation: 400,
  unauthorized: 401,
  conflict: 409,
  rate_limited: 429,
  capacity_reached: 503,
  quota_paused: 503,
  temporarily_unavailable: 503,
};

/**
 * 固定默认文案（§11.3 页面反馈之外的兜底）。文案不承诺无法兑现的恢复时刻
 * （§11.3 quota_paused 行），不区分具体账号是否存在。
 */
export const DEFAULT_API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  validation: "请求不合法或缺少必填字段。",
  unauthorized: "需要重新登录或完成激活后继续。",
  conflict: "云端状态已变化，请刷新后重试。",
  rate_limited: "请求过于频繁，请稍后再试。",
  capacity_reached: "当前能力名额已满，公开浏览不受影响。",
  quota_paused: "相关通道或操作已暂停，暂不可用。",
  temporarily_unavailable: "服务暂不可用，请稍后重试。",
};

/**
 * validation 的字段级原因（§11.3："显示具体字段原因，保留输入；聚焦首个错误"）。
 * `path` 是请求体中的字段路径（嵌套用 "." 连接，整体请求用 ""）；`reason` 是稳定的
 * 机器可读短码（如 unknown_field / type_mismatch），不是给用户直接阅读的句子。
 */
export interface ValidationErrorDetail {
  readonly code: "validation";
  readonly fields: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * unauthorized 的下一步原因（§11.3："区分需要重新登录或完成激活"）。
 * reason 是闭合枚举；不出现"账号不存在"一类存在性信息（§4.2 折叠）。
 */
export type UnauthorizedReason =
  | "origin_missing" // 写请求缺少 Origin 头（非浏览器或配置异常）
  | "origin_mismatch" // Origin 与部署源不同源（跨站请求，§8.2）
  | "csrf_missing" // 缺 CSRF Cookie 或头
  | "csrf_mismatch" // CSRF 双提交不匹配 / MAC 绑定不符
  | "no_session" // 无有效会话
  | "session_expired" // 会话过期，需重新登录
  | "pending_activation" // 会话未激活，需完成激活
  | "wrong_domain"; // 会话权限域不匹配（普通用户 vs 管理员，§8.3）

/** unauthorized 的结构化细节。 */
export interface UnauthorizedErrorDetail {
  readonly code: "unauthorized";
  readonly reason: UnauthorizedReason;
}

/**
 * conflict 的结构化细节。差异展示需要云端当前状态，属 P2 业务负载
 * （如 expected_revision 不匹配时的当前 revision），外壳只定形状。
 */
export interface ConflictErrorDetail {
  readonly code: "conflict";
}

/**
 * rate_limited 的可公开等待信息（§11.3："按服务端可公开的等待信息提示"）。
 * 服务端选择不公开时不出现该字段；毫秒整数（ENGINEERING.md §5.1 精确时间口径）。
 */
export interface RateLimitedErrorDetail {
  readonly code: "rate_limited";
  readonly retry_after_ms?: number;
}

/** capacity_reached 指明哪个能力无名额；值是稳定的能力短码（P2 路由定义）。 */
export interface CapacityReachedErrorDetail {
  readonly code: "capacity_reached";
  readonly capability?: string;
}

/** quota_paused 指明受影响的操作或通道；同样是稳定短码，不承诺恢复时刻（§11.3）。 */
export interface QuotaPausedErrorDetail {
  readonly code: "quota_paused";
  readonly scope?: string;
}

/** temporarily_unavailable 的受控重试提示；毫秒整数，可不提供。 */
export interface TemporarilyUnavailableErrorDetail {
  readonly code: "temporarily_unavailable";
  readonly retry_after_ms?: number;
}

/** 全部错误细节的判别联合：details.code 与外层 error.code 恒一致。 */
export type ApiErrorDetail =
  | ValidationErrorDetail
  | UnauthorizedErrorDetail
  | ConflictErrorDetail
  | RateLimitedErrorDetail
  | CapacityReachedErrorDetail
  | QuotaPausedErrorDetail
  | TemporarilyUnavailableErrorDetail;

/** API 错误响应体（Worker 与前端共用的唯一形状）。 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: ApiErrorDetail;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 构造错误响应体：固定文案 + 可选结构化细节（判别码自动一致）。 */
export function buildApiErrorBody(code: ApiErrorCode, details?: ApiErrorDetail): ApiErrorBody {
  if (details === undefined) {
    return { error: { code, message: DEFAULT_API_ERROR_MESSAGES[code] } };
  }
  return { error: { code, message: DEFAULT_API_ERROR_MESSAGES[code], details } };
}

/**
 * 形状守卫：校验未知值是否为合法 ApiErrorBody（details 判别码必须与外层一致）。
 * 前端 fetch 层与测试共用；不深究细节内部字段（由各 code 的判别联合约束）。
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!isObject(value) || !isObject(value.error)) {
    return false;
  }
  const code = value.error.code;
  if (typeof code !== "string" || !(API_ERROR_CODES as readonly string[]).includes(code)) {
    return false;
  }
  if (typeof value.error.message !== "string") {
    return false;
  }
  const details = value.error.details;
  if (details !== undefined && (!isObject(details) || details.code !== code)) {
    return false;
  }
  return true;
}
