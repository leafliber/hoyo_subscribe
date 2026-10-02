import type { UnsubscribeMacKeys } from "@hoyo/contracts";
import { fromBase64Url, toBase64Url, utf8Encode } from "../../storage/crypto/bytes";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../../storage/crypto/unsubscribe";

// 首版业务信共用一个业务列表，退订同时关闭席位与常规层；不影响认证邮件。
// scope 属本协议的固定标识，绝不绑定同意版本、时间或单封邮件。
const LIST_SCOPE = "business";
export async function issueUnsubscribeToken(
  keys: UnsubscribeMacKeys,
  bindingId: string,
): Promise<string> {
  const payload = toBase64Url(utf8Encode(bindingId));
  if (!bindingId || bindingId.includes("@")) throw new Error("invalid_binding_id");
  return `${payload}.${LIST_SCOPE}.${await signUnsubscribeToken(keys, { emailBindingId: bindingId, listScope: LIST_SCOPE })}`;
}
export async function resolveUnsubscribeToken(
  keys: UnsubscribeMacKeys,
  token: string,
): Promise<string | null> {
  const [payload, scope, ...mac] = token.split(".");
  if (!payload || scope !== LIST_SCOPE || mac.length !== 3) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes || toBase64Url(bytes) !== payload) return null;
  let bindingId: string;
  try {
    bindingId = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!bindingId || bindingId.includes("@")) return null;
  const result = await verifyUnsubscribeToken(keys, mac.join("."), {
    emailBindingId: bindingId,
    listScope: LIST_SCOPE,
  });
  return result.ok ? bindingId : null;
}
export async function unsubscribeLinks(
  keys: UnsubscribeMacKeys,
  origin: string,
  bindingId: string,
) {
  const site = new URL(origin);
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.pathname !== "/" ||
    site.search ||
    site.hash
  )
    throw new Error("invalid_unsubscribe_origin");
  const token = await issueUnsubscribeToken(keys, bindingId);
  return {
    page: `${site.origin}/unsubscribe/${token}`,
    oneClick: `${site.origin}/email/one-click/${token}`,
  };
}
