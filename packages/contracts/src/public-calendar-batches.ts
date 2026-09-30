// P3-06：纯 JSON 字节分块，不分割单条记录，不裁剪集合。
import { PUBLIC_SNAPSHOT_WRITE_PROFILE } from "./params/registry";
export function publicSnapshotJsonChunks(values: readonly unknown[]): readonly string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let parts: string[] = [],
    bytes = 2;
  for (const value of values) {
    const json = JSON.stringify(value);
    const size = encoder.encode(json).length;
    if (size + 2 > PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes)
      throw new Error("SQLITE_TOOBIG: public snapshot record exceeds chunk budget");
    if (bytes + size + Number(parts.length > 0) > PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes) {
      chunks.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 2;
    }
    bytes += size + Number(parts.length > 0);
    parts.push(json);
  }
  if (parts.length) chunks.push(`[${parts.join(",")}]`);
  return chunks;
}
