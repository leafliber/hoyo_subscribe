// P6 · Web Push 消息加密与 VAPID 签名（主方案 §7.8、§8.3；RFC 8291、RFC 8188、RFC 8292；ADR-0025）。
//
// - 载荷用 RFC 8291 的 aes128gcm 端到端加密：只有订阅浏览器持有解密私钥，推送服务看不到内容；
//   服务器只保存浏览器的公钥（p256dh）与 auth 秘密（受控密文），每条消息用一次性 ECDH 密钥。
// - VAPID（RFC 8292）用 ES256 签 JWT 向推送服务表明发送方身份。私钥是独立部署秘密
//   PUSH_VAPID_PRIVATE_JWK，不从根秘密派生（§10.2"VAPID……分开保管"；订阅与公钥绑定，
//   根秘密轮换不能让全部订阅失效）。密钥材料只在本模块以不可导出的 CryptoKey 形态存在。
// 全部使用 Workers 内置 WebCrypto，不引入依赖。下列数字都是协议常量，不是业务参数。
import {
  PUSH_AUTH_SECRET_BYTES,
  PUSH_MAX_PLAINTEXT_BYTES,
  PUSH_P256DH_BYTES,
} from "@hoyo/contracts";
import { fromBase64Url, toBase64Url, utf8Encode } from "../storage/crypto/bytes";

/** RFC 8188 记录大小：单条记录即可容纳上限内的明文。 */
const RECORD_SIZE = 4096;
/** RFC 8188 salt 与 AES-128-GCM 的密钥/nonce/标签长度。 */
const SALT_BYTES = 16;
const CEK_BYTES = 16;
const NONCE_BYTES = 12;
const P256_COORDINATE_BYTES = 32;
/** RFC 8292 §2：exp 不得超过请求时刻后 24 小时；每次请求现签，取 1 小时。 */
const VAPID_TOKEN_SECONDS = 3_600;

export class PushPayloadTooLargeError extends Error {
  constructor() {
    super("push_payload_too_large");
    this.name = "PushPayloadTooLargeError";
  }
}
export class PushConfigError extends Error {
  constructor(reason: string) {
    super(`push_config_invalid:${reason}`);
    this.name = "PushConfigError";
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
/** 浏览器给出的 base64url 可能带 '=' 填充；去掉后按规范无填充形态解码。 */
export function decodeBrowserBase64Url(value: string): Uint8Array | null {
  return fromBase64Url(value.replace(/=+$/, ""));
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(info) },
      key,
      length * 8,
    ),
  );
}

/**
 * WebCrypto 的 ECDH 参数名是 `public`（W3C Web Crypto §EcdhKeyDeriveParams）；workers-types 因 C++
 * 关键字把它声明成 `$public`，运行时读的仍是 `public`（RFC 8291 测试向量逐字节通过即证明）。
 * 这里按标准名构造，只在类型层面断言。
 */
export function ecdhParams(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

/** 校验并导入浏览器公钥：必须是 P-256 曲线上的未压缩点（导入失败即拒绝）。 */
export async function importSubscriptionPublicKey(raw: Uint8Array): Promise<CryptoKey | null> {
  if (raw.byteLength !== PUSH_P256DH_BYTES || raw[0] !== 0x04) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      buffer(raw),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
  } catch {
    return null;
  }
}

export interface PushEncryptionInput {
  /** 浏览器 p256dh（65 字节未压缩点）。 */
  readonly uaPublic: Uint8Array;
  /** 浏览器 auth 秘密（16 字节）。 */
  readonly authSecret: Uint8Array;
  readonly plaintext: Uint8Array;
}
/** 仅供 RFC 8291 附录 A 测试向量：固定发送方临时密钥与 salt。生产调用不得传入。 */
export interface PushEncryptionFixture {
  readonly senderPrivateJwk: JsonWebKey;
  readonly senderPublic: Uint8Array;
  readonly salt: Uint8Array;
}

