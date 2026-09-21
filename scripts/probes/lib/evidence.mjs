// P0-01 探针共用：证据信封与落盘（Node 专用；Worker 侧不使用本文件）。
// 证据文件命名规范：docs/evidence/p0/<probe>-<YYYYMMDDTHHMMSS>Z.json（见 docs/evidence/p0/README.md）。
// 信封里的 run_environment 用于区分"本机/本地 wrangler/目标 Cloudflare 环境"；
// 目标环境（remote）证据才可用于 G-P0 放行（docs/ACCEPTANCE.md §2 的证据等级）。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const EVIDENCE_DIR_DEFAULT = path.join(REPO_ROOT, "docs", "evidence", "p0");

/** UTC 时间戳戳记，文件名安全：YYYYMMDDTHHMMSSZ */
export function utcStamp(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** @param {string} text */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * @param {{ probe: string, runEnvironment: Record<string, unknown>, results: unknown, notes?: string[] }} input
 */
export function buildEnvelope({ probe, runEnvironment, results, notes = [] }) {
  if (!probe) throw new Error("probe 名称必填");
  return {
    probe,
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    run_environment: runEnvironment,
    results,
    notes,
  };
}

/**
 * 写入证据文件；同一秒内重复写入同 probe 时追加序号避免覆盖。
 * @param {Record<string, unknown>} envelope
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string>} 实际写入的绝对路径
 */
export async function writeEvidenceFile(envelope, options = {}) {
  const dir = options.dir ?? EVIDENCE_DIR_DEFAULT;
  await mkdir(dir, { recursive: true });
  const probe = String(envelope.probe);
  let file = path.join(dir, `${probe}-${utcStamp()}.json`);
  for (let seq = 2; existsSync(file); seq += 1) {
    file = path.join(dir, `${probe}-${utcStamp()}-${String(seq).padStart(2, "0")}.json`);
  }
  await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return file;
}
