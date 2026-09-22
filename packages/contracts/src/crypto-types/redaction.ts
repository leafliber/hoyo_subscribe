// 日志脱敏：白名单机制 + 「禁止字段」清单自动检查（任务卡 P1-06 交付物五；主方案 §8.3）。
//
// 合同原文："应用日志与平台 invocation 配置均排查 Cookie、OTP、恢复码、完整邮箱、
// Feed/退订 URL、Push endpoint 和密钥泄漏。"
//
// 两层机制，纯函数、无运行时依赖（Worker 与测试环境均可直接用）：
//   1. sanitizeForLog —— **白名单**序列化：每层对象只保留白名单键，保留的字符串值再做
//      值级脱敏（完整邮箱、带 token 的 Feed/退订路径）。白名单外的一律丢弃，宁可少记。
//   2. findForbiddenLogLeaks / assertNoLogLeaks —— **黑名单自动检查**：深度扫描任意
//      结构，命中禁止字段名或禁止值模式即报告路径与规则。供测试与 P1-08 日志中间件
//      作防御性断言（方向性：宁可误报，不可漏报）。
// 正式的结构化日志中间件属 P1-08；本文件是它消费的唯一脱敏合同。

/** 字段名规范化：小写、`-` 与空白折叠为 `_`，用于规则匹配。 */
export function normalizeLogFieldName(field: string): string {
  return field.toLowerCase().replace(/[-\s]+/g, "_");
}

/**
 * 白名单中放行的 email 派生键：键控摘要与版本计数不是「完整邮箱」（§8.1 索引键 /
 * §4.1 地址版本）。除此以外任何含 email 的字段名都按禁止处理。
 */
export const EMAIL_DERIVED_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  "email_key",
  "email_version",
]);

/** 一条禁止字段规则：命中规范化字段名即视为泄漏。 */
export interface ForbiddenLogFieldRule {
  readonly id: string;
  readonly citation: string;
  readonly matches: (normalizedField: string) => boolean;
}

/** §8.3 禁止字段清单（+ 会话/Feed/receipt token 值的加固项）。 */
export const FORBIDDEN_LOG_FIELD_RULES: readonly ForbiddenLogFieldRule[] = [
  {
    id: "cookie",
    citation: "§8.3 Cookie",
    matches: (n) => n.includes("cookie"),
  },
  {
    id: "otp",
    citation: "§8.3 OTP",
    matches: (n) => n.includes("otp"),
  },
  {
    id: "recovery-code",
    citation: "§8.3 恢复码",
    matches: (n) => n.includes("recovery"),
  },
  {
    id: "email",
    citation: "§8.3 完整邮箱",
    matches: (n) => n.includes("email") && !EMAIL_DERIVED_FIELD_ALLOWLIST.has(n),
  },
  {
    id: "feed-url-or-token",
    citation: "§8.3 Feed URL",
    matches: (n) =>
      n.includes("feed") &&
      (n.includes("url") || n.includes("token") || n.includes("link") || n.includes("address")),
  },
  {
    id: "unsubscribe-url-or-token",
    citation: "§8.3 退订 URL",
    matches: (n) => n.includes("unsubscribe"),
  },
  {
    id: "push-endpoint",
    citation: "§8.3 Push endpoint",
    matches: (n) => n.includes("endpoint"),
  },
  {
    id: "push-or-vapid-secret",
    citation: "§8.3 Push 密钥",
    matches: (n) =>
      n.includes("vapid") ||
      n.includes("p256dh") ||
      (n.includes("push") && (n.includes("key") || n.includes("secret") || n.includes("auth"))),
  },
  {
    // 加固项：会话/Feed/receipt token 值同样不入日志（§4.5 会话 token 不放 URL 等；
    // 字面清单之外，按「宁可误报」方向扩展——分页游标一类的 *_token 命中时人工改名即可）。
    id: "token-value",
    citation: "§4.5/§6.1（加固）",
    matches: (n) => n === "token" || n.endsWith("_token") || n.startsWith("token_"),
  },
];

/** 白名单之外的键在 sanitizeForLog 中被丢弃；P1-08 可按需扩展，扩展即合同评审。 */
export const LOG_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  "ts",
  "level",
  "event",
  "request_id",
  "route",
  "method",
  "status",
  "duration_ms",
  "attempt",
  "count",
  "reason_code",
  "source",
  "table",
  "state",
  "id",
  "kind",
  "version",
  "cursor",
  "generation",
  "user_id",
  "session_id",
  "challenge_id",
  "preauth_id",
  "email_key",
  "email_version",
  "dedupe_family",
  "priority",
  "pool",
  "reserved",
  "settled",
  "uncertain",
]);

