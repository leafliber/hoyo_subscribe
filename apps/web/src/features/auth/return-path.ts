// Exact local destinations only: never preserve arbitrary queries, credentials or encoded paths.
const destinations = new Set([
  "/",
  "/subscription",
  "/account",
  "/recover",
  "/recover#save",
  "/status",
]);

export function loginReturnPath(value: string | null): string {
  return value !== null && destinations.has(value) ? value : "/subscription";
}

export const GUEST_HANDOFF_KEY = "hoyo-subscription-guest-handoff";
