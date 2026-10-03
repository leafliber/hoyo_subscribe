import { type CalendarAction, calendarViewSchema, isApiErrorBody } from "@hoyo/contracts";
import { csrfToken } from "../../subscription/save/machine";

export class CalendarRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super("calendar_request_failed");
  }
}
export async function request(
  path: string,
  signal: AbortSignal,
  body?: unknown,
  key?: string,
): Promise<unknown> {
  const response = await fetch(`/api/v2/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body
      ? {
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken() ?? "",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new CalendarRequestError(response.status, value);
  return value;
}
export async function readCalendar(signal: AbortSignal) {
  return calendarViewSchema.parse(await request("me/calendar", signal));
}
export interface Operation {
  action: CalendarAction;
  key: string;
  body: {
    confirmed: true;
    expected_generation: number;
    expected_revision?: number;
    publication_generation?: number;
  };
}
export function errorDetail(error: unknown): Record<string, unknown> {
  const body = error instanceof CalendarRequestError ? error.body : null;
  return isApiErrorBody(body) ? { ...body.error.details } : {};
}
