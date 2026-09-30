import { describe, expect, it } from "vitest";
import { PUBLIC_SNAPSHOT_WRITE_PROFILE } from "./params/registry";
import { publicSnapshotJsonChunks } from "./public-calendar-batches";

describe("P3-06 UTF-8 字节分块", () => {
  it("中文转义内容超过 D1 单值仍无损分块，空集合不写，单记录过大明确拒绝", () => {
    const rows = Array.from({ length: 1200 }, (_, id) => ({ id, text: '中😀\\"'.repeat(400) }));
    const bytes = (value: string) => new TextEncoder().encode(value).length;
    expect(bytes(JSON.stringify(rows))).toBeGreaterThan(
      PUBLIC_SNAPSHOT_WRITE_PROFILE.singleValueBytes,
    );
    const chunks = publicSnapshotJsonChunks(rows);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => bytes(chunk) <= PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes)).toBe(
      true,
    );
    expect(chunks.flatMap((chunk) => JSON.parse(chunk))).toEqual(rows);
    expect(publicSnapshotJsonChunks([])).toEqual([]);
    expect(() =>
      publicSnapshotJsonChunks(["中".repeat(PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes)]),
    ).toThrow("SQLITE_TOOBIG");
  });
});
