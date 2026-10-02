import {
  type AccountSummary,
  AccountSummarySchema,
  AUTH_COMPLETION_TTL,
  deriveAccountActions,
  SESSION_PENDING_TTL,
} from "@hoyo/contracts";

/** A monotonic browser clock anchored to /me, never the uncorrected wall clock. */
export class AccountFacts {
  private facts: AccountSummary | null = null;
  private readAt = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}
  accept(value: unknown): AccountSummary {
    this.facts = AccountSummarySchema.parse(value);
    this.readAt = this.clock();
    return this.facts;
  }
  clear(): void {
    this.facts = null;
  }
  get summary(): AccountSummary | null {
    return this.facts;
  }
  get now(): number {
    return (this.facts?.server_time ?? 0) + this.clock() - this.readAt;
  }
  get actions() {
    return this.facts ? deriveAccountActions(this.facts, this.now) : null;
  }
}
export type Purpose = "emergency_stop" | "recover_login";
export interface DeliveredCode {
  recovery_id: string;
  secret: string;
  rotation_id?: string;
}
export function deliveredCode(value: Record<string, unknown>): DeliveredCode {
  if (
    typeof value.recovery_id !== "string" ||
    !value.recovery_id ||
    typeof value.secret !== "string" ||
    !value.secret ||
    value.saved_confirmed !== false ||
    (value.rotation_id !== undefined && typeof value.rotation_id !== "string")
  )
    throw new Error("unknown_delivery");
  return {
    recovery_id: value.recovery_id,
    secret: value.secret,
    ...(typeof value.rotation_id === "string" ? { rotation_id: value.rotation_id } : {}),
  };
}
// Only the non-secret operation identifier survives a refresh, bound by the server to preauth.
// Credentials, proof IDs and delivered codes must never enter browser storage.
export const RECEIPT_KEY = "hoyo-recovery-receipt-operation";

type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function saveReceipt(storage: ReceiptStorage, key: string, now: number): void {
  if (!key) {
    storage.removeItem(RECEIPT_KEY);
    return;
  }
  storage.setItem(
    RECEIPT_KEY,
    JSON.stringify({
      key,
      expiresAt: now + Math.min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL) * 1000,
    }),
  );
}
export function readReceipt(storage: ReceiptStorage, now: number): string {
  try {
    const value: unknown = JSON.parse(storage.getItem(RECEIPT_KEY) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      "expiresAt" in value &&
      typeof value.key === "string" &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > now
    )
      return value.key;
  } catch {
    /* Malformed/expired non-secret receipt context is not reusable. */
  }
  storage.removeItem(RECEIPT_KEY);
  return "";
}
