// 申请验证码前的近似限速门（任务卡 P2-01 交付物二第 3 步；主方案 §4.2、§8.3、[R16]）。
//
// 合同分工（[R16] / contracts budget/mutations.ts 的 EDGE_RATE_LIMIT_ROLE）：
// 近似限速**只挡突发**、结论是建议性的；精确配额与存量的唯一权威是 D1 账本（本卡
// 第 5 步的精确读 + P1-07 账本）。因此本门：
// - 只做进程内（每 isolate）滑动窗近似——Workers 多 isolate 部署下它天然不精确，这正是
//   合同允许的「近似」；它绝不能成为配额判定依据（第 5 步独立重查同样的条件）。
// - 阈值**不是第二套规则**：按注册表已有的同规范邮箱口径（OTP_COOLDOWN 间隔、
//   EMAIL_AUTH_INTENTS_DAY 次数）做镜像预检，把同邮箱的重复轰炸挡在 Turnstile 之前
//   （任务卡：限速必须在 Turnstile 之前生效，否则攻击者能用限速额度耗 Turnstile 配额）。
// - 窗口簿记上限 RATE_WINDOWS_MAX（A.5：满额采用粗粒度拒绝，不继续生成无限键）；
//   过期窗口清理延迟按 RATE_WINDOWS_CLEANUP_DELAY。
//
// ⚠ 已知边界（列入交付报告）：**按来源 IP 聚合**的近似突发限速在本卡没有进程内实现——
// 注册表不存在对应参数，私自设数违反 AGENTS.md 硬规则 2；平台侧按 IP 的边缘限速
// （[R16] 的本职位置，Cloudflare WAF / rate-limit 规则）登记为「需所有者执行的前置」。

import {
  EMAIL_AUTH_INTENTS_DAY,
  OTP_COOLDOWN,
  RATE_WINDOWS_CLEANUP_DELAY,
  RATE_WINDOWS_MAX,
  utcDayPeriod,
} from "@hoyo/contracts";

/** 秒→毫秒（注册表秒值的换算，不引入第二份常量）。 */
const MS_PER_SECOND = 1_000;

export interface RateGateInput {
  /** 规范化后的邮箱身份键串（canonicalizeEmail 的产物，本门不持 HMAC 键）。 */
  readonly canonicalEmail: string;
  readonly now: number;
}

export type RateGateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "cooldown_mirror" | "intents_day_mirror";
      readonly retryAfterMs: number;
    };

/** 近似限速门接口（生产与测试各自注入实现；接口在 pipeline 的第 3 步消费）。 */
export interface ApproximateRateGate {
  check(input: RateGateInput): RateGateDecision;
  /** 第 4 步通过后的受理记账（推进镜像窗，使同邮箱重复申请在第 3 步被挡）。 */
  recordIntent(canonicalEmail: string, now: number): void;
}

interface EmailWindow {
  readonly dayStartMs: number;
  readonly dayEndMs: number;
  intents: number;
  lastIntentAt: number;
}

/** 进程内镜像实现：同邮箱冷却间隔与当日次数的近似预检 + 窗口簿记上限。 */
export class InMemoryAuthRateGate implements ApproximateRateGate {
  readonly #windows = new Map<string, EmailWindow>();
  #lastPrunedAt = 0;

  check(input: RateGateInput): RateGateDecision {
    this.#prune(input.now);
    const window = this.#windows.get(input.canonicalEmail);
    if (window !== undefined && input.now < window.dayEndMs) {
      if (window.lastIntentAt + OTP_COOLDOWN * MS_PER_SECOND > input.now) {
        return {
          allowed: false,
          reason: "cooldown_mirror",
          retryAfterMs: window.lastIntentAt + OTP_COOLDOWN * MS_PER_SECOND - input.now,
        };
      }
      if (window.intents >= EMAIL_AUTH_INTENTS_DAY) {
        return {
          allowed: false,
          reason: "intents_day_mirror",
          retryAfterMs: window.dayEndMs - input.now,
        };
      }
    }
    return { allowed: true };
  }

  /** 一次申请被受理（进入后续步骤）后记账；近似门在请求成功路径上推进。 */
  recordIntent(canonicalEmail: string, now: number): void {
    const day = utcDayPeriod(now);
    const existing = this.#windows.get(canonicalEmail);
    if (existing === undefined || now < existing.dayStartMs || now >= existing.dayEndMs) {
      if (this.#windows.size >= RATE_WINDOWS_MAX) {
        // A.5：满额采用粗粒度拒绝——丢最旧窗口而不是无限膨胀（粗粒度：新键挤掉旧键）。
        const oldest = this.#windows.keys().next();
        if (!oldest.done) {
          this.#windows.delete(oldest.value);
        }
      }
      this.#windows.set(canonicalEmail, {
        dayStartMs: day.startMs,
        dayEndMs: day.endMsExclusive,
        intents: 1,
        lastIntentAt: now,
      });
      return;
    }
    existing.intents += 1;
    existing.lastIntentAt = now;
  }

  /** 过期窗口清理（RATE_WINDOWS_CLEANUP_DELAY 之后）；每次 check 至多整理一遍。 */
  #prune(now: number): void {
    if (now - this.#lastPrunedAt < RATE_WINDOWS_CLEANUP_DELAY * MS_PER_SECOND) {
      return;
    }
    this.#lastPrunedAt = now;
    const horizon = now - RATE_WINDOWS_CLEANUP_DELAY * MS_PER_SECOND;
    for (const [key, window] of this.#windows) {
      if (window.lastIntentAt < horizon) {
        this.#windows.delete(key);
      }
    }
  }
}
