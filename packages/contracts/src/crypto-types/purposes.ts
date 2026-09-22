// 密钥用途清单与品牌类型（任务卡 P1-06；主方案 §8.3 第一句）。
//
// 合同原文："OTP MAC、邮箱 lookup、字段加密、退订 MAC、CSRF、VAPID、管理员与恢复 epoch
// 用途隔离"。§8.3 的清单是**必须隔离**的下限，不是上限：P2-01 验收（PR #13 复核意见）
// 增补第九个用途 preauth-cookie——预认证 Cookie 的签发/截止 MAC 与 CSRF 是不同威胁面
// （前者认证服务端签发的状态，后者是双提交反 CSRF），隔离由域标签升级为独立派生密钥 +
// 品牌类型。本文件是用途的**唯一清单**：运行时枚举、TS 类型与品牌标记都从这里导出，
// 消费方（apps/worker/src/storage/crypto）不得另写第二份。
//
// 用途混用必须在**类型层面不可能**（任务卡 P1-06 交付物一）：PurposeTag 把用途编进
// phantom 类型参数，运行时不存在任何对应属性——拿 OTP 的密钥句柄去调退订 MAC 是编译错误，
// 而不是靠注释约定。各用途的运行时操作见 worker 侧 crypto 模块；这里只有类型词表。

/** 密钥用途（§8.3 八个 + P2-01 验收增补的 preauth-cookie；顺序即合同原文顺序，增补项居末）。 */
export const KEY_PURPOSES = [
  "otp-mac",
  "email-lookup",
  "field-encryption",
  "unsubscribe-mac",
  "csrf",
  "vapid",
  "admin",
  "recovery-epoch",
  "preauth-cookie",
] as const satisfies readonly string[];

/** 密钥用途类型（§8.3）。 */
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/**
 * phantom 标记符号：仅存在于类型层面（`declare const`，无运行时导出）。
 * 把用途 P 编进句柄类型，使不同用途的句柄互不兼容。
 */
declare const purposeTag: unique symbol;

/** 带用途品牌的不透明密钥句柄形状：用途混用在此处被编译器拒绝。 */
export type PurposeTag<P extends KeyPurpose> = { readonly [purposeTag]: P };

// 各用途的句柄类型。实现（HKDF 派生、CryptoKey 载体）在
// apps/worker/src/storage/crypto/keyring.ts；这里只有类型，前端也可安全 import。

/** OTP MAC 密钥句柄——**独立 pepper** 派生，不与其余用途共根（§4.3）。 */
export type OtpMacKey = PurposeTag<"otp-mac">;

/** 邮箱 lookup HMAC 密钥句柄：email_key = HMAC(lookup_key, canonical_email)（§4.1）。 */
export type EmailLookupKey = PurposeTag<"email-lookup">;

/** 字段加密（认证加密 AES-256-GCM）密钥句柄：受控密文的唯一加密用途（§8.3）。 */
export type FieldEncryptionKey = PurposeTag<"field-encryption">;

/**
 * 退订 MAC 密钥组句柄：签发用当前 key_id，验证接受已配置的 key_id 集合（§7.6）。
 * key_id 随 token 明文携带，正常轮换保留旧 token 验证能力；灾难性撤销把旧 key_id 移出集合。
 */
export type UnsubscribeMacKeys = PurposeTag<"unsubscribe-mac">;

/** CSRF 密钥句柄：预认证/正式会话的 CSRF 绑定 MAC（§8.3；绑定语义属 P1-08/P2）。 */
export type CsrfKey = PurposeTag<"csrf">;

/**
 * VAPID 密钥句柄：为 Push 鉴权预留的隔离派生槽（§8.3）。VAPID 协议自身的 ES256/Ed25519
 * 密钥对在 Push 任务卡处理；本句柄保证该用途的派生材料不被其他用途复用。
 */
export type VapidKey = PurposeTag<"vapid">;

/** 管理员域密钥句柄：普通用户与管理员会话权限域分离（§8.3）。 */
export type AdminKey = PurposeTag<"admin">;

/** 恢复 epoch 密钥句柄：会话使用时核对 auth_epoch 与恢复 epoch（§4.5、§8.3）。 */
export type RecoveryEpochKey = PurposeTag<"recovery-epoch">;

/**
 * 预认证 Cookie MAC 密钥句柄：`__Host-preauth` 值内签发/截止信息的键控认证（§4.3）。
 * 与 CsrfKey 是不同威胁面（服务端签发状态认证 ≠ 双提交反 CSRF），独立派生、
 * 类型互斥（P2-01 验收增补，PR #13）。
 */
export type PreauthCookieKey = PurposeTag<"preauth-cookie">;

/** 全部句柄类型的映射：按 KeyPurpose 索引（供 worker 侧泛型实现与测试遍历用）。 */
export type PurposeKeyOf = {
  readonly "otp-mac": OtpMacKey;
  readonly "email-lookup": EmailLookupKey;
  readonly "field-encryption": FieldEncryptionKey;
  readonly "unsubscribe-mac": UnsubscribeMacKeys;
  readonly csrf: CsrfKey;
  readonly vapid: VapidKey;
  readonly admin: AdminKey;
  readonly "recovery-epoch": RecoveryEpochKey;
  readonly "preauth-cookie": PreauthCookieKey;
};

// ---------------------------------------------------------------------------
// 退订 MAC 的 key_id（§7.6：实现采用带 key_id 的高熵 MAC token）
// ---------------------------------------------------------------------------

/**
 * key_id 合法形状：1–16 个 [a-z0-9-]，且不以 '-' 开头/结尾、不含连续 '--'。
 * 限定小写字符集避免 token 路径段的大小写歧义；纯格式校验，纯函数、Worker/Web 共用。
 */
export function isValidUnsubscribeKeyId(keyId: string): boolean {
  if (keyId.length < 1 || keyId.length > 16) {
    return false;
  }
  if (!/^[a-z0-9-]+$/.test(keyId)) {
    return false;
  }
  return !keyId.startsWith("-") && !keyId.endsWith("-") && !keyId.includes("--");
}
