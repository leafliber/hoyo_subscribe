// 申请验证码前的准入管线（任务卡 P2-01 交付物二；主方案 §4.2 全段、§4.1、§8.2）。
//
// ★ 固定检查顺序（§4.2 原文，安全属性，不得重排/合并/提前）：
//   1 请求结构与尺寸 —— shell 写管线（body-schema：JSON/尺寸/未知字段/所有权字段）
//   2 同源 / CSRF —— shell 写管线（origin + CSRF 双提交，绑定 preauth_id）；
//                    管线在此之后先核验预认证上下文（§4.3：申请挑战前上下文必须已建立）
//   3 近似限速 —— rate-gate（镜像 OTP_COOLDOWN / EMAIL_AUTH_INTENTS_DAY，只挡突发 [R16]）
//   4 Turnstile 服务端校验 —— turnstile.ts（单次验证 [R09]；失败关闭）
//   5 邮箱与全局配额 —— 精确读侧：存在性、注册三条件、邮箱/全局挑战配额、发信预算
//                     （P1-07 账本快照 + contracts decideMailIntent 唯一判定源）
//   6 原子预占 —— 注册槽 conditionalCommit（P1-05 admission；登录路径走同形状必败守卫）
//   7 创建挑战及发信任务 —— 效果接缝（真实实装属 P2-02；本卡由测试替身钉住时序位置）
//
// 存在性折叠（§4.2 末段 + P1-08 existence-fold）：第 5 步获知的存在性只在
// runExistenceFold 的 real/dummy 二选一中使用；两条分支各完成**恰好一次** HMAC 验证形
// 单元工作（已注册分支对真实 preauth Cookie 再验一次 MAC；未注册分支跑 P1-08 的
// dummyOtpMacVerify 必败验证），第 6/7 步的数据库工作在两条分支内保持同语句形状
// （不适用预占的路径以容量上限 0 的同形状必败守卫配平）。公开响应唯一出口
// publicAuthIntentResponse（202，"符合条件的请求将发送验证码"）——已注册、未注册、
// 满额、关闭注册四条路径字节相同。
//
// 本卡到第 7 步的接缝为止：验证码本身的生成、存储与校验不在范围（P2-02/P2-03）。
// POST /api/v2/auth/challenges（§8.2 申请端点）由 P2-02 挂载并注入第 7 步真实效果。
//
// —— P2-02 获准的注入点改动（理由逐条，见任务卡范围条款） ——
// 1. ChallengeAndMailTaskContext 增补 keys / rawEmail / idempotencyKey：真实效果
//    （auth/challenges/create-challenge.ts）需要密钥环算 MAC 与受控密文；需要**请求
//    原文邮箱**派生新地址挑战的实际投递串（§4.1：身份键折叠大小写、投递地址不折叠，
//    canonical 字段不够）；需要幂等键落实 §4.3「网络重试沿用绑定预认证上下文的
//    idempotency_key」。
// 2. PreauthAdmissionInput 增补可选 idempotencyKey（缺省 null）：P2-01 测试不传即
//    维持原行为。
// 3. 折叠 202 出口统一附加预认证 Cookie 同值续期 Set-Cookie（§4.3，实现于
//    auth/challenges/renewal.ts）：续期目标（now + PREAUTH_MIN_TTL 与「最晚开放挑战
//    截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN」的最大值）对「本次申请是否真的创建
//    了挑战」**路径无关**——A.5 第一式（**不等式** PREAUTH_MIN_TTL >= OTP_TTL +
//    AUTH_COMPLETION_TTL + PREAUTH_MARGIN）保证 ≤now 创建的一切挑战所需覆盖都 ≤
//    now + 下限（完整推导见 renewal.ts 文件头与 CONTRACTS_BASELINE.md §8）——因此
//    四条折叠路径附加同一值，字节同形不被破坏，也不会经 Set-Cookie 的出现与否或
//    取值差异回显注册状态。续期读与签名在存在性折叠之外、对所有 202 路径统一执行
//    （时序同增，不改变路径间相对成本）。