/** 完整邮箱值模式（§8.3 完整邮箱）：local@domain.tld。 */
export const FULL_EMAIL_VALUE_PATTERN = /[^\s@"'`]+@[^\s@"'`]+\.[^\s@"'`]+/;

/** 带 token 的 Feed/退订路径模式（§8.3 Feed/退订 URL）：高熵路径段（≥16 字符，token 含 `.` 分隔）。 */
export const TOKEN_BEARING_PATH_PATTERN =
  /\/(?:feeds\/u|unsubscribe|email\/one-click)\/[A-Za-z0-9_.-]{16,}[^\s"']*/;

/** 一处泄漏：路径 + 命中的规则。 */
export interface LogLeak {
  readonly path: string;
  readonly ruleId: string;
  readonly citation: string;
  readonly detail: string;
}

function matchForbiddenField(normalized: string): ForbiddenLogFieldRule | undefined {
  return FORBIDDEN_LOG_FIELD_RULES.find((rule) => rule.matches(normalized));
}

/** 值级检查：字符串里的完整邮箱与带 token 的路径。 */
function valueLeaks(path: string, value: string, out: LogLeak[]): void {
  if (FULL_EMAIL_VALUE_PATTERN.test(value)) {
    out.push({
      path,
      ruleId: "value-full-email",
      citation: "§8.3 完整邮箱",
      detail: "字符串值含完整邮箱形态",
    });
  }
  const urlMatch = value.match(TOKEN_BEARING_PATH_PATTERN);
  if (urlMatch) {
    out.push({
      path,
      ruleId: "value-token-url",
      citation: "§8.3 Feed/退订 URL",
      detail: `字符串值含带 token 的路径（前缀 ${urlMatch[0].slice(0, 24)}…）`,
    });
  }
}

/**
 * 深度扫描任意 JSON 形结构，报告全部禁止字段/禁止值命中。
 * 循环引用按已访问对象跳过；Map/Set/Date 等按未知类型只做字符串化值检查。
 */
export function findForbiddenLogLeaks(value: unknown, path = "$"): LogLeak[] {
  const out: LogLeak[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, nodePath: string): void => {
    if (typeof node === "string") {
      valueLeaks(nodePath, node, out);
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${nodePath}[${i}]`);
      });
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const normalized = normalizeLogFieldName(key);
      const rule = matchForbiddenField(normalized);
      if (rule) {
        out.push({
          path: `${nodePath}.${key}`,
          ruleId: rule.id,
          citation: rule.citation,
          detail: `禁止字段名命中规则 ${rule.id}`,
        });
      }
      walk(child, `${nodePath}.${key}`);
    }
  };
  walk(value, path);
  return out;
}

/** 自动检查入口：命中任何泄漏即抛错并逐条列出（供测试与日志中间件复用）。 */
export function assertNoLogLeaks(value: unknown): void {
  const leaks = findForbiddenLogLeaks(value);
  if (leaks.length > 0) {
    const lines = leaks.map(
      (leak) => `  ${leak.path} · ${leak.ruleId}（${leak.citation}）${leak.detail}`,
    );
    throw new Error(`日志禁止字段/禁止值命中 ${leaks.length} 处（§8.3）：\n${lines.join("\n")}`);
  }
}

// replaceAll 需要全局正则；对外模式保持非全局（.test() 无 lastIndex 状态坑），
// 这里按 source 克隆出仅内部使用的全局版本。
const FULL_EMAIL_GLOBAL = new RegExp(FULL_EMAIL_VALUE_PATTERN.source, "g");
const TOKEN_PATH_GLOBAL = new RegExp(TOKEN_BEARING_PATH_PATTERN.source, "g");

/** 保留的字符串值做值级脱敏：完整邮箱与带 token 的路径替换为占位符。 */
function redactStringValue(value: string): string {
  return value
    .replace(FULL_EMAIL_GLOBAL, "[redacted:email]")
    .replace(TOKEN_PATH_GLOBAL, "[redacted:token-url]");
}

/**
 * 白名单序列化：每层对象只保留白名单键；数组逐项递归；字符串做值级脱敏；
 * 其余原始值原样保留。非白名单键**静默丢弃**（宁可少记，不猜哪些字段安全）。
 * 返回新结构，不改输入。
 */
export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    return redactStringValue(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!LOG_FIELD_WHITELIST.has(normalizeLogFieldName(key))) {
      continue;
    }
    out[key] = sanitizeForLog(child);
  }
  return out;
}
