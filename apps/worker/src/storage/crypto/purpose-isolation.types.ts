// A-P1-CRYPTO · 用途混用的类型层证明（任务卡 P1-06 交付物一；主方案 §8.3）。
//
// 本文件**不运行**（vitest 只收 *.test.ts），由 `pnpm typecheck`（tsc --noEmit）检查：
// 每处 `@ts-expect-error` 标记的用法都必须是编译错误——用途混用在类型层面不可能。
// 若有人弱化品牌（把 PurposeTag 拿掉、把参数类型放宽），对应行变为合法，
// tsc 会因「未使用的 @ts-expect-error 指令」而失败，类型隔离即被守护。
// 运行时隔离（派生密钥不同、输出可分辨）由 keyring.test.ts 覆盖。

import type {
  AdminKey,
  CsrfKey,
  EmailLookupKey,
  FieldEncryptionKey,
  OtpMacKey,
  PreauthCookieKey,
  RecoveryEpochKey,
  UnsubscribeMacKeys,
  VapidKey,
} from "@hoyo/contracts";
import { decryptField, type EncryptedRecordRef, encryptField } from "./aead";
import {
  computeEmailKey,
  computePurposeMac,
  macOtpVerification,
  macPreauthCookie,
  type OtpMacBinding,
  verifyOtpMac,
  verifyPreauthCookieMac,
} from "./mac";
import {
  signUnsubscribeToken,
  type UnsubscribeBinding,
  verifyUnsubscribeToken,
} from "./unsubscribe";

declare const otpKey: OtpMacKey;
declare const emailLookupKey: EmailLookupKey;
declare const fieldKey: FieldEncryptionKey;
declare const unsubscribeKeys: UnsubscribeMacKeys;
declare const csrfKey: CsrfKey;
declare const vapidKey: VapidKey;
declare const adminKey: AdminKey;
declare const recoveryEpochKey: RecoveryEpochKey;
declare const preauthCookieKey: PreauthCookieKey;

declare const binding: OtpMacBinding;
declare const unsubscribeBinding: UnsubscribeBinding;
declare const record: EncryptedRecordRef;
declare const bytes: Uint8Array;
declare const text: string;

