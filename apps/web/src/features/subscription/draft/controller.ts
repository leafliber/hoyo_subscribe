import { type DraftIdentity, DraftStorage } from "../../../lib/storage/drafts";
import {
  DRAFT_IDENTITY_EVENT,
  publishDraftIdentity,
  readConfirmedDraftIdentity,
  readDraftIdentityEvent,
} from "../../../lib/storage/identity";
import { GUEST_HANDOFF_KEY } from "../../auth/return-path";
import { csrfToken, type Draft, type Phase, type SubscriptionSaveMachine } from "../save/machine";
import { exportPreferences, importPreferences } from "./preferences";

export class SubscriptionDraftController {
  private readonly storage = new DraftStorage();
  private identity: DraftIdentity = csrfToken() ? { status: "unknown" } : { status: "guest" };
  private marker = csrfToken();
  private generation = 0;
  private identifying = false;
  private applyingConfirmation = false;
  private suspended = false;
  private channel: BroadcastChannel | null = null;
  private edits = 0;
  private phase: Phase = "guest";
  private pending = false;
  private persisted = false;
  private storageFailed = false;
  private guestHandoff = false;
  private readonly status = document.createElement("p");
  private readonly result = document.createElement("p");
  private readonly input = document.createElement("input");
  private readonly exportButton = document.createElement("button");

