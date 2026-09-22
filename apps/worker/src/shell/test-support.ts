// shell 测试共享支撑：测试密钥环、桩鉴权器、请求构造（仅 *.test.ts 消费）。
import { SECRET_BITS } from "@hoyo/contracts";
import { Keyring } from "../storage/crypto/keyring";

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 每个测试文件独立构造的测试密钥环（随机根秘密；不指向任何真实环境）。 */
export const testKeyring: Promise<Keyring> = Keyring.create({
  masterSecret: randomBytes(SECRET_BITS / 8),
  otpPepper: randomBytes(SECRET_BITS / 8),
  unsubscribeMacCurrentKeyId: "test-key",
});

export const fakeEnv = {} as Env;

export const fakeExecutionContext = {
  waitUntil() {},
} as unknown as ExecutionContext;

/** 站点源（同源测试用）。 */
export const SITE_ORIGIN = "https://app.test";

export function siteUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}
