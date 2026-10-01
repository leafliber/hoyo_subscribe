// P3-10：仅管理员入口使用的部署配置；秘密不进入 Env 生成物或前端。
import type { RecoverySourceGate } from "../auth/recovery/rate";
import type { Keyring } from "../storage/crypto/keyring";

export interface AdminConfiguration {
  /** Wrangler secret：SECRET_BITS 位随机数的十六进制编码。 */
  readonly ADMIN_BOOTSTRAP_SECRET?: string;
  /** 可选 Access 团队 issuer，例如 https://team.cloudflareaccess.com。 */
  readonly ADMIN_ACCESS_ISSUER?: string;
  /** 仅保护 /api/v2/admin/* 的 Access 应用 AUD。 */
  readonly ADMIN_ACCESS_AUD?: string;
}

export interface AdminDependencies {
  readonly keys: () => Promise<Keyring>;
  readonly config: AdminConfiguration;
  readonly sourceGate: RecoverySourceGate;
  readonly now?: () => number;
  readonly fetchKeys?: typeof fetch;
}
