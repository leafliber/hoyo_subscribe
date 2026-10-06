// P6-02 · DeliveryDO 侧的 Push 依赖（ADR-0025）：字段密钥只用于解开端点与密钥密文；
// VAPID 配置缺失时外发路径整体不可用（runPushPass 直接返回），不降级。
import { fromHex } from "../storage/crypto/bytes";
import { Keyring } from "../storage/crypto/keyring";
import { type PushEnvironment, pushConfiguration } from "./config";
import type { PushSendDeps } from "./delivery";

export function pushDependencies(env: Env & PushEnvironment): PushSendDeps {
  let keys: Promise<Keyring> | undefined;
  return {
    db: env.DB,
    config: () => pushConfiguration(env),
    transport: (input, init) => fetch(input, init),
    keys: () => {
      const master = fromHex(env.CRYPTO_MASTER_SECRET ?? "");
      const pepper = fromHex(env.CRYPTO_OTP_PEPPER ?? "");
      if (!master || !pepper) return Promise.reject(new Error("push_keys_unconfigured"));
      keys ??= Keyring.create({
        masterSecret: master,
        otpPepper: pepper,
        unsubscribeMacCurrentKeyId: env.CRYPTO_UNSUBSCRIBE_KEY_ID ?? "",
      });
      return keys;
    },
  };
}
