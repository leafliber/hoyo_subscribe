import { isApiErrorBody } from "@hoyo/contracts";

export type Json = Record<string, unknown>;
export type Reply = { status: number; body: Json };
export function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function csrfToken(): string {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("__Host-hoyo_csrf="))
      ?.slice("__Host-hoyo_csrf=".length) ?? ""
  );
}

// No persisted credentials or operation keys. Aborting a request leaves its result unknown.
export async function request(
  path: string,
  body?: Json,
  key?: string,
  signal?: AbortSignal,
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (body) {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] = csrfToken(); // Always read immediately before a write (including retries).
  }
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`/api/v2/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const value: unknown = await response.json();
  if (isApiErrorBody(value)) {
    // Activation conflicts also carry the authoritative replacement list.
    if (response.status !== 409 || !object(value) || value.selection_required !== true) throw value;
  }
  if (!object(value)) throw new Error("unknown_result");
  return { status: response.status, body: value };
}

export interface Session {
  id: string;
  label: string;
  created_at: number;
  renewed_at: number;
  is_current: boolean;
  state: "pending" | "active";
}
export function sessions(value: unknown): Session[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(
    (row: unknown) =>
      object(row) &&
      typeof row.id === "string" &&
      row.id.length > 0 &&
      typeof row.label === "string" &&
      Number.isSafeInteger(row.created_at) &&
      Number.isSafeInteger(row.renewed_at) &&
      typeof row.is_current === "boolean" &&
      (row.state === "pending" || row.state === "active"),
  )
    ? (value as Session[])
    : null;
}
