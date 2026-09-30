// P3-06 获准跨卡：只挂载个人 Feed handler，沿用外壳协议路径。
// P4-03 所有者补充授权：仅注入认证故障门与 outbox 提交后的唤醒钩子。
// P3-11 获准跨卡接线：导出 Cron scheduled 处理器；不依赖 waitUntil 保存待办。
// P2-07 获准跨卡接线：挂载账号最近认证、换绑、轮换、删除、导出及摘要。
// P2-05 授权跨卡改动：挂载 public 恢复动作及本人新码交付路径。
// P2-06 跨卡接线：挂载云端订阅 GET/PATCH；沿用 P2-04 的 active 会话鉴权。
// P2-04 跨卡修正：把 P1-08 的无身份桩换成逐请求 D1 主状态鉴权，挂载会话路由。
// Worker 入口（P1-01 骨架 + P1-08 API 外壳挂载；业务路由由 P2+ 按任务卡挂载）。
//
// 启动等式校验（任务卡 P1-03；ENGINEERING.md §4）：附录 A.5 / CONTRACTS_BASELINE.md §11
// 的全部数值等式在模块加载时执行。任一不成立时 verifyParams 抛出 ParamEquationError
// （消息逐条指明是哪一条），Worker 实例化失败即**拒绝启动**——与 `pnpm params:verify`
// 共用同一个函数，不存在第二套校验。
// P2-03 裁定授权注入：挂载原 preauth + 操作幂等键领取 pending Cookie 的完成端点。

import { verifyParams } from "@hoyo/contracts";
import { statusRoute } from "./accounts/admission/status";
import { makeLifecycleRoutes } from "./accounts/lifecycle/routes";
import { makeSubscriptionRoutes } from "./accounts/subscription/routes";
import { makeChallengeRoutes } from "./auth/challenges/routes";
import { makeCompleteRoute } from "./auth/consume/routes";
import { InMemoryAuthRateGate } from "./auth/preauth/rate-gate";
import { makePreauthInitRoute } from "./auth/preauth/routes";
import { siteverifyTurnstileVerifier } from "./auth/preauth/turnstile";
import { makeRecoveryRoutes } from "./auth/recovery/routes";
import { sessionAuthenticator } from "./auth/sessions/authenticator";
import { makeSessionRoutes } from "./auth/sessions/routes";
import { makeFeedHandler } from "./calendar/feed/handler";
import { mailAdmissionHook } from "./mail/provider/admission";
import { scheduled } from "./scheduled";
import { applySecurityHeaders } from "./shell/headers";
import { createApiShell } from "./shell/router";
import { fromHex } from "./storage/crypto/bytes";
import { Keyring } from "./storage/crypto/keyring";

verifyParams();

export { DeliveryDO } from "./executors/delivery-do";
export { PipelineDO } from "./executors/pipeline-do";

/**
 * 部署秘密（Wrangler secret 注入；ENGINEERING.md §4"秘密全部经 Wrangler secret 注入"）。
 * 密钥材料只经 Keyring（P1-06 唯一派生源）进入外壳；任一项缺失时写路由失败关闭，
 * 不降级。注入这三个值属"需所有者执行的前置"（部署阶段），本卡不代做。
 */
interface ShellSecrets {
  /** 根秘密一：七个共根用途的派生源（hex，≥ SECRET_BITS/4 字符）。 */
  readonly CRYPTO_MASTER_SECRET?: string;
  /** 根秘密二：OTP MAC 独立 pepper（hex，≥ SECRET_BITS/4 字符；必须与 master 不同）。 */
  readonly CRYPTO_OTP_PEPPER?: string;
  /** 退订 MAC 当前签发 key_id（§7.6；Keyring 构造需要，token 签发本身属 P4）。 */
  readonly CRYPTO_UNSUBSCRIBE_KEY_ID?: string;
  /** Turnstile siteverify 秘密（P2-02：仅申请验证码端点需要；未注入时该端点失败关闭）。 */
  readonly TURNSTILE_SECRET_KEY?: string;
}

