// P2-07：最近认证证明只保存目标摘要，地址明文仅在请求与受控邮件载荷中出现。
import { canonicalizeEmail, type RecentAuthAction } from "@hoyo/contracts";
import { ApiError } from "../../shell/errors";
import { toHex, utf8Encode } from "../../storage/crypto/bytes";
import { deliveryAddressForm } from "../challenges/delivery";

export interface RecentTarget {
  readonly digest: string;
  readonly canonicalEmail?: string;
  readonly deliveryAddress?: string;
}

export async function targetForAction(
  action: RecentAuthAction,
  rawEmail?: string,
): Promise<RecentTarget> {
  let target: string;
  let canonicalEmail: string | undefined;
  let deliveryAddress: string | undefined;
  if (action === "email_change") {
    const result = canonicalizeEmail(rawEmail ?? "");
    if (!result.ok) {
      throw new ApiError("validation", {
        code: "validation",
        fields: [{ path: "target_email", reason: "canonicalization_failed" }],
      });
    }
    canonicalEmail = result.canonical;
    deliveryAddress = deliveryAddressForm(rawEmail ?? "");
    target = JSON.stringify([action, canonicalEmail, deliveryAddress]);
  } else {
    if (rawEmail !== undefined) {
      throw new ApiError("validation", {
        code: "validation",
        fields: [{ path: "target_email", reason: "unexpected_field" }],
      });
    }
    target = JSON.stringify([action]);
  }
  const digest = await crypto.subtle.digest("SHA-256", utf8Encode(target));
  return { digest: toHex(new Uint8Array(digest)), canonicalEmail, deliveryAddress };
}
