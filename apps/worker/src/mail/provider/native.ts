// [R05] https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
// 未知异常（包括内部错误/连接中断）不等于明确未接受；不转发异常 message。
import type { MailProvider, MailResult, NativeMailBinding, ServerMail } from "./types";

const definiteRejections = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);
export class NativeMailProvider implements MailProvider {
  constructor(
    private readonly config: {
      auth: NativeMailBinding;
      business: NativeMailBinding;
      authSender: string;
      businessSender: string;
    },
  ) {}
  async send(mail: ServerMail): Promise<MailResult> {
    try {
      const auth = mail.channel === "auth";
      const result = await (auth ? this.config.auth : this.config.business).send({
        from: auth ? this.config.authSender : this.config.businessSender,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // 认证永远不附退订头，即使调用方错误地传入 unsubscribe。
        ...(!auth && mail.unsubscribe
          ? {
              headers: {
                "List-Unsubscribe": `<${mail.unsubscribe.oneClick}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
      });
      return typeof result?.messageId === "string" && result.messageId.length > 0
        ? { kind: "accepted", messageId: result.messageId }
        : { kind: "unknown", reason: "missing_message_id", pause: false };
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? error.code : null;
      if (typeof code !== "string" || !definiteRejections.has(code))
        return { kind: "unknown", reason: "provider_result_unknown", pause: false };
      const retryable = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
      return {
        kind: "rejected",
        retryable,
        reason: code,
        pause:
          retryable || code === "E_SENDER_NOT_VERIFIED" || code === "E_SENDER_DOMAIN_NOT_AVAILABLE",
      };
    }
  }
}
