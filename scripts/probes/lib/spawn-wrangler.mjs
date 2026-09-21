// P0-01 探针共用：以子进程方式启动 `wrangler dev`（本地 miniflare，不需要账户登录），
// 等待 /health 就绪后返回 baseUrl 与 stop()。d1-conditional-tx 与 do-send-location 的本地 runner 使用。
// 目标环境（remote）运行由所有者按 docs/evidence/p0/OWNER_CHECKLIST.md 执行，不经本文件。

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const WRANGLER_COMMAND = process.env.P0_PROBE_WRANGLER_CMD ?? "wrangler@4";

/**
 * @param {{ cwd: string, port: number, extraArgs?: string[], readinessTimeoutMs?: number }} input
 * @returns {Promise<{ baseUrl: string, stop: () => void, logs: string[] }>}
 */
export async function startWranglerDev({
  cwd,
  port,
  extraArgs = [],
  readinessTimeoutMs = 300_000,
}) {
  const logs = [];
  const child = spawn(
    "npx",
    ["--yes", WRANGLER_COMMAND, "dev", "--port", String(port), ...extraArgs],
    {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
        NO_COLOR: "1",
      },
    },
  );
  const append = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) {
        logs.push(line.trim());
      }
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = () => {
    // detached 启动使子进程成为进程组长，杀整组以确保 npx 之下的 wrangler 一并退出
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // 进程已退出
      }
    }
  };

  const deadline = Date.now() + readinessTimeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(
        `wrangler dev 提前退出（exit=${child.exitCode}）。日志尾部：\n${logs.slice(-25).join("\n")}`,
      );
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(
        `wrangler dev 在 ${readinessTimeoutMs}ms 内未就绪（port ${port}）。日志尾部：\n${logs.slice(-25).join("\n")}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return { baseUrl, stop, logs };
      }
    } catch {
      // 尚未就绪，继续等
    }
    await sleep(1_000);
  }
}

/** @param {string} url @param {number} timeoutMs */
export async function fetchJson(url, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
