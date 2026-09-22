// 认证存在性敏感结果的折叠机制（任务卡 P1-08 交付物二；主方案 §4.2 末段、§8.2 末段）。
//
// 折叠的完整含义（本模块 + contracts/errors/existence.ts 共同保证）：
//  1. 响应体结构相同——公开响应只从 contracts 的固定模板构造，模板不携带任何随
//     输入变化的字段；
//  2. HTTP 状态码相同；
//  3. 响应大小相同——字节级相同蕴含大小相同（测试用 assertResponsesFolded 核对）；
//  4. 时序不泄露——两条内部路径都必须完成**等成本**的一单元校验形工作
//     （runExistenceFold 强制二选一执行：真实路径跑真校验，未注册路径跑同形状的
//     必败 MAC 验证，而不是提前返回）。等成本指同一数量级、同形状的一次 HMAC
//     验证；数据库访问等差异由调用方在 real/dummy 中自行配平，P2 路由验收
//     （A-P2-PREAUTH）复核。
//
// API 设计上折叠不可绕过：runExistenceFold 返回 void，分支信息不外泄——调用方拿不到
// "存在/不存在"，也就无法据此分化响应；公开响应唯一出口是 publicAuthIntentResponse。
import {
  AUTH_INTENT_PUBLIC_BODY,
  AUTH_INTENT_PUBLIC_STATUS,
  type OtpMacKey,
} from "@hoyo/contracts";
import { toHex } from "../storage/crypto/bytes";
import { verifyOtpMac } from "../storage/crypto/mac";
import { generateOtpCode } from "../storage/crypto/random";

/** 一单元存在性敏感的校验形工作；两条路径各提供自己的实现。 */
export interface ExistenceFoldWork {
  /** 真实路径：对真实输入做完整校验（含真实 MAC 验证与等价工作量）。 */
  readonly real: () => Promise<void>;
  /** 未注册路径：与 real 同形状、同数量的必败校验（不得提前返回）。 */
  readonly dummy: () => Promise<void>;
}

/**
 * 执行存在性折叠的工作量配平：exists 只决定**做哪份工作**，不影响返回值（恒 void）。
 * 调用方随后无条件用 publicAuthIntentResponse() 构造公开响应。
 */
export async function runExistenceFold(exists: boolean, work: ExistenceFoldWork): Promise<void> {
  if (exists) {
    await work.real();
  } else {
    await work.dummy();
  }
}

/**
 * 存在性敏感响应的唯一构造出口：字节恒定（contracts 固定模板、键序由字面量固定）。
 * 已注册、未注册、满额、关闭注册四条路径都只能用它。
 */
export function publicAuthIntentResponse(): Response {
  return new Response(JSON.stringify(AUTH_INTENT_PUBLIC_BODY), {
    status: AUTH_INTENT_PUBLIC_STATUS,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 随机 hex 字符串（长度为偶数），用于拼出与真实记录同形状的假字段。 */
function randomHexChars(chars: number): string {
  const bytes = new Uint8Array(chars / 2);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * 与真实 verifyOtpMac 等成本的必败验证：同形状绑定（各字段与真实记录同长度量级）、
 * 随机 OTP_DIGITS 位验证码、随机 SHA-256 长度 MAC——恰好触发一次 HMAC verify，结果
 * 必为 false 且被丢弃。P2 未注册分支用它配平"已注册才做真校验"的时序差。
 */
export async function dummyOtpMacVerify(key: OtpMacKey): Promise<void> {
  await verifyOtpMac(
    key,
    {
      purpose: "existence-fold",
      challengeId: randomHexChars(32),
      emailKey: randomHexChars(64),
      addressVersion: 0,
      generation: 0,
      code: generateOtpCode(),
    },
    randomHexChars(64),
  );
}
