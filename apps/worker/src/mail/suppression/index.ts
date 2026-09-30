// P4-07：只写应用本地冻结，不调用平台抑制 API，不提供自动解除入口。
import type { EmailLookupKey, FieldEncryptionKey } from "@hoyo/contracts";
import { decryptDeliveryAddress, deliveryAddressForm } from "../../auth/challenges/delivery";
import { computeEmailKey } from "../../storage/crypto/mac";
import type { MailRow } from "../outbox/types";

export const suppressionAddressKey = (key: EmailLookupKey, address: string) =>
  // 复用 lookup HMAC，加用途标签；本地部分大小写保留，不用账号 canonical_email。
  computeEmailKey(key, JSON.stringify(["suppression-address:v1", deliveryAddressForm(address)]));

export async function resolveFeedbackBinding(
  db: D1Database,
  row: MailRow,
  addressKey: string,
  keys: { lookup: EmailLookupKey; field: FieldEncryptionKey },
): Promise<string> {
  if (row.email_binding_id) return row.email_binding_id;
  // 历史认证 outbox 未填 binding。仅当前版本 + 实际投递地址均相同才可补关联。
  const user = await db
    .prepare("SELECT id,email_binding_id,email_version,email_ciphertext FROM users WHERE id=?")
    .bind(row.recipient_user_id)
    .first<{
      id: string;
      email_binding_id: string;
      email_version: number;
      email_ciphertext: ArrayBuffer;
    }>();
  if (user && user.email_version === row.address_version) {
    const address = await decryptDeliveryAddress(
      keys.field,
      user.id,
      new Uint8Array(user.email_ciphertext),
    );
    if ((await suppressionAddressKey(keys.lookup, address)) === addressKey)
      return user.email_binding_id;
  }
  // 保留精确地址的冻结事实，但不把缺失历史绑定猜成当前绑定。
  return `unbound:${addressKey}`;
}

export function suppressionStatements(
  db: D1Database,
  input: {
    addressKey: string;
    binding: string;
    kind: "complaint" | "hard_bounce" | "policy";
    userId: string | null;
    addressVersion: number;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    db
      .prepare(`INSERT INTO suppressions(id,address_key,email_binding_id,kind,read_only,reason,created_at,expires_at)
      SELECT ?,?,?, ?,1,'feedback_requires_verification',?,NULL WHERE changes()=1
      ON CONFLICT(address_key) DO UPDATE SET
        kind=CASE WHEN suppressions.kind='complaint' THEN suppressions.kind ELSE excluded.kind END,
        expires_at=NULL`)
      .bind(crypto.randomUUID(), input.addressKey, input.binding, input.kind, input.now),
    // 不恢复同意；只关闭仍为旧绑定/旧版本的通道，换绑竞态由 SQL 内谓词兜住。
    db
      .prepare(`UPDATE email_channels SET enabled=0,routine_enabled=0,channel_revision=channel_revision+1,updated_at=?
      WHERE changes()=1 AND user_id=? AND address_version=? AND (enabled<>0 OR routine_enabled<>0)
      AND EXISTS(SELECT 1 FROM users WHERE id=email_channels.user_id AND email_binding_id=? AND email_version=?)`)
      .bind(input.now, input.userId, input.addressVersion, input.binding, input.addressVersion),
  ];
}
