#!/usr/bin/env node
// P6（ADR-0025）：生成 Web Push 的 VAPID 密钥对（ECDSA P-256）。只在本机运行，不联网。
//
// 用法（所有者在源码外的部署环境执行；$VAPID_FILE 指向仓库外、与 .hbk 备份不同介质的加密离线位置）：
//   node scripts/push/generate-vapid.mjs --out "$VAPID_FILE"
//   （再在 apps/worker 目录）pnpm exec wrangler secret put PUSH_VAPID_PRIVATE_JWK --config "$P504_DEPLOY_CONFIG" < "$VAPID_FILE"
//
// --out 以权限 0600 新建文件写入私钥 JWK：目标已存在（含符号链接）即拒绝、不覆盖——覆盖等于换钥，
// 会让全部现有订阅失效；目标在仓库内也拒绝。这份离线副本就是主方案 §10.2「VAPID 分开保管」的那一份：
// 灾备恢复或重建 Worker 时用它重新注入同一把密钥。它不进仓库、备份包、对话或工单。
// 不带 --out 时私钥只写 stdout，且只允许交给管道：终端拒绝打印，除非显式加 --print。
// stderr 输出对应的公钥（applicationServerKey，不是秘密），供与 GET /api/v2/me/push-bindings 的
// application_server_key 核对。这把密钥一旦投入使用就不要轮换，除非确认泄露（ADR-0025）。
import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
if (outIndex >= 0 && (!out || out.startsWith("--"))) refuse("--out 需要一个文件路径。");

if (out) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const inside = relative(repo, resolve(out));
  if (inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)))
    refuse("拒绝把私钥写进仓库目录：请指向仓库外的加密离线位置。");
} else if (process.stdout.isTTY && !args.includes("--print")) {
  refuse(
    "拒绝把私钥打印到终端。请用 --out 写到仓库外的离线位置，或用管道交给 wrangler secret put（见文件头部用法）；确需打印时加 --print。",
  );
}

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const text = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });

if (out) {
  try {
    // wx：已存在（含悬空符号链接）即失败，绝不覆盖已投入使用的密钥。
    writeFileSync(resolve(out), text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    refuse(
      error?.code === "EEXIST"
        ? "目标文件已存在，拒绝覆盖：覆盖等于换钥，会让全部现有浏览器订阅失效。"
        : "写入私钥文件失败；请检查目录是否存在且可写。",
    );
  }
  process.stderr.write("已以权限 0600 写入私钥文件。\n");
} else {
  process.stdout.write(text);
}
process.stderr.write(
  `VAPID 公钥（applicationServerKey，可公开）：${Buffer.from(publicRaw).toString("base64url")}\n`,
);
