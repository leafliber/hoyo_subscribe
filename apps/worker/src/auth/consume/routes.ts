// P2-03 · 2026-09-27 裁定授权的完成端点挂载定义（主方案 §4.4）。
// 外壳继续负责结构、Origin 与绑定 preauth_id 的 CSRF；业务层核对 Cookie MAC。

import type { ShellRoute } from "../../shell";
import { parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { PREAUTH_COOKIE_NAME } from "../preauth/cookie";
import { runCompleteAuth } from "./complete";

export function makeCompleteRoute(keys: () => Promise<Keyring>): ShellRoute {
  return {
    method: "POST",
    pattern: "/api/v2/auth/complete",
    domain: "public",
    write: true,
    bodySchema: { fields: {} },
    csrfBinding: async ({ request }) =>
      parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME)?.split(".")[0] ?? "",
    handler: async (ctx) =>
      runCompleteAuth({ db: ctx.env.DB, keys: await keys(), now: () => Date.now() }, ctx.request),
  };
}
