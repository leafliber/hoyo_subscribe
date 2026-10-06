// P6 · Push 部署配置（ADR-0025）：VAPID 私钥是独立部署秘密，站点源用作 VAPID sub 与站内链接。
// 配置缺失或不合法时一律视为"未配置"：公开能力不显示开放，写入与外发失败关闭，不降级。
import { logEvent } from "../shell/logger";
import { importVapidKeys, type VapidKeys } from "./crypto";

export interface PushEnvironment {
  /** JSON Web Key（kty=EC、crv=P-256、x、y、d）；Wrangler secret，见 scripts/push/generate-vapid.mjs。 */
  readonly PUSH_VAPID_PRIVATE_JWK?: string;
  readonly SITE_ORIGIN?: string;
  readonly CRYPTO_MASTER_SECRET?: string;
  readonly CRYPTO_OTP_PEPPER?: string;
  readonly CRYPTO_UNSUBSCRIBE_KEY_ID?: string;
}

export interface PushConfig {
  readonly vapid: VapidKeys;
  /** VAPID sub：站点 https 源（RFC 8292 §2.1 允许 https URI 作为联系方式）。 */
  readonly subject: string;
}

const cache = new WeakMap<object, Promise<PushConfig | null>>();

/** 每个隔离实例导入一次；字段密钥另由 Keyring 提供，三个根秘密缺一即未配置。 */
export function pushConfiguration(env: PushEnvironment): Promise<PushConfig | null> {
  let promise = cache.get(env);
  if (promise === undefined) {
    promise = (async () => {
      if (
        !env.PUSH_VAPID_PRIVATE_JWK ||
        !env.SITE_ORIGIN ||
        !env.CRYPTO_MASTER_SECRET ||
        !env.CRYPTO_OTP_PEPPER ||
        !env.CRYPTO_UNSUBSCRIBE_KEY_ID
      )
        return null;
      let origin: URL;
      try {
        origin = new URL(env.SITE_ORIGIN);
      } catch {
        return null;
      }
      if (origin.protocol !== "https:") return null;
      try {
        return { vapid: await importVapidKeys(env.PUSH_VAPID_PRIVATE_JWK), subject: origin.origin };
      } catch {
        // 只记固定原因码；JWK 内容、错误原文都不落盘。
        logEvent("error", "push_config_invalid", { reason_code: "vapid_key" });
        return null;
      }
    })();
    cache.set(env, promise);
  }
  return promise;
}

export async function pushConfigured(env: PushEnvironment): Promise<boolean> {
  return (await pushConfiguration(env)) !== null;
}
