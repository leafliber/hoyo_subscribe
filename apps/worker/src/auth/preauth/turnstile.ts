// Turnstile 服务端校验（任务卡 P2-01 交付物二第 4 步；主方案 §4.2、[R09]）。
//
// 合同约束：
// - 服务端 Siteverify 校验一次性 token（[R09]）：向 Cloudflare 的 siteverify 端点提交
//   secret + response，严格绑定 success、配置 hostname 和预期 action；**网络错误、非 2xx、任何非
//   success 响应一律判失败**（失败关闭，绝不放行「没法验证就先过」）。
// - Turnstile 是**单次验证**，不替代会话或配额（§4.2）：token 用过即废由 siteverify
//   服务端保证（重放返回 timeout-or-duplicate 等失败码），本模块对一切失败一视同仁地
//   拒绝；它也不承诺证明真人唯一性（不写这类表述）。
// - 不传 remoteip：数据最小化（[R09] 的 remoteip 是可选项），IP 不参与鉴权（§8.3）。
//
// 测试不触网：verify 通过注入的替身实现（siteverify 双检重放语义）；生产实现仅在部署
// 配置注入 TURNSTILE_SECRET_KEY（Wrangler secret，「需所有者执行的前置」）后可用，
// 未注入时工厂抛错、调用方失败关闭（与 P1-08 的 CRYPTO_* 秘密同一纪律）。

import type { TurnstileAction } from "@hoyo/contracts";

/** 校验输入；token 来自请求体 turnstile_token 字段（结构校验已在第 1 步完成）。 */
export interface TurnstileCheckInput {
  readonly token: string;
  readonly expectedAction: TurnstileAction;
}

export type TurnstileCheckResult = "passed" | "failed";

/** Turnstile 校验器接口（pipeline 第 4 步消费；测试注入单次有效/重放失败的替身）。 */
export interface TurnstileVerifier {
  verify(input: TurnstileCheckInput): Promise<TurnstileCheckResult>;
}

/** Cloudflare Siteverify 端点（[R09] 官方文档固定地址，非业务参数）。 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 只信任部署配置，不接受请求 Host/Origin 或浏览器提交的允许域名。 */
function configuredHostname(siteOrigin: string): string {
  const url = new URL(siteOrigin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  )
    throw new Error("SITE_ORIGIN 非有效正式站点来源；Turnstile 校验失败关闭");
  return url.hostname;
}

/** 生产校验器：真实调用 siteverify；形状、绑定与上游故障均失败关闭。 */
export function siteverifyTurnstileVerifier(secret: string, siteOrigin: string): TurnstileVerifier {
  if (secret.trim().length === 0) {
    throw new Error("TURNSTILE_SECRET_KEY 未注入（Wrangler secret）；Turnstile 校验失败关闭");
  }
  const hostname = configuredHostname(siteOrigin);
  return {
    async verify(input) {
      try {
        const body = new FormData();
        body.set("secret", secret);
        body.set("response", input.token);
        const response = await fetch(SITEVERIFY_URL, { method: "POST", body });
        if (!response.ok) return "failed";
        const parsed: unknown = await response.json();
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "failed";
        if (!("success" in parsed) || !("hostname" in parsed) || !("action" in parsed))
          return "failed";
        return parsed.success === true &&
          typeof parsed.hostname === "string" &&
          parsed.hostname === hostname &&
          typeof parsed.action === "string" &&
          parsed.action === input.expectedAction
          ? "passed"
          : "failed";
      } catch {
        return "failed";
      }
    },
  };
}
