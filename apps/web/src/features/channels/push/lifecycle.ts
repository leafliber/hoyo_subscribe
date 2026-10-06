// F5-01 · 订阅页上浏览器通知卡片的生命周期：身份确认且读到已保存快照后才挂载；
// 身份未知、退出、切换或页面隐藏时销毁，旧请求不能更新新账号视图（与邮件卡片同一做法）。
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import type { Phase, Snapshot } from "../../subscription/save/machine";
import { csrfToken } from "../../subscription/save/machine";
import { PushPanel } from "./panel";

export interface PushChannelHost {
  /** 页面会话边界仍是同一个（草稿控制器的身份核对，与邮件卡片同一来源）。 */
  current(): boolean;
}

export class PushChannelLifecycle {
  private confirmed = false;
  private snapshotRevision: number | null = null;
  private panel: PushPanel | null = null;
  /** 每张卡片一个世代：旧卡片的迟到结果不能借新卡片的身份通过核对。 */
  private generation = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: PushChannelHost,
  ) {
    this.root.hidden = true;
    document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
      const identity = readDraftIdentityEvent(event);
      if (!identity) return;
      this.invalidate();
      this.confirmed = identity.status === "confirmed";
    });
  }

  invalidate(): void {
    this.generation += 1;
    this.confirmed = false;
    this.snapshotRevision = null;
    this.panel?.dispose();
    this.panel = null;
    this.root.hidden = true;
  }

  update(phase: Phase, snapshot: Snapshot | null): void {
    if (!this.confirmed || !snapshot || phase === "loading" || !this.host.current()) return;
    if (!this.panel) {
      const generation = ++this.generation;
      const marker = csrfToken();
      this.panel = new PushPanel(this.root, {
        current: () =>
          this.generation === generation &&
          this.confirmed &&
          marker === csrfToken() &&
          this.host.current(),
      });
      this.snapshotRevision = snapshot.revision;
      void this.panel.refresh(true);
    } else if (this.snapshotRevision !== snapshot.revision) {
      // 首次保存订阅后，"先保存一次订阅内容"的置灰原因随之解除。
      this.snapshotRevision = snapshot.revision;
      void this.panel.refresh(true);
    }
  }
}
