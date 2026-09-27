// 认证挑战的用途枚举（任务卡 P2-02；主方案 §4.3 六元组的「用途」字段、migrations/0005
// auth_challenges.purpose 注释「登录 / 新注册 / 换邮箱 / 恢复登录」）。
//
// P2-02 只经由准入管线创建 login / signup 两种用途；email_change / recovery 的创建路径
// 属 P2-05/P2-07，此处只登记取值，保证 MAC 绑定的用途串自本卡起有唯一来源。
// 枚举最终应上移 packages/contracts（硬规则 3）；本卡改动范围限定 challenges/**，
// 上移登记在交付报告「已知问题」中，P2-05 引入 recovery 用途时一并处理。
//
// 验证侧不复制这套映射：verify 直接使用数据库行内的 purpose 值参与 MAC 绑定，
// 不存在第二份判定。

import type { MailIntentKind } from "@hoyo/contracts";

/** 挑战用途（§4.3 MAC 六元组的用途字段；与 migrations/0005 注释一一对应）。 */
export const CHALLENGE_PURPOSES = ["login", "signup", "email_change", "recovery"] as const;

export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/** 判定字符串是否为已登记用途（验证侧读库后先过这一关，未登记值不进 MAC 绑定）。 */
export function isChallengePurpose(value: string): value is ChallengePurpose {
  return (CHALLENGE_PURPOSES as readonly string[]).includes(value);
}

/**
 * 准入意图 → 挑战用途（创建侧唯一映射；§4.2「存在账号时按登录路径处理」）。
 * 重发（auth_resend）不创建新挑战，用途沿用原挑战行，不经本函数。
 */
export function purposeOfAdmissionIntent(kind: MailIntentKind): ChallengePurpose {
  return kind === "existing_auth_first_login" ? "login" : "signup";
}
