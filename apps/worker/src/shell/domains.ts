// 权限域隔离骨架（任务卡 P1-08 交付物六；主方案 §8.3 末段）。
//
// 合同原文："普通用户与管理员会话分离。"本卡只交付骨架：会话形状、Cookie 名分离、
// 路由域守卫与所有权派生；具体鉴权（会话签发/校验、管理员高强度引导）属 P2/P5。
//
// 设计要点：
// - 两域会话是**不同形状**（user 会话带 userId，admin 会话带 adminId）——类型上
//   就不能把管理员会话当用户会话用，反之亦然。
// - Cookie 名不同且都带 __Host- 前缀；路由按 domain 声明所需会话域，守卫
//   （router）拒绝域不匹配的会话（wrong_domain），普通用户会话打不开 /admin/*，
//   管理员会话也不是任何普通用户的身份。
// - 能力型鉴权（Feed token、退订 token、receipt）与两域会话完全正交：kind
//   "capability" 不携带任何用户身份，不可能被当成会话。

/** 会话权限域（§8.3：普通用户 / 管理员，二者不通用）。 */
export type SessionDomain = "user" | "admin";

/** 路由声明的鉴权域。 */
export type RouteDomain =
  | "public" // 无域要求（含 preauth 阶段端点；绑定语义由具体路由自负）
  | "user" // 需要普通用户会话；所有权由服务端从会话派生
  | "admin" // 需要管理员会话（/api/v2/admin/*）
  | "capability"; // 能力型端点（Feed 等）：自己的窄合同，不吃 Cookie 会话

/** 普通用户会话 Cookie 名（P2 会话签发时使用；__Host-：仅 HTTPS、无 Domain）。 */
export const USER_SESSION_COOKIE_NAME = "__Host-hoyo_session";

/** 管理员会话 Cookie 名——与用户会话物理分离（§8.3）。 */
export const ADMIN_SESSION_COOKIE_NAME = "__Host-hoyo_admin_session";

/** 请求的鉴权结果（骨架：由 Authenticator 产生；P2 提供真实实现）。 */
export type ShellAuth =
  | { readonly kind: "session"; readonly domain: "user"; readonly userId: string }
  | { readonly kind: "session"; readonly domain: "admin"; readonly adminId: string }
  | { readonly kind: "capability" }
  | { readonly kind: "none" };

/** 鉴权器接口：按路由域解析请求身份。实现属 P2；测试注入桩。 */
export interface Authenticator {
  authenticate(request: Request, routeDomain: RouteDomain): Promise<ShellAuth>;
}

/**
 * 从鉴权结果派生所有者（§8.2"所有权由服务端派生"）：只有 user 域会话有 owner；
 * 管理员会话、能力 token、无身份都派生不出 owner——它们各自走自己的窄合同。
 */
export function deriveOwnerUserId(auth: ShellAuth): string | null {
  return auth.kind === "session" && auth.domain === "user" ? auth.userId : null;
}
