// 全量快照差分与水位（任务卡 P3-01，验收 ID A-P3-FETCH）。
// 核心：三类变化都要能识别；新增含"比历史最大 ann_id 更小"的条目——重叠窗口不按最大 ID 推进。

import { describe, expect, it } from "vitest";
import {
  advanceFullSnapshotWatermark,
  announcementFingerprint,
  diffPageAgainstFingerprints,
  diffSnapshotRecords,
  miyousheFingerprint,
  type SnapshotRecord,
} from "./snapshot-diff";
import type { SourceItemStub } from "./types";

function record(externalId: string, fingerprint: string): SnapshotRecord {
  return { externalId, fingerprint };
}

function annStub(overrides: Partial<SourceItemStub> & { externalId: string }): SourceItemStub {
  return {
    sourceId: "genshin-ann",
    title: "标题",
    subtitle: null,
    typeLabel: "游戏公告",
    tagLabel: null,
    listStartTime: "2026-09-21 11:10:00",
    listEndTime: "2026-09-23 06:00:00",
    bannerUrl: null,
    coverUrl: null,
    imageUrls: [],
    publisherUid: null,
    hasContent: true,
    publishedAtMs: null,
    ...overrides,
  };
}

describe("A-P3-FETCH 全量快照差分：新增/消失/内容变化", () => {
  it("三类变化同时识别，unchangedCount 如实", () => {
    const previous = [
      record("21928", "a"),
      record("21904", "b"),
      record("21876", "c"),
      record("21862", "d"),
    ];
    const next = [
      record("21928", "a"), // 不变
      record("21904", "b-changed"), // 内容变化
      record("21800", "e"), // 新增，且 id 小于历史最大 21928
      record("21862", "d"), // 不变（21876 消失）
    ];
    const diff = diffSnapshotRecords(previous, next);
    expect(diff.added).toEqual(["21800"]);
    expect(diff.removed).toEqual(["21876"]);
    expect(diff.changed).toEqual([{ externalId: "21904", previous: "b", next: "b-changed" }]);
    expect(diff.unchangedCount).toBe(2);
  });

  it("空上次快照：全部记为新增（首轮发现）", () => {
    const diff = diffSnapshotRecords([], [record("762", "x"), record("21928", "y")]);
    expect(diff.added).toEqual(["762", "21928"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("整体清空表现为全部 removed（由调用方按缺口处理，不自动取消事件）", () => {
    const diff = diffSnapshotRecords([record("1", "a"), record("2", "b")], []);
    expect(diff.removed).toEqual(["1", "2"]);
    expect(diff.added).toEqual([]);
  });

  it("水位推进保留整份新快照（重叠窗口的载体），不做最大 ID 压缩", () => {
    const records = [record("762", "x"), record("21928", "y")];
    const watermark = advanceFullSnapshotWatermark(records);
    expect(watermark.model).toBe("full-snapshot");
    expect(watermark.records).toHaveLength(2);
    expect(watermark.records.map((r) => r.externalId)).toEqual(["762", "21928"]);
  });

  it("单页差分（米游社标题级）：新增与变化，不做消失断言", () => {
    const fingerprints = { "78299710": "fp-old", "78299600": "fp-keep" };
    const page = diffPageAgainstFingerprints(
      [record("78299710", "fp-new"), record("78299600", "fp-keep"), record("78299799", "fp-fresh")],
      fingerprints,
    );
    expect(page.added).toEqual(["78299799"]);
    expect(page.changed).toEqual([{ externalId: "78299710", previous: "fp-old", next: "fp-new" }]);
  });
});

describe("A-P3-FETCH 语义指纹", () => {
  it("同输入同指纹；列表字段或正文 hash 变化即指纹变化", async () => {
    const stub = annStub({ externalId: "21928", title: "7.1版本更新维护预告" });
    const fp1 = await announcementFingerprint(stub, "content-hash-1");
    const fp2 = await announcementFingerprint({ ...stub }, "content-hash-1");
    const fpContent = await announcementFingerprint(stub, "content-hash-2");
    const fpTitle = await announcementFingerprint({ ...stub, title: "改题" }, "content-hash-1");
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fpContent);
    expect(fp1).not.toBe(fpTitle);
  });

  it("正文缺位（null）与拿到正文（有 hash）是不同指纹：后续批次如实表现为一次变化", async () => {
    const stub = annStub({ externalId: "21904" });
    const before = await announcementFingerprint(stub, null);
    const after = await announcementFingerprint(stub, "sha:abc");
    expect(before).not.toBe(after);
  });

  it("米游社标题级指纹只覆盖标题/图片级信息", async () => {
    const base: SourceItemStub = {
      ...annStub({ externalId: "78299710" }),
      sourceId: "miyoushe-news",
      coverUrl: "https://upload-bbs.miyoushe.com/upload/a.png",
      imageUrls: ["https://upload-bbs.miyoushe.com/upload/a.png"],
    };
    const fp1 = await miyousheFingerprint(base);
    const fpSame = await miyousheFingerprint({ ...base, publishedAtMs: 123 });
    const fpCover = await miyousheFingerprint({
      ...base,
      coverUrl: "https://upload-bbs.miyoushe.com/upload/b.png",
    });
    expect(fp1).toBe(fpSame);
    expect(fp1).not.toBe(fpCover);
  });
});
