import type { DeliveryStatus, MailPool } from "@hoyo/contracts";
export interface MailRow {
  id: string;
  purpose: MailPool;
  priority: number;
  period_key: string;
  recipient_user_id: string | null;
  email_binding_id: string | null;
  address_version: number;
  payload_kind: string;
  payload_ref: string | null;
  payload_ciphertext: ArrayBuffer | null;
  status: DeliveryStatus;
  message_id: string | null;
  lease_version: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempts: number;
  sent_at: number | null;
}
export type Invalidation = "skipped" | "superseded" | "expired";
export class MailDataError extends Error {}
export const mailJobId = (id: string) => `delivery:mail:${id}`;
