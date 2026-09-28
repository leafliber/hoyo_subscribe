// P2-07：账号危险操作路由。外壳统一校验 Origin/CSRF，证明和所有者再由 D1 实时核对。
// 删除是受限恢复会话唯一允许的账号写入；其他写入仍由外壳默认拒绝。
import { API_BODY_MAX_BYTES, isRecentAuthAction, isRecentAuthRole } from "@hoyo/contracts";
import {
  type RecentSession,
  startRecentOtp,
  verifyRecentOtp,
} from "../../auth/challenges/recent-auth";
import { serializePendingSessionCookie } from "../../auth/consume/session";
import { proveWithRecoveryCode } from "../../auth/recent-auth/proof";
import type { ShellAuth } from "../../shell/domains";
import { ApiError, jsonResponse } from "../../shell/errors";
import type { ShellRoute } from "../../shell/router";
import type { Keyring } from "../../storage/crypto/keyring";
import type { LifecycleEffectHook } from "./effects";
import {
  changeEmail,
  confirmRecoveryRotation,
  markAccountDeleting,
  startRecoveryRotation,
} from "./service";
import { exportPreferences, readAccountSummary } from "./views";

function sessionOf(auth: ShellAuth): RecentSession {
  if (auth.kind !== "session" || auth.domain !== "user") {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    sessionTokenHash: auth.sessionTokenHash,
  };
}

function csrfBinding({ auth }: { auth: ShellAuth }): Promise<string> {
  return Promise.resolve(sessionOf(auth).sessionTokenHash);
}

function stringField(body: Record<string, unknown> | undefined, name: string): string {
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

function actionField(body: Record<string, unknown> | undefined) {
  const value = stringField(body, "action");
  if (!isRecentAuthAction(value)) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "action", reason: "invalid_action" }],
    });
  }
  return value;
}

