// P2-03 · 短期认证完成回执（主方案 §4.4；2026-09-27 裁定）。
// AAD 记录 ID = auth_challenges.id；密文载荷再绑定 preauth_id、操作幂等键、
// pending_session_id 与唯一待交付的 __Host-session 值。challenge_id 不能单独领取。

import type { FieldEncryptionKey } from "@hoyo/contracts";
import { decryptFieldText, encryptField } from "../../storage/crypto/aead";
import { asEnvelopeBytes } from "../challenges/payload";

const RECEIPT_RECORD_TYPE = "auth-completion-receipt" as const;

export interface CompletionReceipt {
  readonly preauthId: string;
  readonly operationKey: string;
  readonly pendingSessionId: string;
  readonly cookieValue: string;
}

export async function encryptCompletionReceipt(
  key: FieldEncryptionKey,
  challengeId: string,
  receipt: CompletionReceipt,
): Promise<Uint8Array> {
  return encryptField(key, { type: RECEIPT_RECORD_TYPE, id: challengeId }, JSON.stringify(receipt));
}

export async function decryptCompletionReceipt(
  key: FieldEncryptionKey,
  challengeId: string,
  ciphertext: ArrayBuffer | Uint8Array,
): Promise<CompletionReceipt> {
  const text = await decryptFieldText(
    key,
    { type: RECEIPT_RECORD_TYPE, id: challengeId },
    asEnvelopeBytes(ciphertext),
  );
  const value = JSON.parse(text) as Partial<CompletionReceipt>;
  if (
    typeof value.preauthId !== "string" ||
    typeof value.operationKey !== "string" ||
    typeof value.pendingSessionId !== "string" ||
    typeof value.cookieValue !== "string"
  ) {
    throw new Error("认证完成回执字段不完整");
  }
  return value as CompletionReceipt;
}
