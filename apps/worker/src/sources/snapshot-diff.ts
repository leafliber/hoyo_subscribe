// 全量快照差分与水位（任务卡 P3-01，验收 ID A-P3-FETCH）。
//
// 合同依据：主方案 §3.2——普通轮询保留重叠窗口，**不能仅按最大 ID 推进水位**；
// 近期公告复查正文，仍关联活跃节点的公告继续跟踪。
//
// P0-02 实测：三公告 API 不分页，单请求即全集。因此"重叠窗口"的落点是：
// 水位保存**整份上次成功快照的指纹集合**，每次拿到全集后与它整体差分——
// 新增（含比最大 ann_id 更小的 id）、消失、内容变化三类都要能识别。
// 推进 = 用新全集整体替换旧集合，绝不存在"只记最大 ID"的捷径。

import type { MiyousheNewsType, SourceItemStub } from "./types";

/** 指纹集合中的一条：externalId → 语义指纹（列表字段 + 正文 hash 由适配器侧拼装）。 */
export interface SnapshotRecord {
  readonly externalId: string;
  readonly fingerprint: string;
}

export interface SnapshotChange {
  readonly externalId: string;
  readonly previous: string;
  readonly next: string;
}

export interface SnapshotDiff {
  /** 上次没有、这次出现（含 external_id 数值小于历史最大者）。 */
  readonly added: readonly string[];
  /** 上次有、这次消失（全集语义下即从官方列表退出）。 */
  readonly removed: readonly string[];
  /** 两次都在但指纹变化（标题/时间/栏目/正文任一变化）。 */
  readonly changed: readonly SnapshotChange[];
  readonly unchangedCount: number;
}

/** 全集差分：输入两份完整的 (externalId, fingerprint) 集合。 */
export function diffSnapshotRecords(
  previous: readonly SnapshotRecord[],
  next: readonly SnapshotRecord[],
): SnapshotDiff {
  const previousByld = new Map(previous.map((record) => [record.externalId, record.fingerprint]));
  const nextById = new Map(next.map((record) => [record.externalId, record.fingerprint]));

  const added: string[] = [];
  const changed: SnapshotChange[] = [];
  for (const [externalId, fingerprint] of nextById) {
    const previousFingerprint = previousByld.get(externalId);
    if (previousFingerprint === undefined) {
      added.push(externalId);
    } else if (previousFingerprint !== fingerprint) {
      changed.push({ externalId, previous: previousFingerprint, next: fingerprint });
    }
  }
  const removed: string[] = [];
  for (const externalId of previousByld.keys()) {
    if (!nextById.has(externalId)) {
      removed.push(externalId);
    }
  }
  return {
    added,
    removed,
    changed,
    unchangedCount: nextById.size - added.length - changed.length,
  };
}

/**
 * 全量快照型水位。records 是**上次成功快照的完整指纹集合**——这就是重叠窗口本身：
 * 下次全量与整份集合差分，历史条目（id 小于最大值者）的新增/消失/变化都可见。
 */
export interface FullSnapshotWatermark {
  readonly model: "full-snapshot";
  readonly records: readonly SnapshotRecord[];
}

/** 水位推进：仅当本批完整成功时，用新全集整体替换；任何失败由调用方保留旧水位。 */
export function advanceFullSnapshotWatermark(
  next: readonly SnapshotRecord[],
): FullSnapshotWatermark {
  return { model: "full-snapshot", records: next };
}

/** 米游社单类型扫描状态：游标按 last-id-offset 保存（补漏续扫），条目指纹用于标题级差分。 */
export interface MiyousheScanState {
  readonly newsType: MiyousheNewsType;
  /** 保存的偏移量游标（null = 尚未开始或已到达 is_last 后归零，从头重叠重扫）。 */
  readonly lastId: string | null;
  /** 曾到达 is_last（此后每批从头发起，重叠=重扫最新页，可发现新帖与标题级变化）。 */
  readonly reachedLast: boolean;
  /** 已见条目的标题级指纹（post_id → fingerprint）。 */
  readonly fingerprints: Readonly<Record<string, string>>;
}

export interface MiyousheWatermark {
  readonly model: "last-id-offset";
  readonly scans: Readonly<Record<MiyousheNewsType, MiyousheScanState>>;
}

export type SourceWatermark = FullSnapshotWatermark | MiyousheWatermark;

/** 单页条目对已见指纹的差分（米游社标题级）：新增/变化；消失不可见（游标模型限制，见任务卡）。 */
export function diffPageAgainstFingerprints(
  page: readonly SnapshotRecord[],
  fingerprints: Readonly<Record<string, string>>,
): { added: readonly string[]; changed: readonly SnapshotChange[] } {
  const added: string[] = [];
  const changed: SnapshotChange[] = [];
  for (const record of page) {
    const previous = fingerprints[record.externalId];
    if (previous === undefined) {
      added.push(record.externalId);
    } else if (previous !== record.fingerprint) {
      changed.push({ externalId: record.externalId, previous, next: record.fingerprint });
    }
  }
  return { added, changed };
}

// ---------- 指纹拼装（来源无关的哈希工具 + 两个来源的语义指纹） ----------

/** UTF-8 SHA-256 十六进制（Workers WebCrypto）。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 稳定序列化：键排序的紧凑 JSON，保证同语义输入得到同指纹。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 公告条目语义指纹：列表字段 + 正文 hash（正文取不到时以 null 占位参与指纹——
 * 拿到正文后 hash 从 null 变为实际值会正确表现为一次"变化"）。
 * 列表展示时间参与指纹（官方改展示窗口是可观测修订），但它是展示时间，不是活动时间（§3.1）。
 */
export async function announcementFingerprint(
  stub: SourceItemStub,
  contentSha256: string | null,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      title: stub.title,
      subtitle: stub.subtitle,
      typeLabel: stub.typeLabel,
      tagLabel: stub.tagLabel,
      listStartTime: stub.listStartTime,
      listEndTime: stub.listEndTime,
      bannerUrl: stub.bannerUrl,
      contentSha256,
    }),
  );
}

/** 米游社条目标题级指纹（仅标题/图片级信息；正文通道维护态，不声称有正文）。 */
export async function miyousheFingerprint(stub: SourceItemStub): Promise<string> {
  return sha256Hex(
    canonicalJson({
      title: stub.title,
      coverUrl: stub.coverUrl,
      imageUrls: stub.imageUrls,
    }),
  );
}
