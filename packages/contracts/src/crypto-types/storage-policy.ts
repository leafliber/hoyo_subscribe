// 两类存储策略的边界登记（任务卡 P1-06 交付物三；主方案 §8.3、§4.1、§4.3、§4.4、§6.1）。
//
// 合同原文（§8.3）："纯验证秘密存 hash/MAC，需要发信或再次复制的值采用受控密文，短期完成
// 回执严格到期清除。"本文件把这条边界固化成两份登记表：
//   1. HASH_ONLY_SECRET_STORAGE —— 只存 hash/MAC（不可逆），没有对应密文列；
//   2. CONTROLLED_CIPHERTEXT_STORAGE —— 受控密文（有明确理由的例外，必须可解密），
//      其 id 同时就是认证加密 AAD 的**记录类型**（CiphertextRecordType）：
//      worker 侧 encryptField/decryptField 以此为参数类型，密文跨记录搬运会因 AAD 不匹配
//      而认证失败（§8.3"认证数据包含记录类型与 ID"）。
// 数值期限一律引用参数注册表（../params/registry），本文件不出现第二份字面常量。

import { AUTH_COMPLETION_TTL, EXPIRED_AUTH_CLEANUP } from "../params/registry";

/** 只存 hash/MAC 条目的形状。 */
export interface HashOnlySecretEntry {
  readonly id: string;
  readonly citation: string;
  readonly stores: string;
  readonly note: string;
}

/**
 * 只存 hash/MAC 的秘密类别（id 即类别名，供后续任务卡与 schema 对照）。
 *
 * 口径（2026-09-27 验收更正）：**高熵随机 token（≥ SECRET_BITS）的校验值用 SHA-256**——
 * 输入本身不可猜，带密钥不增加安全性，也不需要额外的密钥用途；**带密钥的 MAC/pepper 只用于
 * 低熵输入**（验证码、邮箱 lookup），因为那里攻击者可以穷举。主方案 §4.5 / §6.1 只要求"只存 hash"。
 */
export const HASH_ONLY_SECRET_STORAGE = [
  {
    id: "session-token",
    citation: "§4.5",
    stores: "token_hash（SHA-256；高熵随机 token，P2-03 已按此实现）",
    note: "会话 token 常态只存 hash，不放 URL、localStorage 或配置导出；唯一的短期交付例外是完成回执密文（见 auth-completion-receipt）",
  },
  {
    id: "recovery-code",
    citation: "§4.6",
    stores: "高熵秘密的 hash",
    note: "服务端只存 hash；重新显示旧码不可行；普通偏好导出、日志和邮箱通知不得包含恢复码",
  },
  {
    id: "feed-token-verification",
    citation: "§6.1",
    stores: "token_hash（SHA-256；高熵随机 token）",
    note: "Feed token 的校验值；token_ciphertext 仅是供所有者再次复制的受控密文例外（见 feed-token-owner-copy）",
  },
  {
    id: "otp-verification-mac",
    citation: "§4.3",
    stores:
      "带独立 pepper 的 MAC（绑定用途、challenge_id、email_key、地址版本、generation、验证码）",
    note: "验证表不存验证码原值；原值只存在于短期加密发信载荷（见 otp-mail-payload）。服务器在发送阶段能解密该载荷——这是短期受控密文，不是「不可读取」",
  },
  {
    id: "push-receipt-token",
    citation: "§7.8",
    stores: "receipt_token_hash（SHA-256；高熵随机 token，ADR-0025）",
    note: "receipt 窄能力只确认本浏览器接收；明文只在创建/重新登记的响应里交给本浏览器一次，存在浏览器本机，不能取邮箱、改账号或管理其他设备",
  },
  {
    id: "push-activation-challenge",
    citation: "§7.8",
    stores:
      "activation_challenges_json（本轮已发出挑战的 SHA-256，至多 PUSH_ACTIVATION_ATTEMPTS 个）",
    note: "挑战明文只出现在端到端加密的激活通知里；激活、暂停或期满即清空",
  },
  {
    id: "push-endpoint-lookup",
    citation: "§8.1",
    stores: "endpoint_hash（SHA-256；同端点唯一键）",
    note: "endpoint 唯一不授权：只用于同端点同所有者幂等、不同所有者冲突；端点本身另存受控密文（见 push-endpoint）",
  },
] as const satisfies readonly HashOnlySecretEntry[];