/** 每隔离实例缓存一次的密钥环（构造含 HKDF 派生，不逐请求重建）。 */
const keyringPromises = new WeakMap<Env, Promise<Keyring>>();

function getKeyring(env: Env & ShellSecrets): Promise<Keyring> {
  let promise = keyringPromises.get(env);
  if (promise === undefined) {
    promise = Keyring.create({
      masterSecret: requireHexSecret(env, "CRYPTO_MASTER_SECRET"),
      otpPepper: requireHexSecret(env, "CRYPTO_OTP_PEPPER"),
      unsubscribeMacCurrentKeyId: requirePlainSecret(env, "CRYPTO_UNSUBSCRIBE_KEY_ID"),
    });
    keyringPromises.set(env, promise);
  }
  return promise;
}

function requirePlainSecret(env: Env & ShellSecrets, name: keyof ShellSecrets): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`部署秘密 ${name} 未注入（Wrangler secret；见 ENGINEERING.md §4）`);
  }
  return value;
}

function requireHexSecret(env: Env & ShellSecrets, name: keyof ShellSecrets): Uint8Array {
  const bytes = fromHex(requirePlainSecret(env, name));
  if (bytes === null) {
    throw new Error(`部署秘密 ${name} 不是合法 hex`);
  }
  return bytes;
}

/** 外壳：P2-01 挂载预认证初始化与全局状态（申请端点 /api/v2/auth/challenges 属 P2-02）。 */
type Shell = ReturnType<typeof createApiShell>;

const shellByEnv = new WeakMap<Env, Shell>();

function getShell(env: Env): Shell {
  let shell = shellByEnv.get(env);
  if (shell === undefined) {
    const authRateGate = new InMemoryAuthRateGate();
    const authTurnstile = () =>
      siteverifyTurnstileVerifier((env as Env & ShellSecrets).TURNSTILE_SECRET_KEY ?? "");
    shell = createApiShell({
      authenticator: sessionAuthenticator(env.DB),
      feedHandler: makeFeedHandler(),
      // 秘密未注入时 getKeyring 抛错 → 写路由折叠为 temporarily_unavailable
      // （失败关闭）；读路径与 Feed 协议校验不受影响。
      csrfKey: () => getKeyring(env as Env & ShellSecrets).then((ring) => ring.csrf()),
      routes: [
        // P2-01 挂载点：预认证初始化（CSRF 签发方，csrf:false 由路由自带）+ /status
        // 全局注册开关。
        makePreauthInitRoute({ keys: () => getKeyring(env as Env & ShellSecrets) }),
        statusRoute,
        // P2-02 挂载点：申请 / 重发 / 校验三端点（七步准入管线 + 真实第 7 步效果）。
        // 近似限速门每 shell（isolate）一个实例；Turnstile 懒构造——秘密未注入时仅
        // 申请端点失败关闭（503），不影响预认证初始化与其余路由。
        ...makeChallengeRoutes({
          mail: mailAdmissionHook,
          keys: () => getKeyring(env as Env & ShellSecrets),
          rateGate: authRateGate,
          turnstile: authTurnstile,
        }),
        makeCompleteRoute(() => getKeyring(env as Env & ShellSecrets)),
        ...makeSessionRoutes(() => getKeyring(env as Env & ShellSecrets)),
        // P2-05：public 恢复动作与 active 会话的新码交付；通道暂停效果由各通道卡挂入。
        ...makeRecoveryRoutes({ keys: () => getKeyring(env as Env & ShellSecrets) }),
        ...makeSubscriptionRoutes(),
        ...makeLifecycleRoutes({
          mail: mailAdmissionHook,
          keys: () => getKeyring(env as Env & ShellSecrets),
          rateGate: authRateGate,
          turnstile: authTurnstile,
        }),
      ],
    });
    shellByEnv.set(env, shell);
  }
  return shell;
}

export default {
  scheduled,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/") {
      // P1-01 探针 banner：根路径保持 200 文本（index.test.ts 依赖），叠安全头。
      return applySecurityHeaders(
        new Response("hoyo_subscribe worker skeleton (P1-01; shell P1-08)\n", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }
    return getShell(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
