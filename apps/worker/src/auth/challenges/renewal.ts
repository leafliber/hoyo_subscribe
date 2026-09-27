// 预认证 Cookie 的同值续期（任务卡 P2-02；主方案 §4.3 第二段、附录 A.5 认证时序等式）。
//
// 合同约束：
// - 创建有效挑战时续期**同一个 Cookie 值**（§4.3：随机值 preauth_id 不换、不升级为会话）；
//   续期 = 同 preauth_id、同 issued_at，仅延长 MAC 认证的 expires_at 并重签 MAC。
// - 浏览器保留期限须覆盖该上下文**所有未过期挑战的最晚结束时间 + AUTH_COMPLETION_TTL
//   + PREAUTH_MARGIN**（A.5 第二式：OTP绑定Cookie截止 >= 最晚挑战截止 + 两者之和）。
// - 下限本身即安全，依据是 A.5 第一式的**不等式**（PREAUTH_MIN_TTL >= OTP_TTL +
//   AUTH_COMPLETION_TTL + PREAUTH_MARGIN；params:verify 每次启动校验）：
//     任何未过期挑战的截止 <= now + OTP_TTL
//     ⇒ 第三项 base + (AUTH_COMPLETION_TTL + PREAUTH_MARGIN)
//            <= now + OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN
//            <= now + PREAUTH_MIN_TTL = 第二项
//   即第三项永远超不过下限项，expiresAt 恒 = max(当前截止, now + PREAUTH_MIN_TTL)。
//   由此，续期目标对「本次申请是否真的创建了挑战」是**路径无关**的——这对存在性
//   折叠至关重要：申请响应按同一规则对四条路径（已注册/未注册/满额/关闭注册）统一
//   附加同一 Set-Cookie 值，字节同形不被破坏，也不经 Set-Cookie 出现与否或取值差异
//   回显邮箱注册状态。安全性挂在这条**不等式**上，不挂在当前参数恰好取等
//   （1320 = 600 + 600 + 120）的巧合上：调参只需保持不等式成立，不必保持相等
//   （CONTRACTS_BASELINE.md §8，P2-02 验收裁定）。
//
// 本模块不做数据库读取的调用方决策：maxOpenChallengeDeadline 由调用方（pipeline 的
// 申请响应出口、verify/resend 的成功响应）读出后传入；对无挑战上下文传 null。

import {
  AUTH_COMPLETION_TTL,
  PREAUTH_MARGIN,
  PREAUTH_MIN_TTL,
  type PreauthCookieKey,
} from "@hoyo/contracts";
import { macPreauthCookie } from "../../storage/crypto/mac";
import { type PreauthContext, serializePreauthSetCookie } from "../preauth/cookie";

/** 秒→毫秒（注册表秒值的换算，不引入第二份常量）。 */
const MS_PER_SECOND = 1_000;

/** 续期所需的读侧信息：本上下文未过期挑战的最晚截止（毫秒）；无未过期挑战为 null。 */
export interface PreauthRenewalInput {
  readonly key: PreauthCookieKey;
  readonly context: PreauthContext;
  readonly maxOpenChallengeDeadline: number | null;
  readonly now: number;
}

export interface PreauthRenewal {
  /** 续期后的完整 Cookie 值（同 preauth_id、同 issued_at、延长后的 expires_at）。 */
  readonly value: string;
  readonly expiresAt: number;
  /** 序列化好的 Set-Cookie 行（含 Max-Age 同步）。 */
  readonly setCookie: string;
}

/**
 * 计算续期（纯计算 + 一次 MAC 签名，不读库）：
 * expiresAt = max(当前截止, now + PREAUTH_MIN_TTL, 最晚挑战截止 + AUTH_COMPLETION_TTL
 * + PREAUTH_MARGIN)。maxOpenChallengeDeadline 为 null 时第三项退化为 now + 两者之和，
 * 恒不超过下限项。
 */
export async function renewPreauthCookieValue(input: PreauthRenewalInput): Promise<PreauthRenewal> {
  const floorMs = PREAUTH_MIN_TTL * MS_PER_SECOND;
  const completionMarginMs = (AUTH_COMPLETION_TTL + PREAUTH_MARGIN) * MS_PER_SECOND;
  const base = input.maxOpenChallengeDeadline ?? input.now;
  const expiresAt = Math.max(
    input.context.expiresAt,
    input.now + floorMs,
    base + completionMarginMs,
  );
  const mac = await macPreauthCookie(input.key, {
    preauthId: input.context.preauthId,
    issuedAt: input.context.issuedAt,
    expiresAt,
  });
  const value = `${input.context.preauthId}.${input.context.issuedAt}.${expiresAt}.${mac}`;
  const maxAgeSeconds = Math.max(1, Math.floor((expiresAt - input.now) / MS_PER_SECOND));
  return {
    value,
    expiresAt,
    setCookie: serializePreauthSetCookie(value, maxAgeSeconds),
  };
}

/** 读某预认证上下文未过期挑战的最晚截止（毫秒；无则 null）。 */
export async function readMaxOpenChallengeDeadline(
  db: D1Database,
  preauthId: string,
  now: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT max(deadline) AS latest FROM auth_challenges WHERE preauth_id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND deadline > ?",
    )
    .bind(preauthId, now)
    .first<{ latest: number | null }>();
  return row?.latest ?? null;
}

/** 便捷组合：读库 + 续期（申请/重发/验证成功响应共用）。 */
export async function renewPreauthCookieForContext(
  db: D1Database,
  key: PreauthCookieKey,
  context: PreauthContext,
  now: number,
): Promise<PreauthRenewal> {
  const latest = await readMaxOpenChallengeDeadline(db, context.preauthId, now);
  return renewPreauthCookieValue({ key, context, maxOpenChallengeDeadline: latest, now });
}
