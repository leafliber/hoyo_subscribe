// P2-05 跨卡迁移：用途枚举与守卫已上移 contracts，此处只保留准入侧映射。
import type { ChallengePurpose, MailIntentKind } from "@hoyo/contracts";

/**
 * 准入意图 → 挑战用途（创建侧唯一映射；§4.2「存在账号时按登录路径处理」）。
 * 重发（auth_resend）不创建新挑战，用途沿用原挑战行，不经本函数。
 */
export function purposeOfAdmissionIntent(kind: MailIntentKind): ChallengePurpose {
  return kind === "existing_auth_first_login" ? "login" : "signup";
}
