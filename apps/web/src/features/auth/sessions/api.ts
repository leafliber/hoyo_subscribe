import { isApiErrorBody } from "@hoyo/contracts";
import { csrfToken, object } from "../api";

/** DELETE also uses the current session CSRF cookie, never a cached token. */
export async function revokeSession(id: string): Promise<void> {
  const response = await fetch(`/api/v2/me/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken() },
    body: "{}",
  });
  const body: unknown = await response.json();
  if (isApiErrorBody(body)) throw body;
  if (response.status !== 200 || !object(body) || body.revoked !== true) {
    throw new Error("unknown_result");
  }
}
