import type { MailIntentKind, MailPool } from "@hoyo/contracts";
import type { AudienceRow, OccurrenceMatch } from "../occurrences/eligibility";

export interface DispatchCandidate extends OccurrenceMatch {
  delivery_id: string;
  user_id: string;
  user_order: number;
  delivery_kind: string;
  priority: number;
  delivery_expires_at: number;
  delivery_schedule_revision: number;
  target_ref: string;
  channel: string;
}
export interface DispatchContext {
  audience: AudienceRow | null;
  interests: {
    game: string;
    region: string;
    interest_kind: string;
    interest_id: string;
    enabled_at: number;
  }[];
  candidates: DispatchCandidate[];
}
export interface DispatchProposal {
  batchId: string;
  userId: string;
  order: number;
  priority: number;
  pool: MailPool;
  intent: MailIntentKind;
  /** 仅服务端 ID；正文由 P4-03 按引用读取，不存邮箱或个人 URL。 */
  deliveryIds: string[];
  supersededIds: string[];
  lastOrder: number;
  completedLap: number;
  snapshot: string;
  selectedAt: number;
}
export type DispatchSelection =
  | { outcome: "expanding" | "empty" | "advanced" }
  | { outcome: "candidate"; proposal: DispatchProposal };