/** RFC 8291 §3–§4：单记录 aes128gcm 消息体（头部 + 密文）。 */
export async function encryptPushPayload(
  input: PushEncryptionInput,
  fixture?: PushEncryptionFixture,
): Promise<Uint8Array> {
  if (input.plaintext.byteLength > PUSH_MAX_PLAINTEXT_BYTES) throw new PushPayloadTooLargeError();
  if (input.authSecret.byteLength !== PUSH_AUTH_SECRET_BYTES)
    throw new PushConfigError("auth_secret");
  const uaKey = await importSubscriptionPublicKey(input.uaPublic);
  if (uaKey === null) throw new PushConfigError("p256dh");
  let senderPrivate: CryptoKey;
  let senderPublic: Uint8Array;
  if (fixture) {
    senderPrivate = await crypto.subtle.importKey(
      "jwk",
      fixture.senderPrivateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    senderPublic = fixture.senderPublic;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
  }
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams(uaKey), senderPrivate, 256),
  );
  const ikm = await hkdf(
    input.authSecret,
    shared,
    concat(utf8Encode("WebPush: info\0"), input.uaPublic, senderPublic),
    32,
  );
  const salt = fixture?.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const cek = await hkdf(salt, ikm, utf8Encode("Content-Encoding: aes128gcm\0"), CEK_BYTES);
  const nonce = await hkdf(salt, ikm, utf8Encode("Content-Encoding: nonce\0"), NONCE_BYTES);
  const aes = await crypto.subtle.importKey("raw", buffer(cek), "AES-GCM", false, ["encrypt"]);
  // 单记录即最后一条记录：明文后接 0x02 分隔符，不加填充（RFC 8188 §2）。
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buffer(nonce), tagLength: 128 },
      aes,
      buffer(concat(input.plaintext, Uint8Array.of(2))),
    ),
  );
  const header = new Uint8Array(SALT_BYTES + 4 + 1 + senderPublic.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, RECORD_SIZE);
  header[SALT_BYTES + 4] = senderPublic.byteLength;
  header.set(senderPublic, SALT_BYTES + 5);
  return concat(header, sealed);
}

export interface VapidKeys {
  readonly privateKey: CryptoKey;
  /** base64url 未压缩公钥：浏览器 applicationServerKey 与 Authorization 的 k 参数。 */
  readonly publicKey: string;
}

/**
 * 从部署秘密导入 VAPID 密钥：JSON Web Key（kty=EC、crv=P-256、x、y、d）。
 * 形状或曲线点不合法时抛 PushConfigError（调用方视为"未配置"，不降级）。
 */
export async function importVapidKeys(jwkText: string): Promise<VapidKeys> {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(jwkText) as Record<string, unknown>;
  } catch {
    throw new PushConfigError("jwk_json");
  }
  const coordinate = (name: "x" | "y" | "d") => {
    const value = jwk[name];
    const bytes = typeof value === "string" ? fromBase64Url(value) : null;
    if (bytes === null || bytes.byteLength !== P256_COORDINATE_BYTES)
      throw new PushConfigError(`jwk_${name}`);
    return { text: value as string, bytes };
  };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new PushConfigError("jwk_curve");
  const x = coordinate("x");
  const y = coordinate("y");
  const d = coordinate("d");
  let privateKey: CryptoKey;
  try {
    // 公钥先单独导入：点不在曲线上时这里失败，避免私钥与公钥不配套。
    await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: x.text, y: y.text },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: x.text, y: y.text, d: d.text },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new PushConfigError("jwk_import");
  }
  d.bytes.fill(0);
  return { privateKey, publicKey: toBase64Url(concat(Uint8Array.of(4), x.bytes, y.bytes)) };
}

/** RFC 8292 §2–§3：`Authorization: vapid t=<JWT>, k=<公钥>`；aud 为推送端点的 origin。 */
export async function vapidAuthorization(
  keys: VapidKeys,
  audience: string,
  subject: string,
  nowMs: number,
): Promise<string> {
  const encode = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_SECONDS,
    sub: subject,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      buffer(utf8Encode(unsigned)),
    ),
  );
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** 高熵 token 的校验值：SHA-256（storage-policy push-receipt-token / push-endpoint-lookup）。 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(utf8Encode(value))));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}
