// P6 测试支撑（仅 *.test.ts 消费）：合成 VAPID 配置、合成浏览器订阅与推送服务替身。
// 全部密钥在测试内随机生成，不指向任何真实推送服务或真实环境；推送服务替身不发网络请求。
import { env } from "cloudflare:test";
import { testKeyring } from "../shell/test-support";
import { toBase64Url, utf8Decode, utf8Encode } from "../storage/crypto/bytes";
import type { PushTransport } from "./client";
import type { PushConfig } from "./config";
import { ecdhParams, importVapidKeys } from "./crypto";
import type { PushDeps } from "./service";

export const SITE = "https://app.test";

export async function testPushConfig(): Promise<PushConfig> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { vapid: await importVapidKeys(JSON.stringify(jwk)), subject: SITE };
}

export interface SyntheticSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
}
const HOSTS = {
  fcm: "https://fcm.googleapis.com/fcm/send/",
  mozilla: "https://updates.push.services.mozilla.com/wpush/v2/",
  apple: "https://web.push.apple.com/",
  wns: "https://wns2-sg2p.notify.windows.com/w/?token=",
} as const;
export async function subscription(
  service: keyof typeof HOSTS = "fcm",
): Promise<SyntheticSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: `${HOSTS[service]}synthetic-${crypto.randomUUID()}`,
    keys: { p256dh: toBase64Url(publicRaw), auth: toBase64Url(auth) },
    privateKey: pair.privateKey,
    publicRaw,
    auth,
  };
}

export interface CapturedPush {
  url: string;
  headers: Headers;
  body: Uint8Array;
}
type Reply = number | "throws" | { status: number; retryAfter: string };
/** 推送服务替身：按队列给出状态码（默认 201）；`throws` 模拟超时/网络异常。 */
export class FakePushService {
  readonly requests: CapturedPush[] = [];
  private readonly queue: Reply[] = [];
  private readonly perEndpoint = new Map<string, Reply[]>();
  respond(...statuses: Reply[]): this {
    this.queue.push(...statuses);
    return this;
  }
  /** 只对某个端点生效的应答（多条消息的外发顺序不确定时用）。 */
  respondTo(endpoint: string, ...statuses: Reply[]): this {
    this.perEndpoint.set(endpoint, [...(this.perEndpoint.get(endpoint) ?? []), ...statuses]);
    return this;
  }
  readonly transport: PushTransport = async (input, init) => {
    const body = new Uint8Array(init.body as ArrayBuffer);
    this.requests.push({ url: input, headers: new Headers(init.headers), body });
    const next = this.perEndpoint.get(input)?.shift() ?? this.queue.shift() ?? 201;
    if (next === "throws") throw new Error("synthetic_network_failure");
    if (typeof next === "number") return new Response(null, { status: next });
    return new Response(null, { status: next.status, headers: { "retry-after": next.retryAfter } });
  };
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(info) },
      key,
      length * 8,
    ),
  );
}
/** 浏览器一侧解密（RFC 8291），返回载荷 JSON：证明只有订阅私钥能读到内容。 */
export async function openPush(
  sub: SyntheticSubscription,
  captured: CapturedPush,
): Promise<Record<string, unknown>> {
  const body = captured.body;
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const senderPublic = body.slice(21, 21 + idlen);
  const sender = await crypto.subtle.importKey(
    "raw",
    buffer(senderPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams(sender), sub.privateKey, 256),
  );
  const ikm = await hkdf(
    sub.auth,
    shared,
    new Uint8Array([...utf8Encode("WebPush: info\0"), ...sub.publicRaw, ...senderPublic]),
    32,
  );
  const cek = await hkdf(salt, ikm, utf8Encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8Encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", buffer(cek), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(nonce) },
      key,
      buffer(body.slice(21 + idlen)),
    ),
  );
  return JSON.parse(utf8Decode(plain.slice(0, -1))) as Record<string, unknown>;
}

export async function pushDeps(
  service: FakePushService,
  config: PushConfig | null,
): Promise<PushDeps> {
  return {
    db: env.DB,
    keys: () => testKeyring,
    config: async () => config,
    transport: service.transport,
  };
}

export async function openPushControls(db: D1Database): Promise<void> {
  await db.batch(
    ["push_enabled", "outbound_enabled", "read_only"].map((key) =>
      db
        .prepare(
          "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        )
        .bind(key, key === "read_only" ? "false" : "true"),
    ),
  );
}