  constructor(
    private readonly host: {
      form: HTMLFormElement;
      readDraft(): Draft;
      machine(): SubscriptionSaveMachine;
      reset(): SubscriptionSaveMachine;
      readIdentity?(): Promise<DraftIdentity>;
    },
  ) {
    const section = document.createElement("details");
    section.className = "card local-preferences";
    section.setAttribute("aria-labelledby", "local-preferences-heading");
    const summary = document.createElement("summary");
    const heading = document.createElement("h2");
    heading.id = "local-preferences-heading";
    heading.textContent = "导入或导出设置";
    this.status.id = "local-draft-status";
    this.status.className = "local-status";
    this.status.setAttribute("role", "status");
    summary.append(heading, this.status);
    const body = document.createElement("div");
    body.className = "local-body";
    this.result.id = "preference-result";
    this.result.className = "result-message";
    this.result.setAttribute("role", "status");
    const note = document.createElement("p");
    note.className = "text-aux";
    note.textContent =
      "导出的文件只包含订阅设置，不含邮箱、恢复码或日历链接。导入后会先和当前设置比较，保存后才生效。未保存的修改会暂存在本机（不加密，按账号隔离）。";
    const label = document.createElement("label");
    label.className = "button button--secondary file-button";
    const labelText = document.createElement("span");
    labelText.textContent = "导入偏好 JSON";
    this.input.type = "file";
    this.input.accept = ".json,application/json";
    this.input.className = "visually-hidden";
    label.append(labelText, this.input);
    this.exportButton.className = "button button--secondary";
    this.exportButton.type = "button";
    this.exportButton.textContent = "导出当前偏好";
    const actions = document.createElement("div");
    actions.className = "button-row";
    actions.append(label, this.exportButton);
    body.append(note, actions, this.result);
    section.append(summary, body);
    const slot = document.getElementById("local-preferences-slot");
    if (slot) slot.replaceChildren(section);
    else host.form.after(section);
    this.input.addEventListener("change", () => void this.importFile());
    this.exportButton.addEventListener("click", () => this.exportFile());
    window.addEventListener("online", () => this.network());
    window.addEventListener("offline", () => this.network());
    document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
      const identity = readDraftIdentityEvent(event);
      if (identity) {
        // 页面首次确认沿用当前编辑；只把真正的身份切换广播给其他标签页。
        if (this.applyingConfirmation) {
          this.identity = identity;
          return;
        }
        this.channel?.postMessage("invalidate");
        void this.switchIdentity(identity);
      }
    });
    this.connectChannel();
    // BFCache 恢复不得直接重现先前的私人内存视图。
    window.addEventListener("pagehide", () => {
      this.channel?.close();
      this.channel = null;
      this.invalidate();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        this.connectChannel();
        void this.start();
      }
    });
  }

  private connectChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel("hoyo-draft-identity");
    // 只广播失效信号，不广播 user_id、草稿或会话标识。
    this.channel.onmessage = () => {
      void this.switchIdentity({ status: "unknown" });
    };
  }

  /** 页面状态呈现用：只暴露确认进度，不暴露 user_id。 */
  identityStatus(): DraftIdentity["status"] {
    return this.identity.status;
  }

  /** 每个异步响应写 UI 前再检查会话边界；标识仅留内存，不落盘。 */
  current(): boolean {
    if (this.suspended) return false;
    if (this.marker === csrfToken()) return true;
    this.invalidate();
    return false;
  }

  private invalidate(): void {
    this.suspended = false;
    this.identifying = false;
    this.marker = csrfToken();
    this.identity = this.marker ? { status: "unknown" } : { status: "guest" };
    this.generation += 1;
    this.edits += 1;
    this.pending = false;
    this.persisted = false;
    this.storageFailed = false;
    this.guestHandoff = false;
    this.result.textContent = "身份已变化，已清除原账号的内存视图。";
    this.input.value = "";
    this.host.reset();
    this.paint("guest");
  }

  async switchIdentity(identity: DraftIdentity): Promise<void> {
    this.invalidate();
    this.identity = identity;
    if (identity.status === "unknown") {
      this.suspended = true;
      this.host.machine().dispose();
      this.paint("guest");
      return;
    }
    await this.start();
  }

  async start(): Promise<void> {
    const generation = this.generation;
    const edits = this.edits;
    if (this.identity.status === "unknown" && this.marker) {
      this.identifying = true;
      this.paint(this.phase);
      const identity = await (this.host.readIdentity?.() ?? readConfirmedDraftIdentity());
      if (!this.current() || generation !== this.generation) return;
      this.identifying = false;
      this.applyingConfirmation = true;
      publishDraftIdentity(identity);
      this.applyingConfirmation = false;
      // /me 未完成时的编辑也属于当前已确认身份，不能在确认时清空。
      if (this.edits !== edits && this.pending) void this.persist(this.host.readDraft());
    }
    const local = this.storage.read(this.identity).catch(() => {
      if (generation === this.generation) this.storageFailed = true;
      return null;
    });
    let handoff = false;
    if (this.identity.status === "confirmed") {
      try {
        const marker = sessionStorage.getItem(GUEST_HANDOFF_KEY);
        handoff =
          marker === "pending" || marker === JSON.stringify({ userId: this.identity.userId });
        if (marker && !handoff) sessionStorage.removeItem(GUEST_HANDOFF_KEY);
        if (handoff)
          sessionStorage.setItem(
            GUEST_HANDOFF_KEY,
            JSON.stringify({ userId: this.identity.userId }),
          );
      } catch {
        /* Storage denied: never guess which account owns a continuation. */
        handoff = false;
        this.storageFailed = true;
      }
    }
    const guest = handoff
      ? this.storage.read({ status: "guest" }).catch(() => {
          if (generation === this.generation) this.storageFailed = true;
          return null;
        })
      : Promise.resolve(null);
    await this.host.machine().start(this.identity.status !== "guest");
    const [accountRow, guestRow] = await Promise.all([local, guest]);
    if (!this.current() || generation !== this.generation || edits !== this.edits) return;
    const row = guestRow ?? accountRow;
    this.guestHandoff = guestRow !== null;
    if (guestRow && this.identity.status === "confirmed") {
      this.result.textContent = accountRow
        ? "正在比较本次登录前的游客草稿；此账号原有本机草稿仍保留，选择保留游客草稿后才替换。"
        : "已找回登录前的游客草稿，请先比较，再选择采用云端或继续编辑。";
    }
    if (row) {
      this.pending = true;
      this.persisted = true;
      this.host.machine().stageDraft(row.config);
    }
    this.paint(this.phase);
  }

  /** Only an explicit login entry carries a guest draft into an account. */
  async prepareLogin(): Promise<boolean> {
    if (!this.current() || this.identifying) return false;
    if (this.identity.status !== "guest") return true;
    const generation = this.generation;
    try {
      sessionStorage.removeItem(GUEST_HANDOFF_KEY);
      if (this.pending || this.edits > 0) {
        await this.storage.write({ status: "guest" }, this.host.readDraft());
        if (!this.current() || generation !== this.generation || this.identity.status !== "guest")
          return false;
        sessionStorage.setItem(GUEST_HANDOFF_KEY, "pending");
      }
      return true;
    } catch {
      this.result.textContent = "无法保留登录前的草稿；请先导出偏好备份，再从登录页继续。";
      return false;
    }
  }

  async keepDraft(): Promise<void> {
    if (!this.current()) return;
    const guestHandoff = this.guestHandoff;
    if (guestHandoff) {
      const generation = this.generation;
      const edits = this.edits;
      try {
        await this.storage.write(this.identity, this.host.readDraft());
      } catch {
        this.result.textContent = "无法保存此账号的本机草稿；游客草稿仍保留，请导出备份后重试。";
        return;
      }
      if (!this.current() || generation !== this.generation || edits !== this.edits) return;
      this.guestHandoff = false;
      try {
        sessionStorage.removeItem(GUEST_HANDOFF_KEY);
      } catch {
        /* No credential stored. */
      }
      void this.storage.write({ status: "guest" }, null).catch(() => undefined);
    }
    this.host.machine().keepDraft();
    this.edited();
  }

  edited(): void {
    if (!this.current()) return;
    this.edits += 1;
    this.pending = this.phase !== "saved";
    void this.persist(this.pending ? this.host.readDraft() : null);
  }

  private async persist(config: Draft | null): Promise<void> {
    const generation = this.generation;
    const edits = this.edits;
    this.persisted = false;
    this.paint(this.phase);
    try {
      const guestHandoff = this.guestHandoff;
      await this.storage.write(guestHandoff ? { status: "guest" } : this.identity, config);
      if (!this.current() || generation !== this.generation || edits !== this.edits) return;
      if (guestHandoff && config === null) {
        this.guestHandoff = false;
        try {
          sessionStorage.removeItem(GUEST_HANDOFF_KEY);
        } catch {
          /* No credential stored. */
        }
      }
      this.persisted = this.identity.status !== "unknown" && config !== null;
      this.storageFailed = false;
    } catch {
      if (generation !== this.generation || edits !== this.edits) return;
      this.storageFailed = true;
    }
    this.paint(this.phase);
  }

  paint(phase: Phase): void {
    this.phase = phase;
    this.input.disabled = this.identifying || phase === "saving" || phase === "loading";
    // 初次读到云端并不删除尚未完成读取的本机草稿。
    if (phase === "saved" && this.pending) {
      this.pending = false;
      this.edits += 1;
      void this.persist(null);
    }
    if (this.storageFailed)
      this.status.textContent = "无法暂存本机草稿，修改只在当前页面中，建议先导出备份。";
    else if (this.identity.status === "unknown")
      this.status.textContent = "正在确认账号身份，修改暂时只在当前页面中。";
    else if (this.pending && this.persisted)
      this.status.textContent = navigator.onLine
        ? "未保存的修改已暂存在本机，尚未同步到云端。"
        : "当前离线：修改已暂存在本机，联网后需要手动保存。";
    else if (this.pending) this.status.textContent = "正在暂存本机修改…";
    else
      this.status.textContent = navigator.onLine
        ? "修改不会自动提交，需要点击保存。"
        : "当前离线；修改不会自动提交。";
  }

  private network(): void {
    if (!this.current()) return;
    this.paint(this.phase);
    // 联网事件不读取私人 API、不补提交、不续期或开启通道。
  }

  async save(): Promise<void> {
    if (!this.current() || this.identifying) return;
    if (!navigator.onLine) {
      this.paint(this.phase);
      return;
    }
    await this.host.machine().save();
  }

  async refresh(recheck = false): Promise<void> {
    if (!this.current() || this.identifying || this.identity.status === "guest") return;
    if (recheck) await this.host.machine().recheck();
    else await this.host.machine().refresh();
  }

  discarded(): void {
    this.pending = false;
    this.edits += 1;
    void this.persist(null);
  }

  private async importFile(): Promise<void> {
    const file = this.input.files?.[0];
    if (!file || !this.current()) return;
    const generation = this.generation;
    const edits = this.edits;
    try {
      const text = await file.text();
      if (!this.current() || generation !== this.generation || edits !== this.edits) return;
      const draft = importPreferences(text);
      if (!draft) {
        this.result.textContent = "文件来自尚未初始化的订阅，没有可导入的偏好。当前草稿未改变。";
        return;
      }
      if (this.phase === "saving") return;
      this.host.machine().stageDraft(draft);
      this.edited();
      this.result.textContent = "已生成可比较草稿；尚未保存到云端，也未开启接收方式。";
    } catch {
      if (generation === this.generation)
        this.result.textContent = "偏好文件校验失败。当前草稿未改变；请使用本站导出的 JSON 文件。";
    } finally {
      if (generation === this.generation) this.input.value = "";
    }
  }

  private exportFile(): void {
    if (!this.current()) return;
    try {
      const text = exportPreferences(this.host.readDraft());
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "hoyo-preferences.json";
      link.click();
      URL.revokeObjectURL(url);
      this.result.textContent = "已生成仅含白名单设置的偏好文件；不包含身份、秘密或通道同意。";
    } catch {
      this.result.textContent = "当前设置不完整，暂不能导出；请检查必选项。";
    }
  }
}