function noStore(body: unknown, status = 200): Response {
  const response = jsonResponse(body, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export interface LifecycleRouteDeps {
  readonly keys: () => Promise<Keyring>;
  readonly now?: () => number;
  readonly hooks?: readonly LifecycleEffectHook[];
}

export function makeLifecycleRoutes(deps: LifecycleRouteDeps): readonly ShellRoute[] {
  const now = deps.now ?? Date.now;
  return [
    {
      method: "POST",
      pattern: "/api/v2/me/recent-auth/challenges",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          action: { type: "string" },
          role: { type: "string" },
          target_email: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          idempotency_key: { type: "string", maxLength: API_BODY_MAX_BYTES },
        },
      },
      handler: async (ctx) => {
        const action = actionField(ctx.body);
        const role = stringField(ctx.body, "role");
        if (!isRecentAuthRole(role))
          throw new ApiError("validation", {
            code: "validation",
            fields: [{ path: "role", reason: "invalid_role" }],
          });
        const challengeId = await startRecentOtp(
          ctx.env.DB,
          await deps.keys(),
          sessionOf(ctx.auth),
          action,
          role,
          typeof ctx.body?.target_email === "string" ? ctx.body.target_email : undefined,
          stringField(ctx.body, "idempotency_key"),
          now(),
        );
        return noStore({ challenge_id: challengeId }, 202);
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/me/recent-auth/challenges/verify",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          challenge_id: { type: "string", maxLength: API_BODY_MAX_BYTES },
          code: { type: "string", maxLength: API_BODY_MAX_BYTES },
        },
      },
      handler: async (ctx) =>
        noStore({
          proof_id: await verifyRecentOtp(
            ctx.env.DB,
            await deps.keys(),
            sessionOf(ctx.auth),
            stringField(ctx.body, "challenge_id"),
            stringField(ctx.body, "code"),
            now(),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/v2/me/recent-auth/recovery",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          action: { type: "string" },
          target_email: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          recovery_id: { type: "string", maxLength: API_BODY_MAX_BYTES },
          secret: { type: "string", maxLength: API_BODY_MAX_BYTES },
        },
      },
      handler: async (ctx) =>
        noStore({
          proof_id: await proveWithRecoveryCode(
            ctx.env.DB,
            sessionOf(ctx.auth),
            actionField(ctx.body),
            typeof ctx.body?.target_email === "string" ? ctx.body.target_email : undefined,
            stringField(ctx.body, "recovery_id"),
            stringField(ctx.body, "secret"),
            now(),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/v2/me/email-change",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          target_email: { type: "string", maxLength: API_BODY_MAX_BYTES },
          current_proof_id: { type: "string", maxLength: API_BODY_MAX_BYTES },
          new_proof_id: { type: "string", maxLength: API_BODY_MAX_BYTES },
        },
      },
      handler: async (ctx) => {
        const result = await changeEmail(
          ctx.env.DB,
          await deps.keys(),
          sessionOf(ctx.auth),
          stringField(ctx.body, "target_email"),
          stringField(ctx.body, "current_proof_id"),
          stringField(ctx.body, "new_proof_id"),
          now(),
          deps.hooks,
        );
        const response = noStore({
          email_version: result.emailVersion,
          pending_session_id: result.pendingSession.id,
        });
        response.headers.append(
          "set-cookie",
          serializePendingSessionCookie(result.pendingSession.cookieValue),
        );
        return response;
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/me/recovery-code",
      domain: "user",
      write: true,
      csrfBinding,
      bodySchema: {
        fields: {
          action: { type: "string" },
          proof_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          operation_key: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          rotation_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          secret: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
        },
      },
      handler: async (ctx) => {
        const session = sessionOf(ctx.auth);
        const action = stringField(ctx.body, "action");
        if (action === "start") {
          const key = stringField(ctx.body, "operation_key");
          if (key.length === 0)
            throw new ApiError("validation", {
              code: "validation",
              fields: [{ path: "operation_key", reason: "required" }],
            });
          const rotation = await startRecoveryRotation(
            ctx.env.DB,
            session,
            stringField(ctx.body, "proof_id"),
            key,
            now(),
          );
          return noStore({
            rotation_id: rotation.rotationId,
            recovery_id: rotation.recoveryId,
            secret: rotation.secret,
            saved_confirmed: false,
          });
        }
        if (action === "confirm") {
          await confirmRecoveryRotation(
            ctx.env.DB,
            session,
            stringField(ctx.body, "rotation_id"),
            stringField(ctx.body, "secret"),
            now(),
          );
          return noStore({ saved_confirmed: true });
        }
        throw new ApiError("validation", {
          code: "validation",
          fields: [{ path: "action", reason: "invalid_action" }],
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/v2/me/delete",
      domain: "user",
      write: true,
      allowRecoveryWrite: true,
      csrfBinding,
      bodySchema: {
        fields: {
          proof_id: { type: "string", optional: true, maxLength: API_BODY_MAX_BYTES },
          confirm: { type: "boolean" },
        },
      },
      handler: async (ctx) => {
        if (ctx.body?.confirm !== true)
          throw new ApiError("validation", {
            code: "validation",
            fields: [{ path: "confirm", reason: "explicit_confirmation_required" }],
          });
        await markAccountDeleting(
          ctx.env.DB,
          sessionOf(ctx.auth),
          typeof ctx.body?.proof_id === "string" ? ctx.body.proof_id : undefined,
          now(),
          deps.hooks,
        );
        return noStore({ state: "deleting" });
      },
    },
    {
      method: "GET",
      pattern: "/api/v2/me",
      domain: "user",
      write: false,
      handler: async (ctx) =>
        noStore(await readAccountSummary(ctx.env.DB, await deps.keys(), ctx.auth, now())),
    },
    {
      method: "GET",
      pattern: "/api/v2/me/export",
      domain: "user",
      write: false,
      handler: async (ctx) =>
        noStore(await exportPreferences(ctx.env.DB, sessionOf(ctx.auth).userId)),
    },
  ];
}
