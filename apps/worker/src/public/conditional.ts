// ADR-0032 · 公开读取的条件请求：ETag 取响应内容去掉 `cache` 字段后的摘要（`cache.generatedAt`
// 每次都是"现在"，不能参与比较）；请求带 If-None-Match 且一致时回 304、不带正文。
// 页面用它在站内切换、返回时确认副本仍是最新，内容没变就不再下载整份数据。
// 只作用于 200 的公开 JSON；错误、私人与能力型响应不经过这里。
import { toHex } from "../storage/crypto/bytes";

const encoder = new TextEncoder();

/** 弱校验器：语义相同（只有 cache 字段不同）的两次响应得到同一个值。 */
export async function publicEtag(body: Record<string, unknown>): Promise<string> {
  const { cache: _cache, ...stable } = body;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(stable)));
  return `W/"${toHex(new Uint8Array(digest)).slice(0, 32)}"`;
}

/** RFC 9110 §13.1.2：If-None-Match 用弱比较；`*` 也算命中。 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const opaque = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || opaque(value) === opaque(etag);
  });
}

/** 给公开读取的 200 响应加 ETag；条件请求命中时回 304。 */
export async function conditionalPublic(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200) return response;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, response);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return new Response(text, response);
  const etag = await publicEtag(body as Record<string, unknown>);
  const headers = new Headers(response.headers);
  headers.set("etag", etag);
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    headers.delete("content-type");
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}
