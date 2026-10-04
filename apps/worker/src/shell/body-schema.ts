// P2-06 跨卡最小扩展：配置数组需要外壳递归校验元素并拒绝嵌套所有权字段。
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
  | { readonly type: "array"; readonly optional?: boolean; readonly items: BodyFieldSpec }
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
 * 按实际字节流式读入请求体，累计超过 API_BODY_MAX_BYTES 立即取消读取。Content-Length 只能
 * 提前拒绝，不能代替计数：分块请求可以不带它，也可以谎报。
 */
async function readCappedBytes(request: Request, tooLarge: () => never): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > API_BODY_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          tooLarge();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * 读取并解析写请求体：Content-Type 必须 application/json、字节尺寸不超过
 * API_BODY_MAX_BYTES（Content-Length 提前拒绝 + 实际字节流式计数）、必须是合法 JSON。
 * 任何一步失败抛 ApiError("validation")。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    validationError([{ path: "", reason: "content_type_must_be_json" }]);
  }

  const tooLarge = (): never => validationError([{ path: "", reason: "body_too_large" }]);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isInteger(declaredLength) && declaredLength > API_BODY_MAX_BYTES) {
    tooLarge();
  }

  // 与 request.text() 相同的 UTF-8 解码（非法序列替换、去 BOM），但先受字节上限约束。
  const text = new TextDecoder().decode(await readCappedBytes(request, tooLarge));

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
    if (!Object.hasOwn(value, key)) {
      if (!spec.optional) {
        out.push({ path, reason: "missing_field" });
      }
      continue;
    }
    checkField(spec, value[key], path, out);
  }

  // 未知字段：schema 未声明的键（所有权字段已在上面单独点名）。只认自有属性，
  // __proto__、constructor、toString 等原型链上的名字不能冒充已声明字段。
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.fields, key)) {
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
    case "array": {
      if (!Array.isArray(value)) {
        out.push({ path, reason: "type_mismatch" });
        return;
      }
      for (const [index, item] of value.entries()) {
        checkField(spec.items, item, `${path}.${index}`, out);
      }
      return;
    }
  }
}

function joinPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

/** P4-06：仅封闭退订协议调用；错误不回显攻击者提交的字段名或值。 */
export async function readFormBody(
  request: Request,
  schema: BodySchema,
): Promise<Record<string, unknown>> {
  const invalid = (reason = "invalid_form"): never => validationError([{ path: "$body", reason }]);
  const contentType = request.headers.get("content-type") ?? "";
  const urlencoded =
    /^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
      contentType,
    );
  const multipart =
    /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=? -]+)"|([A-Za-z0-9'()+_,./:=?-]+))\s*$/i.exec(
      contentType,
    );
  if (!urlencoded && !multipart) invalid("unsupported_form_type");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > API_BODY_MAX_BYTES))
    invalid("body_too_large");
  const bytes = await readCappedBytes(request, () => invalid("body_too_large"));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid();
  }
  const fields: Record<string, unknown> = Object.create(null);
  const add = (name: string, value: string) => {
    if (
      Object.hasOwn(fields, name) ||
      !Object.hasOwn(schema.fields, name) ||
      FORBIDDEN_BODY_FIELD_NAMES.has(name.toLowerCase())
    )
      invalid();
    fields[name] = value;
  };
  try {
    if (urlencoded) {
      if (text)
        for (const pair of text.split("&")) {
          const equal = pair.indexOf("=");
          if (equal <= 0) invalid();
          add(
            decodeURIComponent(pair.slice(0, equal).replaceAll("+", " ")),
            decodeURIComponent(pair.slice(equal + 1).replaceAll("+", " ")),
          );
        }
    } else {
      const boundary = multipart?.[1] ?? multipart?.[2];
      if (!boundary || boundary.endsWith(" ")) invalid();
      const delimiter = `--${boundary}`;
      if (!text.startsWith(`${delimiter}\r\n`)) invalid();
      const parts = text.slice(delimiter.length + 2).split(`\r\n${delimiter}`);
      const tail = parts.pop();
      if (tail !== "--\r\n" && tail !== "--") invalid();
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i > 0 && !part.startsWith("\r\n")) invalid();
        const content = i === 0 ? part : part.slice(2);
        const divider = content.indexOf("\r\n\r\n");
        if (divider < 0) invalid();
        const headers = content.slice(0, divider).split("\r\n");
        // RFC8058 的字段均为文本；不接受 filename、折行、重复头或额外处置参数。
        const disposition = /^Content-Disposition: form-data;\s*name="([A-Za-z0-9_-]+)"$/i.exec(
          headers[0] ?? "",
        );
        if (
          !disposition ||
          headers.length > 2 ||
          (headers.length === 2 &&
            !/^Content-Type: text\/plain(?:;\s*charset=utf-8)?$/i.test(headers[1]))
        )
          invalid();
        add(disposition?.[1] ?? "", content.slice(divider + 4));
      }
    }
    return validateJsonBody(schema, fields);
  } catch {
    return invalid();
  }
}
