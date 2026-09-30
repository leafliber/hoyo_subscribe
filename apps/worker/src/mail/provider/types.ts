// P4-03 · 原生 binding 适配契约；只允许服务端构造的一位收件人和固定模板。
export interface ServerMail {
  readonly channel: "auth" | "business";
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly unsubscribe?: { readonly page: string; readonly oneClick: string };
}
export type MailResult =
  | { readonly kind: "accepted"; readonly messageId: string }
  | {
      readonly kind: "rejected";
      readonly retryable: boolean;
      readonly reason: string;
      readonly pause: boolean;
    }
  | { readonly kind: "unknown"; readonly reason: string; readonly pause: false };
export interface MailProvider {
  send(mail: ServerMail): Promise<MailResult>;
}
// 仅描述当前 Cloudflare structured send API；仓库锁定的生成类型仍是旧版 EmailMessage API。
export interface NativeMailBinding {
  send(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}
