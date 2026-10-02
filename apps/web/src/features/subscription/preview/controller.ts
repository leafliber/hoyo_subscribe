import "./style.css";
import { PUBLIC_CACHE_FRESH } from "@hoyo/contracts";
import { downloadCalendarNodes, PreviewDataError } from "./data";
import { type PreviewInput, type PreviewState, renderPreview } from "./view";

export class CalendarPreview {
  private input: PreviewInput | null = null;
  private state: PreviewState = {
    snapshot: null,
    sampleAt: null,
    loading: false,
    progress: "",
    error: null,
  };
  private request: AbortController | null = null;
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly root: HTMLElement,
    private readonly current: () => boolean,
  ) {}

  update(input: PreviewInput) {
    if (this.disposed) return;
    if (this.input && input.identityGeneration !== this.input.identityGeneration) this.invalidate();
    this.input = input;
    // Requests contain no configuration. Project only from the latest input after every await.
    this.paint();
    if (!this.request && !this.state.snapshot && !this.state.error) void this.refresh();
  }
  invalidate() {
    this.serial++;
    this.request?.abort();
    this.request = null;
    clearTimeout(this.timer);
    this.input = null;
    this.state = { snapshot: null, sampleAt: null, loading: false, progress: "", error: null };
    this.root.replaceChildren();
  }
  destroy() {
    this.invalidate();
    this.disposed = true;
  }
  private valid(serial: number) {
    return !this.disposed && this.current() && this.serial === serial && this.input !== null;
  }
  private paint() {
    if (this.input && !this.disposed)
      renderPreview(this.root, this.input, this.state, () => void this.refresh());
  }
  private async refresh() {
    if (this.disposed || !this.input || !this.current()) return;
    this.request?.abort();
    clearTimeout(this.timer);
    const request = new AbortController();
    this.request = request;
    const serial = ++this.serial;
    this.state = { ...this.state, sampleAt: null, loading: true, progress: "", error: null };
    this.paint();
    try {
      const snapshot = await downloadCalendarNodes(request.signal, (loaded, total) => {
        if (!this.valid(serial)) return;
        this.state.progress = `已下载 ${loaded} / ${total} 个候选节点；尚未完成核验。`;
        this.paint();
      });
      if (!this.valid(serial)) return;
      this.state = { snapshot, sampleAt: null, loading: false, progress: "", error: null };
      this.timer = setTimeout(
        () => void this.refresh(),
        Math.max(
          0,
          Math.min(snapshot.cache.freshUntil, snapshot.asOf + PUBLIC_CACHE_FRESH * 1000) -
            Date.now(),
        ),
      );
    } catch (error) {
      if (!this.valid(serial) || request.signal.aborted) return;
      const unavailable = error instanceof PreviewDataError && error.unavailable;
      // No partial or stale public dataset is disguised as a successful empty calendar.
      this.state = {
        snapshot: null,
        sampleAt: unavailable ? Date.now() : null,
        loading: false,
        progress: "",
        error: unavailable ? "真实数据暂时取不到" : "公开数据未通过完整性校验",
      };
    } finally {
      if (this.valid(serial)) {
        this.request = null;
        this.paint();
      }
    }
  }
}
