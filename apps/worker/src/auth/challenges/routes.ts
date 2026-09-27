// 认证挑战三端点（任务卡 P2-02 交付物一；主方案 §8.2、§4.2、§4.3）。
//
// - POST /api/v2/auth/challenges        申请：P2-01 七步准入管线 + 本卡注入的第 7 步真实
//   效果（create-challenge.ts）。响应为折叠 202 + 统一同值续期（见 pipeline 文件头）。
// - POST /api/v2/auth/challenges/resend  明确重发（resend.ts）：旋转本挑战 generation。
// - POST /api/v2/auth/challenges/verify  校验（verify.ts）：本卡止于「可被校验」。
//
// 三个端点都是写路由：shell 统一完成 结构与尺寸 → 同源 → CSRF 双提交（绑定
// preauth_id，与 P2-01 相同的绑定语义）；预认证上下文核验在各业务函数内完成。

import { OTP_DIGITS } from "@hoyo/contracts";
import type { ShellRoute } from "../../shell";
import { parseCookieHeader } from "../../shell";
import type { Keyring } from "../../storage/crypto/keyring";
import { PREAUTH_COOKIE_NAME } from "../preauth/cookie";
import { runPreauthAdmission } from "../preauth/pipeline";
import type { ApproximateRateGate } from "../preauth/rate-gate";
import type { TurnstileVerifier } from "../preauth/turnstile";
import { createChallengeAndMailTask } from "./create-challenge";
import { runResendOtp } from "./resend";
import { runVerifyOtp } from "./verify";

/** 幂等键的结构上限（防无界键；非业务参数——业务频率约束全部在注册表）。 */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface ChallengeRouteDeps {
  /** 密钥环提供方（index.ts 传入 getKeyring；构造失败时写路由失败关闭）。 */
  readonly keys: () => Promise<Keyring>;
  /** 近似限速门（每 isolate 一个实例；进程内镜像，见 preauth/rate-gate.ts）。 */
  readonly rateGate: ApproximateRateGate;
  /** Turnstile 校验器工厂（懒构造：秘密未注入时仅申请端点失败关闭，不影响其余路由）。 */
  readonly turnstile: () => TurnstileVerifier;
}

/** CSRF 绑定：预认证 Cookie 的 preauth_id 段（与 P2-01 准入端点同一绑定语义）。 */
function preauthCsrfBinding({ request }: { request: Request }): Promise<string> {
  const value = parseCookieHeader(request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  return Promise.resolve(value?.split(".")[0] ?? "");
}

function bodyString(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  return typeof value === "string" ? value : "";
}

export function makeChallengeRoutes(deps: ChallengeRouteDeps): readonly ShellRoute[] {
  return [
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          turnstile_token: { type: "string" },
          idempotency_key: {
            type: "string",
            optional: true,
            minLength: 1,
            maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
          },
        },
      },
      csrfBinding: preauthCsrfBinding,
      handler: async (ctx) =>
        runPreauthAdmission(
          {
            db: ctx.env.DB,
            keys: await deps.keys(),
            rateGate: deps.rateGate,
            turnstile: deps.turnstile(),
            effect: createChallengeAndMailTask,
            now: () => Date.now(),
          },
          {
            request: ctx.request,
            email: bodyString(ctx.body, "email"),
            turnstileToken: bodyString(ctx.body, "turnstile_token"),
            idempotencyKey: bodyString(ctx.body, "idempotency_key") || null,
          },
        ),
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges/resend",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          idempotency_key: {
            type: "string",
            minLength: 1,
            maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
          },
        },
      },
      csrfBinding: preauthCsrfBinding,
      handler: async (ctx) =>
        runResendOtp(
          {
            db: ctx.env.DB,
            keys: await deps.keys(),
            now: () => Date.now(),
          },
          {
            request: ctx.request,
            email: bodyString(ctx.body, "email"),
            idempotencyKey: bodyString(ctx.body, "idempotency_key"),
          },
        ),
    },
    {
      method: "POST",
      pattern: "/api/v2/auth/challenges/verify",
      domain: "public",
      write: true,
      bodySchema: {
        fields: {
          email: { type: "string" },
          code: { type: "string", minLength: 1, maxLength: OTP_DIGITS },
        },
      },
      csrfBinding: preauthCsrfBinding,
      handler: async (ctx) =>
        runVerifyOtp(
          {
            db: ctx.env.DB,
            keys: await deps.keys(),
            now: () => Date.now(),
          },
          {
            request: ctx.request,
            email: bodyString(ctx.body, "email"),
            code: bodyString(ctx.body, "code"),
          },
        ),
    },
  ];
}
