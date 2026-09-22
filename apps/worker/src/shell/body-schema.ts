// 写 API 请求体校验：JSON、尺寸上限、未知字段拒绝、所有权字段拒绝（任务卡 P1-08
// 交付物三；主方案 §8.2 末段、§4.2 检查顺序第一环"请求结构与尺寸"）。
//
// 合同约束：
// - 尺寸上限只用注册表的 API_BODY_MAX_BYTES，认证类小字段由路由提供的更小 schema
//   约束（"认证另用小字段 schema"），本模块不引入第二份字节上限。
// - ★ 不接受请求体里的 user_id（§8.2："不能提交任意 user_id 代替当前会话"）。
//   所有权字段在任何嵌套层级出现都直接拒绝——不是"忽略"，是拒绝。
// - 未知字段拒绝（§8.2 "校验 JSON、未知字段"）：schema 之外的键一律 validation。
// - 错误细节只携带字段名与稳定短码，绝不回显字段值（值里可能有秘密或存在性信息）。
import { API_BODY_MAX_BYTES } from "@hoyo/contracts";
import { ApiError } from "./errors";

/**
 * 禁止出现在请求体的所有权字段（§8.2：所有权由服务端派生）。
 * 键名小写归一后匹配；大小写变体（userId → userid）同样命中。
 */
export const FORBIDDEN_BODY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "user_id",
  "userid",
  "owner_user_id",
  "owneruserid",
]);

/** 单个字段的形状约束；object 可嵌套（路径用 "." 连接）。 */
export type BodyFieldSpec =
  | {
      readonly type: "string";
      readonly optional?: boolean;
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | { readonly type: "number"; readonly optional?: boolean }
  | { readonly type: "boolean"; readonly optional?: boolean }
  | {
      readonly type: "object";
      readonly optional?: boolean;
      readonly fields: Readonly<Record<string, BodyFieldSpec>>;
    };

/** 一个写路由的请求体 schema（字段封闭集合；未知键即拒绝）。 */
export interface BodySchema {
  readonly fields: Readonly<Record<string, BodyFieldSpec>>;
}

/** 收集中的字段问题（可变数组；构造 detail 时交给 readonly 字段）。 */
type FieldIssue = { readonly path: string; readonly reason: string };

function validationError(fields: FieldIssue[]): never {
  throw new ApiError("validation", { code: "validation", fields });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取并解析写请求体：Content-Type 必须 application/json、字节尺寸不超过
 * API_BODY_MAX_BYTES（Content-Length 与实际解码字节双重检查）、必须是合法 JSON。
 * 任何一步失败抛 ApiError("validation")。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    validationError([{ path: "", reason: "content_type_must_be_json" }]);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isInteger(declaredLength) && declaredLength > API_BODY_MAX_BYTES) {
    validationError([{ path: "", reason: "body_too_large" }]);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > API_BODY_MAX_BYTES) {
    validationError([{ path: "", reason: "body_too_large" }]);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    validationError([{ path: "", reason: "malformed_json" }]);
  }
}

/**
 * 按 schema 校验已解析的请求体：顶层必须是对象；所有权字段（任何层级）先于一切拒绝；
 * 未知字段、类型不符、长度越界、必填缺失逐条报告。通过则原样返回（值中不可能含
 * 所有权字段——它们已被拒绝）。
 */
export function validateJsonBody(schema: BodySchema, body: unknown): Record<string, unknown> {
  const fields: FieldIssue[] = [];
  if (!isPlainObject(body)) {
    validationError([{ path: "", reason: "body_must_be_object" }]);
  }
  checkObject(schema, body, "", fields);
  if (fields.length > 0) {
    validationError(fields);
  }
  return body;
}

function checkObject(
  schema: BodySchema,
  value: Record<string, unknown>,
  prefix: string,
  out: FieldIssue[],
): void {
  // 所有权字段最先拒绝（§8.2）：即使 schema 误放行，这里也拦得住。
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_BODY_FIELD_NAMES.has(key.toLowerCase())) {
      out.push({ path: joinPath(prefix, key), reason: "field_not_allowed" });
    }
  }

  for (const [key, spec] of Object.entries(schema.fields)) {
    const path = joinPath(prefix, key);
    if (!(key in value)) {
      if (!spec.optional) {
        out.push({ path, reason: "missing_field" });
      }
      continue;
    }
    checkField(spec, value[key], path, out);
  }

  // 未知字段：schema 未声明的键（所有权字段已在上面单独点名）。
  for (const key of Object.keys(value)) {
    if (!(key in schema.fields)) {
      out.push({ path: joinPath(prefix, key), reason: "unknown_field" });
    }
  }
}

function checkField(spec: BodyFieldSpec, value: unknown, path: string, out: FieldIssue[]): void {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") {
        out.push({ path, reason: "type_mismatch" });
        return;
      }
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        out.push({ path, reason: "too_short" });
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        out.push({ path, reason: "too_long" });
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        out.push({ path, reason: "type_mismatch" });
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        out.push({ path, reason: "type_mismatch" });
      }
      return;
    }
    case "object": {
      if (!isPlainObject(value)) {
        out.push({ path, reason: "type_mismatch" });
        return;
      }
      checkObject({ fields: spec.fields }, value, path, out);
      return;
    }
  }
}

function joinPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}