import {
  canonicalizeEmail,
  decideMailIntent,
  type MailIntentKind,
  OTP_TTL,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  utcDayPeriod,
} from "@hoyo/contracts";
import {
  ACCOUNTS_TOTAL_CAPACITY_KEY,
  admissionMailIntent,
  readRegistrationCapacity,
  registrationGatesOpen,
  reserveRegistrationSlot,
} from "../../accounts/admission/registration";
import {
  ApiError,
  dummyOtpMacVerify,
  parseCookieHeader,
  publicAuthIntentResponse,
  runExistenceFold,
} from "../../shell";
import { conditionalCommit } from "../../storage/cas";
import type { Keyring } from "../../storage/crypto/keyring";
import { computeEmailKey } from "../../storage/crypto/mac";
import { readMailDayLedger } from "../../storage/ledger/mail-ledger";
import { renewPreauthCookieForContext } from "../challenges/renewal";
import { PREAUTH_COOKIE_NAME, verifyPreauthCookieValue } from "./cookie";
import { type AuthQuotaSnapshot, decideAuthQuota, intentsDayStartMs } from "./quota";
import type { ApproximateRateGate } from "./rate-gate";
import type { TurnstileVerifier } from "./turnstile";

/** 秒→毫秒（注册表秒值的换算，不引入第二份常量）。 */
const MS_PER_SECOND = 1_000;

/** 第 7 步效果接缝：创建挑战及发信任务（P2-02 注入真实实现；测试可注入替身）。 */
export interface ChallengeAndMailTaskContext {
  readonly db: D1Database;
  /** 密钥环（P2-02：真实效果计算验证码 MAC 与受控密文所需）。 */
  readonly keys: Keyring;
  readonly intent: MailIntentKind;
  readonly canonicalEmail: string;
  /** 请求原文邮箱（P2-02：新地址挑战按原文投递形态取实际投递串，§4.1）。 */
  readonly rawEmail: string;
  readonly emailKey: string;
  readonly preauthId: string;
  /** 网络重试幂等键（§4.3，绑定预认证上下文由 (preauth_id, idempotency_key) 索引承担）。 */
  readonly idempotencyKey: string | null;
  /** 注册预占 id（仅注册路径非空；登录路径为 null，不占新注册槽）。 */
  readonly reservationId: string | null;
  /** 挑战最初截止（重发不延长，P2-02）；预占到同一时刻。 */
  readonly challengeDeadline: number;
  readonly now: number;
}

export type CreateChallengeAndMailTask = (ctx: ChallengeAndMailTaskContext) => Promise<void>;

/** 管线依赖：全部可注入（测试用替身与计数代理钉住每一步的执行位置）。 */
export interface PreauthAdmissionDeps {
  readonly db: D1Database;
  readonly keys: Keyring;
  readonly rateGate: ApproximateRateGate;
  readonly turnstile: TurnstileVerifier;
  readonly effect: CreateChallengeAndMailTask;
  readonly now: () => number;
}

/** 管线输入（来自 RouteContext：已通过 shell 结构与 Origin/CSRF 校验的请求）。 */
export interface PreauthAdmissionInput {
  readonly request: Request;
  /** 请求体 email 字段原值（规范化在管线内完成，失败即 validation）。 */
  readonly email: string;
  readonly turnstileToken: string;
  /** 网络重试幂等键（P2-02；缺省 null = 无幂等约束，维持 P2-01 行为）。 */
  readonly idempotencyKey?: string | null;
}

/** 未注册邮箱在注册侧被折叠拒绝的读侧快照决策（第 5 步产物，仅在 fold 分支内消费）。 */
interface AdmissionDecision {
  readonly exists: boolean;
  readonly intent: MailIntentKind;
  readonly emailKey: string;
  readonly canonicalEmail: string;
  /** 发信预算判定（decideMailIntent 唯一来源）。 */
  readonly mailApproved: boolean;
  /** 注册三条件（开放 + 账号容量 + 当日完成数）读侧是否全开；登录路径恒为 true。 */
  readonly registrationGatesPassed: boolean;
}

/**
 * 等成本空操作效果：与「挑战 + 发信任务」同语句形状的必败条件提交（守卫
 * value < 0 恒不命中，两条 INSERT 被 changes() 谓词空操作，零写入）。用于一切
 * 未获发信资格的路径，使第 7 步在四条路径上的数据库工作保持同形状（时序配平）。
 * P2-02 实装真实效果时应保持同数量级的语句形状，本函数形状已在测试中钉住。
 */
