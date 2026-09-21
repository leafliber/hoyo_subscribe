// 邮箱身份规范化的唯一实现（主方案 §4.1）。
//
// 本函数产出的是**本站账号身份键**（canonical_email），不是投递地址：
// - 去除两端空白；域名规范化并小写；本地部分折叠小写。
// - **不删除点号、加号或标签**（first.last+tag@ 与 firstlast@ 是两个不同身份）。
// - **不做任何供应商特例合并**（gmail 去点、googlemail 等价、outlook 别名都不做）。
// - 首版仅支持 ASCII 本地部分与 ASCII 域名；非 ASCII 进入后续版本（不做有损 toLowerCase）。
// 这是产品约定的身份规则，不声称所有邮件服务器天然大小写不敏感。实际投递地址独立加密保存，
// 已有身份再次登录时验证码只发数据库中已验证的地址（email_key = HMAC(lookup_key, canonical)
// 属于 P1-06，这里只负责 canonical 串本身）。
import { z } from "zod";

/** 规范化失败原因。错误是结构性的；不做 RFC 全语法校验，不因奇怪但无歧义的地址拒绝。 */
export type EmailCanonicalizationError =
  | "empty" // 去除两端空白后为空
  | "missing_at" // 没有 @ 分隔
  | "at_in_local_part" // 本地部分含 @（首版不支持引号本地部分）
  | "empty_local_part"
  | "empty_domain"
  | "whitespace_inside" // 内部含空白或控制字符
  | "non_ascii"; // 本地部分或域名含非 ASCII 字符（首版不支持）

export type EmailCanonicalizationResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: EmailCanonicalizationError };

const ASCII_PATTERN = /^[\x20-\x7E]*$/; // 可打印 ASCII（空白已在前面单独拦截）
const WHITESPACE_CHAR = /\s/;

/** 内部空白或 C0/DEL 控制字符（按代码点扫描，控制字符不写进正则字面量）。 */
function hasWhitespaceOrControlInside(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f || WHITESPACE_CHAR.test(char))) {
      return true;
    }
  }
  return false;
}

/**
 * 规范化邮箱为本站身份键。纯函数，Worker 与 Web 共用同一份（前端 §12.1：不得另写一套）。
 *
 * 域名规范化 = 小写 + 去掉末尾根点（FQDN 尾点语义等价）；本地部分 = 原样保留点号/加号/标签，仅折叠小写。
 */
export function canonicalizeEmail(input: string): EmailCanonicalizationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (hasWhitespaceOrControlInside(trimmed)) {
    return { ok: false, reason: "whitespace_inside" };
  }
  // 按最后一个 @ 切分；本地部分里再出现 @ 说明不是首版支持的形状。
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex < 0) {
    return { ok: false, reason: "missing_at" };
  }
  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (localPart.length === 0) {
    return { ok: false, reason: "empty_local_part" };
  }
  if (localPart.includes("@")) {
    return { ok: false, reason: "at_in_local_part" };
  }
  if (domain.length === 0) {
    return { ok: false, reason: "empty_domain" };
  }
  if (!ASCII_PATTERN.test(localPart) || !ASCII_PATTERN.test(domain)) {
    return { ok: false, reason: "non_ascii" };
  }
  const canonicalDomain = domain.replace(/\.$/, "").toLowerCase();
  if (canonicalDomain.length === 0) {
    return { ok: false, reason: "empty_domain" };
  }
  return { ok: true, canonical: `${localPart.toLowerCase()}@${canonicalDomain}` };
}

/** 规范化邮箱（身份键）schema：字符串输入，规范化失败即校验失败。 */
export const CanonicalEmailSchema = z
  .string()
  .transform((value, ctx): string => {
    const result = canonicalizeEmail(value);
    if (!result.ok) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: `邮箱身份规范化失败：${result.reason}（主方案 §4.1）`,
      });
      return z.NEVER;
    }
    return result.canonical;
  })
  .brand<"CanonicalEmail">();

/** 品牌类型：身份键不得与展示用投递地址混用。 */
export type CanonicalEmail = z.output<typeof CanonicalEmailSchema>;