/** 交叉混用矩阵：以下每一行都是编译错误。函数永不调用。 */
export function purposeMisuseMustNotCompile(): void {
  // OTP 密钥 → 退订 MAC（任务卡点名的场景）
  // @ts-expect-error OtpMacKey 不是 UnsubscribeMacKeys
  void signUnsubscribeToken(otpKey, unsubscribeBinding);
  // @ts-expect-error OtpMacKey 不是 UnsubscribeMacKeys
  void verifyUnsubscribeToken(otpKey, text, unsubscribeBinding);

  // OTP 密钥 → 邮箱 lookup / 字段加密 / 通用用途 MAC
  // @ts-expect-error OtpMacKey 不是 EmailLookupKey
  void computeEmailKey(otpKey, text);
  // @ts-expect-error OtpMacKey 不是 FieldEncryptionKey
  void encryptField(otpKey, record, text);
  // @ts-expect-error OtpMacKey 不在 GeneralMacKey（csrf/vapid/admin/recovery-epoch）联合内
  void computePurposeMac(otpKey, text, text);
  // @ts-expect-error OtpMacKey 不是 EmailLookupKey
  void computePurposeMac(emailLookupKey, text, text);

  // 退订密钥组 → 其他用途
  // @ts-expect-error UnsubscribeMacKeys 不是 OtpMacKey
  void macOtpVerification(unsubscribeKeys, binding);
  // @ts-expect-error UnsubscribeMacKeys 不是 FieldEncryptionKey
  void decryptField(unsubscribeKeys, record, bytes);

  // 邮箱 lookup 密钥 → 其他用途
  // @ts-expect-error EmailLookupKey 不是 OtpMacKey
  void verifyOtpMac(emailLookupKey, binding, text);
  // @ts-expect-error EmailLookupKey 不是 UnsubscribeMacKeys
  void signUnsubscribeToken(emailLookupKey, unsubscribeBinding);

  // 字段加密密钥 → 任何 MAC 用途
  // @ts-expect-error FieldEncryptionKey 不是 OtpMacKey
  void macOtpVerification(fieldKey, binding);
  // @ts-expect-error FieldEncryptionKey 不在 GeneralMacKey 联合内
  void computePurposeMac(fieldKey, text, text);

  // CSRF 密钥 → OTP / 退订 / 字段加密
  // @ts-expect-error CsrfKey 不是 OtpMacKey
  void macOtpVerification(csrfKey, binding);
  // @ts-expect-error CsrfKey 不是 UnsubscribeMacKeys
  void signUnsubscribeToken(csrfKey, unsubscribeBinding);
  // @ts-expect-error CsrfKey 不是 FieldEncryptionKey
  void encryptField(csrfKey, record, text);

  // VAPID / 管理员 / 恢复 epoch 密钥 → 专属用途的操作
  // @ts-expect-error VapidKey 不是 OtpMacKey
  void macOtpVerification(vapidKey, binding);
  // @ts-expect-error AdminKey 不是 UnsubscribeMacKeys
  void verifyUnsubscribeToken(adminKey, text, unsubscribeBinding);
  // @ts-expect-error RecoveryEpochKey 不是 FieldEncryptionKey
  void decryptFieldTextWrongPurpose(recoveryEpochKey);

  // 预认证 Cookie 密钥（P2-01 验收增补用途）→ 其他用途；CSRF/OTP 密钥 → 预认证 Cookie
  // @ts-expect-error PreauthCookieKey 不是 OtpMacKey
  void macOtpVerification(preauthCookieKey, binding);
  // @ts-expect-error PreauthCookieKey 不在 GeneralMacKey（csrf/vapid/admin/recovery-epoch）联合内
  void computePurposeMac(preauthCookieKey, text, text);
  // @ts-expect-error PreauthCookieKey 不是 EmailLookupKey
  void computeEmailKey(preauthCookieKey, text);
  // @ts-expect-error CsrfKey 不是 PreauthCookieKey（验收点名：预认证 Cookie 不复用 CSRF 密钥）
  void macPreauthCookie(csrfKey, { preauthId: text, issuedAt: 0, expiresAt: 1 });
  // @ts-expect-error OtpMacKey 不是 PreauthCookieKey
  void verifyPreauthCookieMac(otpKey, { preauthId: text, issuedAt: 0, expiresAt: 1 }, text);

  // 句柄之间的赋值混用
  // @ts-expect-error OtpMacKey 不能赋给 UnsubscribeMacKeys
  const _a: UnsubscribeMacKeys = otpKey;
  // @ts-expect-error CsrfKey 不能赋给 FieldEncryptionKey
  const _b: FieldEncryptionKey = csrfKey;
  // @ts-expect-error UnsubscribeMacKeys 不能赋给 AdminKey
  const _c: AdminKey = unsubscribeKeys;
  // @ts-expect-error EmailLookupKey 不能赋给 OtpMacKey
  const _d: OtpMacKey = emailLookupKey;
  // @ts-expect-error RecoveryEpochKey 不能赋给 VapidKey
  const _e: VapidKey = recoveryEpochKey;
  // @ts-expect-error PreauthCookieKey 不能赋给 CsrfKey
  const _f: CsrfKey = preauthCookieKey;
  // @ts-expect-error CsrfKey 不能赋给 PreauthCookieKey
  const _g: PreauthCookieKey = csrfKey;
  void [_a, _b, _c, _d, _e, _f, _g];
}

// 辅助：给上面某行一个「错误用途调 decryptField」的形状（签名要求 FieldEncryptionKey）。
function decryptFieldTextWrongPurpose(_key: FieldEncryptionKey): void {
  // 占位：仅用于类型混用矩阵。
}