async function runEqualizingNoopEffect(db: D1Database, now: number): Promise<void> {
  await conditionalCommit(db, {
    guard: {
      sql: `UPDATE capacity_state SET updated_at = ? WHERE key = ? AND value < 0`,
      params: [now, ACCOUNTS_TOTAL_CAPACITY_KEY],
    },
    effects: [
      {
        kind: "insert",
        table: "auth_challenges",
        columns: [
          "id",
          "purpose",
          "email_key",
          "address_version",
          "preauth_id",
          "mac",
          "deadline",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            "equalization-noop",
            "equalization",
            "equalization",
            0,
            "equalization",
            "equalization",
            now,
            now,
            now,
          ],
        ],
      },
      {
        kind: "insert",
        table: "mail_outbox",
        columns: [
          "id",
          "purpose",
          "priority",
          "period_key",
          "address_version",
          "payload_kind",
          "status",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            "equalization-noop",
            "equalization",
            0,
            OUTBOX_UNRESERVED_PERIOD_KEY,
            0,
            "equalization",
            "pending",
            now,
            now,
          ],
        ],
      },
    ],
  });
}

/** 第 5 步的邮箱/全局挑战配额读（同形状三条语句，路径间等成本）。 */
async function readAuthQuotaSnapshot(
  db: D1Database,
  emailKey: string,
  now: number,
): Promise<AuthQuotaSnapshot> {
  const dayStart = intentsDayStartMs(now);
  const [emailRows, openRows, globalRows] = await Promise.all([
    db
      .prepare(
        "SELECT count(*) AS intents, max(created_at) AS last FROM auth_challenges WHERE email_key = ? AND created_at >= ?",
      )
      .bind(emailKey, dayStart)
      .first<{ intents: number; last: number | null }>(),
    db
      .prepare(
        "SELECT count(*) AS c FROM auth_challenges WHERE email_key = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?",
      )
      .bind(emailKey, now)
      .first<{ c: number }>(),
    db
      .prepare(
        "SELECT count(*) AS c FROM auth_challenges WHERE consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?",
      )
      .bind(now)
      .first<{ c: number }>(),
  ]);
  return {
    emailIntentsToday: emailRows?.intents ?? 0,
    emailLastIntentAt: emailRows?.last ?? null,
    emailOpenChallenges: openRows?.c ?? 0,
    globalOpenChallenges: globalRows?.c ?? 0,
  };
}

/** 用户存在性读（唯一一次；结果只喂给 runExistenceFold，不外泄）。 */
async function userExistsByEmailKey(db: D1Database, emailKey: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM users WHERE email_key = ?").bind(emailKey).first();
  return row !== null;
}

/**
 * 运行七步顺序中的第 2½—7 步（结构与同源/CSRF 由 shell 写管线先行完成），
 * 恒定返回折叠后的公开响应（202 同形）。任何资格外的失败（结构、限速、Turnstile、
 * 邮箱级配额）以闭合错误码抛出/返回，不携带存在性信息。
 */