/** 只存 hash/MAC 的秘密类别类型。 */
export type HashOnlySecretKind = (typeof HASH_ONLY_SECRET_STORAGE)[number]["id"];

/** 受控密文条目的形状（hardClearBoundSeconds 仅短期类别有）。 */
export interface ControlledCiphertextEntryShape {
  readonly id: string;
  readonly citation: string;
  readonly why: string;
  readonly clearRule: string;
  readonly hardClearBoundSeconds?: number;
}

/**
 * 受控密文类别（§8.3：有明确理由的例外，必须可解密）。
 * id 即认证加密的记录类型（AAD 的一部分），不得与 HashOnlySecretKind 重合。
 */
export const CONTROLLED_CIPHERTEXT_STORAGE = [
  {
    id: "otp-mail-payload",
    citation: "§4.3",
    why: "发信任务在发送阶段必须读出验证码原值写入邮件；发送后即失去保留理由",
    clearRule:
      "接受、消费、过期或终止后清除验证码原值；到期挑战由清理任务兜底（不套用 MAIL_METADATA_TTL）",
    hardClearBoundSeconds: EXPIRED_AUTH_CLEANUP,
  },
  {
    id: "auth-completion-receipt",
    citation: "§4.4",
    why: "避免提交成功但 Cookie 响应丢失迫使用户再次收码：客户端可在短期内重新取得同一待激活会话的待交付 Cookie 值",
    clearRule:
      "客户端携 Cookie 完成激活后立即清除可恢复值；到期由清理任务兜底；不保留长期可重放的登录结果",
    hardClearBoundSeconds: AUTH_COMPLETION_TTL,
  },
  {
    id: "feed-token-owner-copy",
    citation: "§6.1",
    why: "长期凭证「只存 hash」的明示例外：所有者需要再次复制同一 Feed 地址，可恢复性依赖字段密钥保护",
    clearRule: "停用永久撤销当前 token；再次启用或重置生成新 token，旧密文随之失效清除",
  },
  {
    id: "delivery-email-address",
    citation: "§4.1",
    why: "保存加密的已验证实际投递地址：已有身份再次登录时验证码只发数据库中已验证的实际地址，不按请求中的地址改投",
    clearRule: "换邮箱原子更新（§4.7）；删除账号清除（§9.6）；明文形态只存在于加密信封内",
  },
  {
    id: "push-endpoint",
    citation: "§8.1",
    why: "发送 Web Push 必须向浏览器给出的端点发请求；端点是能力 URL，不进日志、导出或前端视图",
    clearRule:
      "绑定删除即清除；删除账号随绑定分页清理（§9.6）；暂停或失效超过 PUSH_STALE_GRACE 由回收清理",
  },
  {
    id: "push-keys",
    citation: "§8.1",
    why: "RFC 8291 端到端加密需要浏览器的 p256dh 公钥与 auth 秘密；服务器不保存可解密载荷的私钥",
    clearRule: "与 push-endpoint 同一行同时清除；同端点换了密钥时原子替换并要求重新激活",
  },
] as const satisfies readonly ControlledCiphertextEntryShape[];

/** 受控密文类别类型 = 认证加密的记录类型（AAD 组成部分）。 */
export type CiphertextRecordType = (typeof CONTROLLED_CIPHERTEXT_STORAGE)[number]["id"];

/** 受控密文条目（含清除规则元数据；hardClearBoundSeconds 引用参数注册表）。 */
export type ControlledCiphertextEntry = (typeof CONTROLLED_CIPHERTEXT_STORAGE)[number];

/**
 * 完成回执密文的最大可存活秒数——直接引用注册表，供 P2 消费与测试对账。
 * §4.4："回执仅在 AUTH_COMPLETION_TTL 内、pending 状态且原浏览器上下文匹配时可取。"
 */
export const AUTH_COMPLETION_RECEIPT_MAX_SECONDS: number = AUTH_COMPLETION_TTL;
