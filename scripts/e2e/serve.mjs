#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
// F1-05：Playwright 使用的前台静态服务。只读取本次 astro build 的 dist。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4173;
const DIST = path.resolve(fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)));
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// F1-06 获准接线：规则只来自构建产物，不在服务器重复定义路由。
const rewrites = (await readFile(path.join(DIST, "_redirects"), "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith("#"))
  .map((line) => {
    const match = /^(\/[^\s*?#:]+)\*\s+(\/[^\s*?#:]+)\s+200$/.exec(line.trim());
    if (
      !match ||
      match[1].startsWith("//") ||
      match[2].startsWith("//") ||
      match[2].split("/").some((part) => part === ".." || part === ".") ||
      match[2].includes("\\")
    )
      throw new Error("E2E _redirects 仅支持站内 200 + 尾部通配改写");
    return { prefix: match[1], target: match[2] };
  });

function portOwner() {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : "监听者信息不可用（可运行 lsof -nP -iTCP:4173 -sTCP:LISTEN 查询）";
}

async function serve(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${PORT}`).pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }

  // P5-04: 仅此测试服务加载夹具；不复制到 dist，不改生产改写规则。
  if (pathname === "/__test/p5-release/a11y" || pathname === "/__test/p5-release/a11y.js") {
    const fixture = path.resolve("tests/e2e/fixtures/p5-release");
    if (pathname.endsWith(".js")) {
      const require = createRequire(path.resolve("apps/worker/node_modules/wrangler/package.json"));
      const { build } = require("esbuild");
      const result = await build({
        entryPoints: [path.join(fixture, "a11y.ts")],
        bundle: true,
        write: false,
        format: "esm",
      });
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(request.method === "HEAD" ? undefined : result.outputFiles[0].text);
    } else {
      const layout = await readFile(path.join(DIST, "help/index.html"), "utf8");
      const content = await readFile(path.join(fixture, "a11y.html"), "utf8");
      const html = layout.replace(
        /(<main[^>]*>)[\s\S]*?(<\/main>)/,
        (_match, open, close) => open + content + close,
      );
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : html);
    }
    return;
  }
  const rewritten = rewrites.find((rule) => pathname.startsWith(rule.prefix))?.target ?? pathname;
  const filePath = path.resolve(DIST, `.${rewritten}`);
  if (filePath !== DIST && !filePath.startsWith(`${DIST}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const target = (await stat(filePath)).isDirectory()
      ? path.join(filePath, "index.html")
      : filePath;
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    const body = request.method === "HEAD" ? undefined : await readFile(target);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(target)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && error.message !== "not a file") {
      console.error("E2E 静态文件读取失败：", error);
      response.writeHead(500);
    } else {
      response.writeHead(404);
    }
    response.end();
  }
}

const server = createServer((request, response) => {
  void serve(request, response);
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`E2E 端口 ${PORT} 已被占用：\n${portOwner()}`);
  } else {
    console.error("E2E 静态服务启动失败：", error);
  }
  process.exitCode = 1;
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`E2E 静态服务： http://127.0.0.1:${PORT}/ → ${DIST}`);
});
