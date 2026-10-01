import { SECRET_BITS } from "@hoyo/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toBase64Url, utf8Encode } from "../storage/crypto/bytes";
import { verifyAccess } from "./access";

const issuer = "https://synthetic-team.cloudflareaccess.com";
const config = { ADMIN_ACCESS_ISSUER: issuer, ADMIN_ACCESS_AUD: "synthetic-aud" };
const now = 1_900_000_000_000;
let pair: CryptoKeyPair;
let publicKey: JsonWebKey;
beforeAll(async () => {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: SECRET_BITS * 8,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) throw new Error("Expected RSA key pair");
  pair = generated;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!("kty" in exported)) throw new Error("Expected JWK");
  publicKey = exported;
});
const claims = {
  iss: issuer,
  aud: [config.ADMIN_ACCESS_AUD],
  sub: "synthetic-subject",
  type: "app",
  exp: now / 1_000 + 1,
  nbf: now / 1_000,
};
async function token(
  payload: unknown = claims,
  header: unknown = { alg: "RS256", kid: "synthetic-key" },
) {
  const input = [header, payload]
    .map((value) => toBase64Url(utf8Encode(JSON.stringify(value))))
    .join(".");
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    utf8Encode(input),
  );
  return `${input}.${toBase64Url(new Uint8Array(signature))}`;
}
const fetchKeys = vi.fn<typeof fetch>(async () =>
  Response.json({ keys: [{ ...publicKey, kid: "synthetic-key", use: "sig" }] }),
);
const request = (jwt: string) =>
  new Request("https://app.test/api/v2/admin/session/access", {
    headers: { "cf-access-jwt-assertion": jwt },
  });

describe("A-P3-ADMIN Access 完整 JWT 合同（本地签名与公钥替身）", () => {
  it("验签成功且 issuer/audience/exp/nbf 匹配才生成非邮箱身份", async () => {
    const result = await verifyAccess(request(await token()), config, now, fetchKeys);
    expect(result).toMatchObject({ expiresAt: now + 1_000 });
    expect(result?.adminId).toMatch(/^access:[0-9a-f]+$/);
    expect(fetchKeys).toHaveBeenCalledWith(
      `${issuer}/cdn-cgi/access/certs`,
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it("错签名、缺签名、none 算法、错 kid、可控公钥头均失败关闭", async () => {
    const valid = await token();
    const changed =
      valid.slice(0, valid.lastIndexOf(".") + 1) +
      (valid.at(valid.lastIndexOf(".") + 1) === "A" ? "B" : "A") +
      valid.slice(valid.lastIndexOf(".") + 2);
    for (const jwt of [
      changed,
      valid.split(".").slice(0, 2).join("."),
      await token(claims, { alg: "none", kid: "synthetic-key" }),
      await token(claims, { alg: "RS256", kid: "missing" }),
      await token(claims, { alg: "RS256", kid: "synthetic-key", jku: "https://other.test" }),
    ])
      expect(await verifyAccess(request(jwt), config, now, fetchKeys)).toBeNull();
  });
  it("wrong aud/iss、过期边界、未来 nbf、无 exp/subject、非 app 令牌全部拒绝", async () => {
    for (const patch of [
      { aud: ["another-aud"] },
      { iss: "https://other.cloudflareaccess.com" },
      { exp: now / 1_000 },
      { nbf: now / 1_000 + 1 },
      { exp: undefined },
      { sub: "" },
      { type: "org" },
      { exp: "future" },
      { nbf: null },
    ])
      expect(
        await verifyAccess(request(await token({ ...claims, ...patch })), config, now, fetchKeys),
      ).toBeNull();
  });
  it("配置缺失/团队域非法、公钥响应错误及重复 kid 拒绝，无真实联网", async () => {
    const req = request(await token());
    for (const invalid of [
      {},
      { ADMIN_ACCESS_ISSUER: issuer },
      { ...config, ADMIN_ACCESS_ISSUER: "https://other.test" },
    ])
      expect(await verifyAccess(req, invalid, now, fetchKeys)).toBeNull();
    for (const response of [
      new Response("failure", { status: 503 }),
      Response.json({
        keys: [
          { ...publicKey, kid: "synthetic-key" },
          { ...publicKey, kid: "synthetic-key" },
        ],
      }),
    ])
      expect(
        await verifyAccess(
          req,
          config,
          now,
          vi.fn<typeof fetch>(async () => response),
        ),
      ).toBeNull();
  });
});