export async function runPreauthAdmission(
  deps: PreauthAdmissionDeps,
  input: PreauthAdmissionInput,
): Promise<Response> {
  const now = deps.now();

  // —— 邮箱规范化（§4.1 唯一实现；失败属结构问题 → validation）——
  const canonical = canonicalizeEmail(input.email);
  if (!canonical.ok) {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "email", reason: "canonicalization_failed" }],
    });
  }

  // —— 预认证上下文核验（第 2 步环的收尾，先于限速：申请必须发生在已建立的上下文里）——
  const cookieValue = parseCookieHeader(input.request.headers.get("cookie"), PREAUTH_COOKIE_NAME);
  if (cookieValue === undefined) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }
  const preauth = await verifyPreauthCookieValue(deps.keys.preauthCookie(), cookieValue, now);
  if (!preauth.ok) {
    throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
  }

  // —— 第 3 步：近似限速（必须在 Turnstile 之前：不耗 siteverify 配额）——
  const gate = deps.rateGate.check({ canonicalEmail: canonical.canonical, now });
  if (!gate.allowed) {
    throw new ApiError("rate_limited", { code: "rate_limited", retry_after_ms: gate.retryAfterMs });
  }

  // —— 第 4 步：Turnstile 服务端校验（单次验证；失败关闭）——
  const turnstile = await deps.turnstile.verify({ token: input.turnstileToken });
  if (turnstile !== "passed") {
    throw new ApiError("validation", {
      code: "validation",
      fields: [{ path: "turnstile_token", reason: "verification_failed" }],
    });
  }
  // 受理记账：本次已消耗一次 Turnstile 校验，镜像窗推进，使同邮箱的重复申请在第 3 步被挡。
  deps.rateGate.recordIntent(canonical.canonical, now);

  // —— 第 5 步：邮箱与全局配额（读侧决策；存在性只进入 fold 分支）——
  const emailKey = await computeEmailKey(deps.keys.emailLookup(), canonical.canonical);
  const [exists, capacity, ledger, quotaSnapshot] = await Promise.all([
    userExistsByEmailKey(deps.db, emailKey),
    readRegistrationCapacity(deps.db, now),
    readMailDayLedger(deps.db, utcDayPeriod(now).key),
    readAuthQuotaSnapshot(deps.db, emailKey, now),
  ]);
  const quota = decideAuthQuota(quotaSnapshot, now);
  if (!quota.ok && quota.rejection.reason !== "challenges_max") {
    // 邮箱级配额超限：对已注册/未注册同等适用，不含存在性信息 → 可公开的 429。
    // 全站挑战上限（challenges_max）是站点级状态，与满额/关闭注册同形折叠为 202。
    throw new ApiError("rate_limited", {
      code: "rate_limited",
      ...(quota.rejection.reason === "cooldown"
        ? { retry_after_ms: quota.rejection.retryAfterMs }
        : {}),
    });
  }
  const quotaPassed = quota.ok;
  const intent = admissionMailIntent(exists);
  const mailDecision = decideMailIntent(intent, ledger);
  const mailApproved = quotaPassed && mailDecision.decision === "approve";
  const registrationGatesPassed = exists || registrationGatesOpen(capacity);
  const decision: AdmissionDecision = {
    exists,
    intent,
    emailKey,
    canonicalEmail: canonical.canonical,
    mailApproved,
    registrationGatesPassed,
  };

  // 挑战最初截止（§4.3 OTP_TTL；重发不延长）：预占与效果共用同一时刻。
  const challengeDeadline = now + OTP_TTL * MS_PER_SECOND;

  // —— 第 6/7 步（存在性折叠内执行）：原子预占 + 创建挑战及发信任务 ——
  await runExistenceFold(decision.exists, {
    // 已注册分支：真实单元工作 = 对真实 preauth Cookie 再做一次完整 MAC 验证。
    real: async () => {
      const recheck = await verifyPreauthCookieValue(deps.keys.preauthCookie(), cookieValue, now);
      if (!recheck.ok) {
        throw new ApiError("unauthorized", { code: "unauthorized", reason: "no_session" });
      }
      // 登录路径不占新注册槽：同形状必败预占（attempt=false → 容量上限 0，零写入）。
      await reserveRegistrationSlot(deps.db, {
        reservationId: crypto.randomUUID(),
        emailKey: decision.emailKey,
        now,
        challengeDeadline,
        attempt: false,
      });
      if (decision.mailApproved) {
        await deps.effect({
          db: deps.db,
          keys: deps.keys,
          intent: decision.intent,
          canonicalEmail: decision.canonicalEmail,
          rawEmail: input.email,
          emailKey: decision.emailKey,
          preauthId: preauth.context.preauthId,
          idempotencyKey: input.idempotencyKey ?? null,
          reservationId: null,
          challengeDeadline,
          now,
        });
      } else {
        await runEqualizingNoopEffect(deps.db, now);
      }
    },
    // 未注册分支：等成本必败验证（P1-08）+ 注册路径的真实预占（三条件读侧全开才真占）。
    dummy: async () => {
      await dummyOtpMacVerify(deps.keys.otpMac());
      const reservationId = crypto.randomUUID();
      const slot = await reserveRegistrationSlot(deps.db, {
        reservationId,
        emailKey: decision.emailKey,
        now,
        challengeDeadline,
        attempt: decision.registrationGatesPassed && decision.mailApproved,
      });
      if (decision.registrationGatesPassed && decision.mailApproved && slot === "reserved") {
        await deps.effect({
          db: deps.db,
          keys: deps.keys,
          intent: decision.intent,
          canonicalEmail: decision.canonicalEmail,
          rawEmail: input.email,
          emailKey: decision.emailKey,
          preauthId: preauth.context.preauthId,
          idempotencyKey: input.idempotencyKey ?? null,
          reservationId,
          challengeDeadline,
          now,
        });
      } else {
        await runEqualizingNoopEffect(deps.db, now);
      }
    },
  });

  // 公开响应唯一出口：四条路径同形（202 + 固定模板）+ 统一同值续期（§4.3，见文件头
  // 第 3 条：续期取值路径无关，同形不被破坏）。
  const response = publicAuthIntentResponse();
  const renewal = await renewPreauthCookieForContext(
    deps.db,
    deps.keys.preauthCookie(),
    preauth.context,
    now,
  );
  response.headers.append("set-cookie", renewal.setCookie);
  return response;
}
