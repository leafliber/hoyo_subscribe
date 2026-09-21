// A-P0-PROBE · 证据信封与落盘的单元测试（L1，纯函数 + 临时目录 IO）
// 运行：node --test scripts/probes/lib/

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildEnvelope, sha256Hex, utcStamp, writeEvidenceFile } from "./evidence.mjs";

describe("A-P0-PROBE 证据文件命名与信封", () => {
  it("utcStamp 产出 YYYYMMDDTHHMMSSZ", () => {
    assert.match(utcStamp(new Date("2026-09-22T05:06:07.089Z")), /^20260922T050607Z$/);
  });

  it("sha256Hex 输出 64 位十六进制", () => {
    assert.match(sha256Hex("abc"), /^[0-9a-f]{64}$/);
  });

  it("buildEnvelope 缺 probe 名时抛错", () => {
    assert.throws(() => buildEnvelope({ runEnvironment: {}, results: {} }), /probe/);
  });

  it("writeEvidenceFile 写出带信封的 JSON 文件，命名符合规范", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "p0-probe-evidence-"));
    const envelope = buildEnvelope({
      probe: "unit-test-probe",
      runEnvironment: { type: "local-node", label: "unit-test" },
      results: { ok: true },
      notes: ["测试"],
    });
    const file = await writeEvidenceFile(envelope, { dir });
    assert.match(path.basename(file), /^unit-test-probe-\d{8}T\d{6}Z\.json$/);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.probe, "unit-test-probe");
    assert.equal(written.schema_version, 1);
    assert.equal(typeof written.generated_at_utc, "string");
    assert.deepEqual(written.run_environment, { type: "local-node", label: "unit-test" });
  });

  it("同一秒重复写入同 probe 时文件名不覆盖（追加序号）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "p0-probe-evidence-"));
    const envelope = buildEnvelope({
      probe: "collide-probe",
      runEnvironment: { type: "local-node", label: "unit-test" },
      results: { n: 1 },
    });
    const fileA = await writeEvidenceFile(envelope, { dir });
    const fileB = await writeEvidenceFile({ ...envelope, results: { n: 2 } }, { dir });
    assert.notEqual(fileA, fileB);
    const names = await readdir(dir);
    assert.equal(names.length, 2);
  });
});
