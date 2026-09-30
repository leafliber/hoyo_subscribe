import { FEEDBACK_BATCH, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { logEvent } from "../../shell/logger";
import { fromHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import { FEEDBACK_QUEUE, type FeedbackTrust, parseFeedback } from "./schema";
import { type FeedbackKeys, ingestFeedback, pruneFeedbackPage } from "./store";

export interface FeedbackDeps {
  db: D1Database;
  trust: FeedbackTrust;
  keys: () => Promise<FeedbackKeys>;
  now: () => number;
}
export async function consumeFeedback(
  batch: MessageBatch<unknown>,
  deps: FeedbackDeps,
): Promise<void> {
  if (batch.queue !== FEEDBACK_QUEUE || batch.messages.length > FEEDBACK_BATCH) {
    batch.retryAll({ delaySeconds: WATCHDOG_INTERVAL });
    return;
  }
  // 每条独立失败，坏事件不阻断同批其他回执；不记录 body、Error.message 或地址。
  for (const message of batch.messages) {
    try {
      const event = parseFeedback(message.body, deps.trust);
      const done = await ingestFeedback(deps.db, event, await deps.keys(), deps.now());
      if (done) message.ack();
      else message.retry({ delaySeconds: WATCHDOG_INTERVAL });
    } catch {
      logEvent("error", "mail_feedback_failed", { reason_code: "feedback_retry" });
      // 即使最后一次也不 ack：平台按注册表派生的 max_retries 投入 DLQ。
      message.retry({ delaySeconds: WATCHDOG_INTERVAL });
    }
  }
  try {
    await pruneFeedbackPage(deps.db, deps.now());
  } catch {
    logEvent("error", "mail_feedback_cleanup_failed", { reason_code: "feedback_cleanup" });
  }
}
interface FeedbackEnv {
  DB: D1Database;
  MAIL_FEEDBACK_ACCOUNT_ID?: string;
  MAIL_FEEDBACK_SUBSCRIPTIONS?: string;
  CRYPTO_MASTER_SECRET?: string;
  CRYPTO_OTP_PEPPER?: string;
  CRYPTO_UNSUBSCRIBE_KEY_ID?: string;
}
export async function queue(batch: MessageBatch<unknown>, env: FeedbackEnv): Promise<void> {
  try {
    const subscriptions: unknown = JSON.parse(env.MAIL_FEEDBACK_SUBSCRIPTIONS ?? "null");
    if (
      !Array.isArray(subscriptions) ||
      !subscriptions.length ||
      subscriptions.some(
        (s: unknown) =>
          typeof s !== "object" ||
          s === null ||
          !("id" in s) ||
          !("domain" in s) ||
          typeof s.id !== "string" ||
          !s.id ||
          typeof s.domain !== "string" ||
          !s.domain,
      )
    )
      throw new Error("feedback_config");
    await consumeFeedback(batch, {
      db: env.DB,
      now: Date.now,
      trust: { accountId: env.MAIL_FEEDBACK_ACCOUNT_ID ?? "", subscriptions },
      keys: async () => {
        const masterSecret = fromHex(env.CRYPTO_MASTER_SECRET ?? "");
        const otpPepper = fromHex(env.CRYPTO_OTP_PEPPER ?? "");
        if (!masterSecret || !otpPepper || !env.CRYPTO_UNSUBSCRIBE_KEY_ID)
          throw new Error("feedback_keys");
        const ring = await Keyring.create({
          masterSecret,
          otpPepper,
          unsubscribeMacCurrentKeyId: env.CRYPTO_UNSUBSCRIBE_KEY_ID,
        });
        return { lookup: ring.emailLookup(), field: ring.fieldEncryption() };
      },
    });
  } catch {
    logEvent("error", "mail_feedback_failed", { reason_code: "feedback_configuration" });
    batch.retryAll({ delaySeconds: WATCHDOG_INTERVAL });
  }
}
