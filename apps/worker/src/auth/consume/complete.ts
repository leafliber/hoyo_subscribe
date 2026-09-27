// P2-03 · POST /api/v2/auth/complete（主方案 §4.4）。
// 原 preauth + 操作幂等键领取同一 pending 会话 Cookie；请求不收 challenge_id，
// 回执密文内还绑定 pending_session_id，且 pending/有效期均从数据库主状态核对。

import { ApiError, jsonResponse, parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "../preauth/cookie";
import { requireOperationKey } from "./operation";
import { decryptCompletionReceipt } from "./receipt";
import { serializePendingSessionCookie } from "./session";

interface ReceiptRow {
  readonly id: string;
  readonly preauth_id: string;
  readonly pending_session_id: string;
  readonly receipt_ciphertext: ArrayBuffer | Uint8Array;
  readonly receipt_expires_at: number;
  readonly state: string;
  readonly expires_at: number;
}

export interface CompleteAuthDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  readonly now: () => number;
}

function noReceipt(): ApiError {
  return new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
}

export async function runCompleteAuth(deps: CompleteAuthDeps, request: Request): Promise<Response> {
  const now = deps.now();
  const operationKey = requireOperationKey(request);
  const preauthValue = parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  if (preauthValue === undefined) throw noReceipt();
  const preauth = await verifyPreauthCookieValue(deps.keys.preauthCookie(), preauthValue, now);
  if (!preauth.ok) throw noReceipt();

  const candidates = await deps.db
    .prepare(
      `SELECT c.id, c.preauth_id, c.pending_session_id, c.receipt_ciphertext,
              c.receipt_expires_at, s.state, s.expires_at
         FROM auth_challenges c JOIN sessions s ON s.id = c.pending_session_id
        WHERE c.preauth_id = ? AND c.receipt_ciphertext IS NOT NULL
          AND c.receipt_expires_at > ? AND s.state = 'pending' AND s.expires_at > ?`,
    )
    .bind(preauth.context.preauthId, now, now)
    .all<ReceiptRow>();
  let match: ReceiptRow | null = null;
  let cookieValue: string | null = null;
  for (const row of candidates.results ?? []) {
    const receipt = await decryptCompletionReceipt(
      deps.keys.fieldEncryption(),
      row.id,
      row.receipt_ciphertext,
    );
    if (
      receipt.preauthId !== row.preauth_id ||
      receipt.pendingSessionId !== row.pending_session_id ||
      receipt.operationKey !== operationKey
    ) {
      continue;
    }
    if (match !== null) throw noReceipt(); // 重复操作键跨挑战歧义，失败关闭。
    match = row;
    cookieValue = receipt.cookieValue;
  }
  if (match === null || cookieValue === null) throw noReceipt();

  const response = jsonResponse({ completed: true, pending_session_id: match.pending_session_id });
  response.headers.append("set-cookie", serializePendingSessionCookie(cookieValue));
  response.headers.set("cache-control", "no-store");
  return response;
}
