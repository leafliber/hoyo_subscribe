// A-P6-SEND · Web Push 加密与 VAPID（RFC 8291 附录 A 测试向量；RFC 8292；ADR-0025）。
import { PUSH_MAX_PLAINTEXT_BYTES } from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "../storage/crypto/bytes";
import {
  decodeBrowserBase64Url,
  ecdhParams,
  encryptPushPayload,
  importSubscriptionPublicKey,
  importVapidKeys,
  PushConfigError,
  PushPayloadTooLargeError,
  vapidAuthorization,
} from "./crypto";

function b64(value: string): Uint8Array {
  const bytes = fromBase64Url(value);
  if (!bytes) throw new Error(`bad base64url: ${value}`);
  return bytes;
}
function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
/** 从未压缩公钥拆出 JWK 坐标，配合私钥标量 d 组成私钥 JWK。 */
function privateJwk(publicRaw: Uint8Array, d: string): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(publicRaw.slice(1, 33)),
    y: toBase64Url(publicRaw.slice(33, 65)),
    d,
  };
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buffer(salt),
        info: buffer(typeof info === "string" ? utf8Encode(info) : info),
      },
      key,
      length * 8,
    ),
  );
}
/** 浏览器一侧的解密（测试专用）：证明加密结果只能由订阅私钥解开。 */
async function decrypt(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublic: Uint8Array,
  auth: Uint8Array,
) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const senderPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const sender = await crypto.subtle.importKey(
    "raw",
    buffer(senderPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(sender), uaPrivate, 256));
  const info = new Uint8Array([...utf8Encode("WebPush: info\0"), ...uaPublic, ...senderPublic]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", buffer(cek), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(nonce) }, key, buffer(ciphertext)),
  );
  expect(plain.at(-1)).toBe(2);
  return { rs, idlen, text: utf8Decode(plain.slice(0, -1)) };
}

// RFC 8291 附录 A 的公开测试向量（不是任何真实环境的密钥）。
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("A-P6-SEND RFC 8291 aes128gcm 端到端加密", () => {
  it("固定发送方密钥与 salt 时逐字节复现 RFC 8291 附录 A 的消息", async () => {
    const asPublic = b64(VECTOR.asPublic);
    const body = await encryptPushPayload(
      {
        uaPublic: b64(VECTOR.uaPublic),
        authSecret: b64(VECTOR.auth),
        plaintext: utf8Encode(VECTOR.plaintext),
      },
      {
        senderPrivateJwk: privateJwk(asPublic, VECTOR.asPrivate),
        senderPublic: asPublic,
        salt: b64(VECTOR.salt),
      },
    );
    expect(toBase64Url(body)).toBe(VECTOR.message);
  });

  it("生产路径每条消息换一次性发送方密钥与 salt，只有订阅私钥能解开", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const uaPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer,
    );
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const text = JSON.stringify({ v: 1, title: "合成测试", body: "synthetic" });
    const first = await encryptPushPayload({
      uaPublic,
      authSecret: auth,
      plaintext: utf8Encode(text),
    });
    const second = await encryptPushPayload({
      uaPublic,
      authSecret: auth,
      plaintext: utf8Encode(text),
    });
    expect(toBase64Url(first.slice(0, 16))).not.toBe(toBase64Url(second.slice(0, 16)));
    expect(toBase64Url(first.slice(21, 86))).not.toBe(toBase64Url(second.slice(21, 86)));
    const opened = await decrypt(first, ua.privateKey, uaPublic, auth);
    expect(opened).toEqual({ rs: 4096, idlen: 65, text });
    const wrongAuth = crypto.getRandomValues(new Uint8Array(16));
    await expect(decrypt(first, ua.privateKey, uaPublic, wrongAuth)).rejects.toThrow();
  });

  it("超过单记录上限的明文拒绝外发；非法公钥与 auth 拒绝", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const uaPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer,
    );
    const auth = new Uint8Array(16);
    const max = new Uint8Array(PUSH_MAX_PLAINTEXT_BYTES).fill(0x61);
    const body = await encryptPushPayload({ uaPublic, authSecret: auth, plaintext: max });
    expect(body.byteLength).toBe(4096);
    await expect(
      encryptPushPayload({ uaPublic, authSecret: auth, plaintext: new Uint8Array(max.length + 1) }),
    ).rejects.toBeInstanceOf(PushPayloadTooLargeError);
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 4;
    expect(await importSubscriptionPublicKey(offCurve)).toBeNull();
    await expect(
      encryptPushPayload({ uaPublic: offCurve, authSecret: auth, plaintext: max.slice(0, 1) }),
    ).rejects.toBeInstanceOf(PushConfigError);
    await expect(
      encryptPushPayload({ uaPublic, authSecret: new Uint8Array(15), plaintext: max.slice(0, 1) }),
    ).rejects.toBeInstanceOf(PushConfigError);
    expect(decodeBrowserBase64Url(`${toBase64Url(auth)}==`)).toEqual(auth);
  });
});

describe("A-P6-SEND RFC 8292 VAPID", () => {
  async function generatedJwk(): Promise<JsonWebKey> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  }

  it("ES256 JWT 的 aud 为端点 origin、exp 不超过 24 小时，签名可用公钥验证", async () => {
    const jwk = await generatedJwk();
    const keys = await importVapidKeys(JSON.stringify(jwk));
    const now = 1_900_000_000_000;
    const header = await vapidAuthorization(
      keys,
      "https://fcm.googleapis.com",
      "https://app.test",
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match as RegExpExecArray;
    expect(JSON.parse(utf8Decode(b64(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(utf8Decode(b64(c)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://app.test");
    expect(claims.exp).toBeGreaterThan(now / 1000);
    expect(claims.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600);
    expect(k).toBe(keys.publicKey);
    expect(b64(k)).toHaveLength(65);
    const verifier = await crypto.subtle.importKey(
      "raw",
      buffer(b64(k)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        buffer(b64(s)),
        buffer(utf8Encode(`${h}.${c}`)),
      ),
    ).toBe(true);
  });

  it("JWK 缺字段、错曲线、坐标长度不对或点不在曲线上都视为未配置", async () => {
    const jwk = await generatedJwk();
    for (const broken of [
      "not json",
      JSON.stringify({ ...jwk, crv: "P-384" }),
      JSON.stringify({ ...jwk, d: undefined }),
      JSON.stringify({ ...jwk, x: toBase64Url(new Uint8Array(31)) }),
      JSON.stringify({ ...jwk, y: toBase64Url(new Uint8Array(32).fill(1)) }),
    ])
      await expect(importVapidKeys(broken)).rejects.toBeInstanceOf(PushConfigError);
  });
});
