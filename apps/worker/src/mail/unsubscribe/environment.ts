import type { UnsubscribeMacKeys } from "@hoyo/contracts";
import { fromHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import { unsubscribeLinks } from "./token";

interface UnsubscribeEnvironment {
  CRYPTO_MASTER_SECRET?: string;
  CRYPTO_OTP_PEPPER?: string;
  CRYPTO_UNSUBSCRIBE_KEY_ID?: string;
  /** JSON 字符串数组；正常轮换保留旧 id，灾难撤销移除旧 id；缺省仅当前 id。 */
  CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS?: string;
  SITE_ORIGIN?: string;
}
const keyPromises = new WeakMap<object, Promise<UnsubscribeMacKeys>>();
export function unsubscribeKeys(env: UnsubscribeEnvironment): Promise<UnsubscribeMacKeys> {
  let pending = keyPromises.get(env);
  if (!pending) {
    pending = (async () => {
      const master = fromHex(env.CRYPTO_MASTER_SECRET ?? ""),
        pepper = fromHex(env.CRYPTO_OTP_PEPPER ?? "");
      if (!master || !pepper) throw new Error("unsubscribe_unconfigured");
      const accepted: unknown =
        env.CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS === undefined
          ? undefined
          : JSON.parse(env.CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS);
      if (
        accepted !== undefined &&
        (!Array.isArray(accepted) || !accepted.every((id) => typeof id === "string"))
      )
        throw new Error("unsubscribe_keys_invalid");
      return (
        await Keyring.create({
          masterSecret: master,
          otpPepper: pepper,
          unsubscribeMacCurrentKeyId: env.CRYPTO_UNSUBSCRIBE_KEY_ID ?? "",
          unsubscribeMacAcceptedKeyIds: accepted as string[] | undefined,
        })
      ).unsubscribeMac();
    })();
    keyPromises.set(env, pending);
  }
  return pending;
}
export async function unsubscribeAvailable(env: UnsubscribeEnvironment): Promise<boolean> {
  try {
    // 验证实际签发与 URL 构造能力；不存行、不输出探测 token、不外发。
    await unsubscribeLinks(await unsubscribeKeys(env), env.SITE_ORIGIN ?? "", "capability-check");
    return true;
  } catch {
    return false;
  }
}
export function environmentUnsubscribe(env: UnsubscribeEnvironment) {
  return async (bindingId: string) =>
    unsubscribeLinks(await unsubscribeKeys(env), env.SITE_ORIGIN ?? "", bindingId);
}
