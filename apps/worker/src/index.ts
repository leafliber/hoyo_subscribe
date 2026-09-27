// Worker 入口（P1-01 骨架 + P1-08 API 外壳挂载；业务路由由 P2+ 按任务卡挂载）。
//
// 启动等式校验（任务卡 P1-03；ENGINEERING.md §4）：附录 A.5 / CONTRACTS_BASELINE.md §11
// 的全部数值等式在模块加载时执行。任一不成立时 verifyParams 抛出 ParamEquationError
// （消息逐条指明是哪一条），Worker 实例化失败即**拒绝启动**——与 `pnpm params:verify`
// 共用同一个函数，不存在第二套校验。
import { verifyParams } from "@hoyo/contracts";
import { statusRoute } from "./accounts/admission/status";
import { makeChallengeRoutes } from "./auth/challenges/routes";
import { InMemoryAuthRateGate } from "./auth/preauth/rate-gate";
import { makePreauthInitRoute } from "./auth/preauth/routes";
import { siteverifyTurnstileVerifier } from "./auth/preauth/turnstile";
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
    shell = createApiShell({
      // 鉴权器属 P2-04 会话卡；user/admin 域路由暂一律 no_session（失败关闭）。
      authenticator: {
        async authenticate() {
          return { kind: "none" } as const;
        },
      },
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
          keys: () => getKeyring(env as Env & ShellSecrets),
          rateGate: new InMemoryAuthRateGate(),
          turnstile: () =>
            siteverifyTurnstileVerifier((env as Env & ShellSecrets).TURNSTILE_SECRET_KEY ?? ""),
        }),
      ],
    });
    shellByEnv.set(env, shell);
  }
  return shell;
}

export default {
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
