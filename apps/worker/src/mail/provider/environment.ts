import { fromHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import type { SendDeps } from "../outbox/send";
import { environmentUnsubscribe } from "../unsubscribe/environment";
import { mailAvailable, pauseMail } from "./availability";
import { NativeMailProvider } from "./native";
import type { NativeMailBinding } from "./types";

interface MailEnvironment {
  AUTH_MAIL_FROM?: string;
  BIZ_MAIL_FROM?: string;
  SITE_ORIGIN?: string;
  CRYPTO_MASTER_SECRET?: string;
  CRYPTO_OTP_PEPPER?: string;
  CRYPTO_UNSUBSCRIBE_KEY_ID?: string;
}
/** 发信绑定必须真的挂上：先开邮件开关、后绑发信服务时，不能先生成验证码、占额度再永远发不出去。 */
function sendBindingAttached(binding: unknown): boolean {
  return typeof (binding as { send?: unknown } | null | undefined)?.send === "function";
}
export function mailConfigured(env: Env & MailEnvironment): boolean {
  try {
    return (
      sendBindingAttached(env.AUTH_MAILER) &&
      sendBindingAttached(env.BIZ_MAILER) &&
      !!env.AUTH_MAIL_FROM &&
      !!env.BIZ_MAIL_FROM &&
      !!env.SITE_ORIGIN &&
      new URL(env.SITE_ORIGIN).protocol === "https:" &&
      !!env.CRYPTO_MASTER_SECRET &&
      !!env.CRYPTO_OTP_PEPPER &&
      !!env.CRYPTO_UNSUBSCRIBE_KEY_ID
    );
  } catch {
    return false;
  }
}
export const environmentMailAvailable = (env: Env & MailEnvironment) =>
  mailConfigured(env) ? mailAvailable(env.DB) : Promise.resolve(false);
export function mailDependencies(env: Env & MailEnvironment): SendDeps {
  let keys: Promise<Keyring> | undefined;
  return {
    db: env.DB,
    unsubscribe: environmentUnsubscribe(env),
    origin: env.SITE_ORIGIN ?? "",
    available: () => environmentMailAvailable(env),
    pause: () => pauseMail(env.DB, Date.now()),
    fieldKey: async () => {
      const master = fromHex(env.CRYPTO_MASTER_SECRET ?? ""),
        pepper = fromHex(env.CRYPTO_OTP_PEPPER ?? "");
      if (!master || !pepper) throw new Error("mail_keys_unconfigured");
      keys ??= Keyring.create({
        masterSecret: master,
        otpPepper: pepper,
        unsubscribeMacCurrentKeyId: env.CRYPTO_UNSUBSCRIBE_KEY_ID ?? "",
      });
      return (await keys).fieldEncryption();
    },
    provider: new NativeMailProvider({
      // 结构化 send 的运行时接口来自 [R05]；不升级锁定 Wrangler/生成类型。
      auth: env.AUTH_MAILER as unknown as NativeMailBinding,
      business: env.BIZ_MAILER as unknown as NativeMailBinding,
      authSender: env.AUTH_MAIL_FROM ?? "",
      businessSender: env.BIZ_MAIL_FROM ?? "",
    }),
  };
}
// 提交后只尽力安排持久 alarm；失败由 Cron 从 D1 恢复，不靠 waitUntil 保证投递。
export async function wakeDelivery(env: Env): Promise<void> {
  try {
    await env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName("main")).fetch(
      "https://delivery.internal/wake",
      { method: "POST" },
    );
  } catch {
    /* Cron 补唤醒 */
  }
}
