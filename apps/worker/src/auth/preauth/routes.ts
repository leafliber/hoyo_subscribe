// POST /api/v2/auth/preauth：同源初始化预认证上下文（任务卡 P2-01 交付物一；§4.3 前半、§8.2）。
//
// 合同约束：
// - 同源初始化 `__Host-preauth`（Secure、HttpOnly、SameSite=Lax、Path=/、不设 Domain）；
//   预认证 CSRF 与该 Cookie 绑定（绑定值 = preauth_id，P1-08 csrf 的预认证绑定语义）。
// - Cookie 携带服务端认证的签发/截止信息（cookie.ts：CsrfKey + 独立域标签 MAC）。
// - 不同标签页复用同一个未失效随机值（§4.3）：请求已携带有效 Cookie 时不换新值，
//   只重发同一值并补发绑定同一 preauth_id 的 CSRF。续期（同值延截止）属 P2-02。
// - 本端点不写任何长期用户数据（§8.2），请求体必须是空 JSON 对象（未知字段拒绝）。
// - 本端点是 CSRF 的签发方：csrf: false（P1-08 约定：验证从下一次请求开始）。

import type { ShellRoute } from "../../shell";
import { CSRF_COOKIE_NAME, jsonResponse, mintCsrfToken, parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { generateSecretToken } from "../../storage/crypto/random";
import {
  mintPreauthCookieValue,
  PREAUTH_COOKIE_NAME,
  serializePreauthSetCookie,
  verifyPreauthCookieValue,
} from "./cookie";

export interface PreauthRouteDeps {
  /** 密钥环提供方（index.ts 传入 getKeyring；构造失败时写路由失败关闭）。 */
  readonly keys: () => Promise<Keyring>;
}

/** CSRF 双提交 Cookie 的序列化（非 HttpOnly：页面须读回放头；其余属性与 preauth 同族）。 */
function serializeCsrfSetCookie(value: string, maxAgeSeconds: number): string {
  return `${CSRF_COOKIE_NAME}=${value}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function remainingSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.floor((expiresAt - now) / 1_000));
}

/** 造预认证初始化路由。 */
export function makePreauthInitRoute(deps: PreauthRouteDeps): ShellRoute {
  return {
    method: "POST",
    pattern: "/api/v2/auth/preauth",
    domain: "public",
    write: true,
    csrf: false,
    bodySchema: { fields: {} },
    handler: async (ctx) => {
      const keys = await deps.keys();
      const now = Date.now();

      // 已携带有效预认证 Cookie：复用同一个未失效随机值（§4.3 多标签页条款）。
      const existing = parseCookieHeader(ctx.request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
      let preauthValue: string;
      let preauthId: string;
      let maxAge: number;
      if (existing !== undefined) {
        const verified = await verifyPreauthCookieValue(keys.preauthCookie(), existing, now);
        if (verified.ok) {
          preauthValue = existing;
          preauthId = verified.context.preauthId;
          maxAge = remainingSeconds(verified.context.expiresAt, now);
          return finalize(keys, preauthValue, preauthId, maxAge);
        }
      }
      const minted = await mintPreauthCookieValue(keys.preauthCookie(), now);
      preauthValue = minted.value;
      preauthId = minted.context.preauthId;
      maxAge = remainingSeconds(minted.context.expiresAt, now);
      return finalize(keys, preauthValue, preauthId, maxAge);
    },
  };
}

async function finalize(
  keys: Keyring,
  preauthValue: string,
  preauthId: string,
  maxAge: number,
): Promise<Response> {
  const csrfToken = await mintCsrfToken(keys.csrf(), preauthId, generateSecretToken().bytes);
  const response = jsonResponse({ csrf_token: csrfToken });
  response.headers.append("set-cookie", serializePreauthSetCookie(preauthValue, maxAge));
  response.headers.append("set-cookie", serializeCsrfSetCookie(csrfToken, maxAge));
  return response;
}
