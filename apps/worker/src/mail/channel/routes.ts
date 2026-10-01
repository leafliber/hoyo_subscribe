import { API_ERROR_STATUS } from "@hoyo/contracts";
import type { ShellAuth } from "../../shell/domains";
import { ApiError, jsonResponse } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import type { Keyring } from "../../storage/crypto/keyring";
import { EmailChannelRefusalError, type EmailChannelUpdate, updateEmailChannel } from "./service";
import { readEmailChannel } from "./view";

function user(auth: ShellAuth) {
  if (auth.kind !== "session" || auth.domain !== "user")
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  return auth;
}
function noStore(body: unknown, status = 200) {
  const response = jsonResponse(body, status);
  response.headers.set("cache-control", "no-store");
  return response;
}
export function makeEmailChannelRoutes(deps: {
  keys: () => Promise<Keyring>;
  now?: () => number;
  sendingAvailable?: () => Promise<boolean | "unknown">;
}): readonly ShellRoute[] {
  const now = deps.now ?? Date.now;
  return [
    {
      method: "GET",
      pattern: "/api/v2/me/email-channel",
      domain: "user",
      write: false,
      handler: async (ctx) =>
        noStore(
          await readEmailChannel(
            { db: ctx.env.DB, keys: await deps.keys(), sendingAvailable: deps.sendingAvailable },
            user(ctx.auth),
            now(),
          ),
        ),
    },
    {
      method: "PUT",
      pattern: "/api/v2/me/email-channel",
      domain: "user",
      write: true,
      csrfBinding: ({ auth }) => Promise.resolve(user(auth).sessionTokenHash),
      bodySchema: {
        fields: {
          enabled: { type: "boolean", optional: true },
          routine_enabled: { type: "boolean", optional: true },
          expected_revision: { type: "number", optional: true },
          email_version: { type: "number", optional: true },
          subscription_revision: { type: "number", optional: true },
          seat_consent_version: { type: "number", optional: true },
          routine_consent_version: { type: "number", optional: true },
        },
      },
      handler: async (ctx) => {
        try {
          return noStore(
            await updateEmailChannel(
              { db: ctx.env.DB, keys: await deps.keys(), sendingAvailable: deps.sendingAvailable },
              user(ctx.auth),
              ctx.body as EmailChannelUpdate,
              now(),
            ),
          );
        } catch (error) {
          if (error instanceof EmailChannelRefusalError)
            return noStore(error.body, API_ERROR_STATUS[error.code]);
          throw error;
        }
      },
    },
  ];
}
