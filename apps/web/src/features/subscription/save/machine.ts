// F2-04 获准跨卡：仅接入本机草稿比较与身份生命周期，保存快照、CAS 和冲突规则不变。
// F2-03：订阅保存的唯一客户端状态机；只提交显式点击时的规范化快照。
import {
  parseSubscriptionConfig,
  SUBSCRIPTION_SCHEMA_VERSION,
  SUPPORTED_SCOPE_REGIONS,
  type SubscriptionConfig,
} from "@hoyo/contracts";
import { feedbackForFailure } from "../../../lib/errors/feedback";

export type Draft = Omit<SubscriptionConfig, "revision">;
export type Snapshot = {
  readonly state: "uninitialized" | "initialized";
  readonly revision: number;
  readonly config: SubscriptionConfig | null;
};
export type Phase = "guest" | "loading" | "saved" | "dirty" | "saving" | "conflict" | "uncertain";

export interface SaveView {
  readDraft(): Draft;
  applyDraft(draft: Draft): void;
  render(phase: Phase, message: string, snapshot: Snapshot | null, draft: Draft): void;
  compare(cloud: Snapshot | null, draft: Draft, visible: boolean): void;
  validation(path: string | undefined): void;
}

const endpoint = "/api/v2/me/subscription";
const csrfCookie = "__Host-hoyo_csrf";

export function csrfToken(): string | null {
  const prefix = `${csrfCookie}=`;
  const value = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function parseSnapshot(value: unknown): Snapshot {
  if (typeof value !== "object" || value === null) throw new Error("invalid_subscription_snapshot");
  const row = value as Record<string, unknown>;
  if (row.state === "uninitialized" && row.revision === 0 && row.config === null) {
    return { state: "uninitialized", revision: 0, config: null };
  }
  if (row.state !== "initialized" || !Number.isSafeInteger(row.revision) || !row.config) {
    throw new Error("invalid_subscription_snapshot");
  }
  const parsed = parseSubscriptionConfig("initialized", row.config);
  if (!parsed.success || parsed.data.revision !== row.revision) {
    throw new Error("invalid_subscription_snapshot");
  }
  return { state: "initialized", revision: row.revision as number, config: parsed.data };
}

/** Worker 与 Web 共用的 schema 负责有限数组去重排序和非空校验。 */
function normalize(input: Draft): Draft | null {
  const parsed = parseSubscriptionConfig("initialized", { ...input, revision: 1 });
  if (!parsed.success) return null;
  const { revision: _revision, ...draft } = parsed.data;
  return draft;
}

function same(
  left: Draft | SubscriptionConfig | null,
  right: Draft | SubscriptionConfig | null,
): boolean {
  if (!left || !right) return left === right;
  const { revision: _leftRevision, ...leftContent } = left as SubscriptionConfig;
  const { revision: _rightRevision, ...rightContent } = right as SubscriptionConfig;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

async function readCloud(): Promise<Snapshot> {
  const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await response.json();
  return parseSnapshot(await response.json());
}

export class SubscriptionSaveMachine {
  private cloud: Snapshot | null = null;
  private phase: Phase = "guest";
  private message = "当前选择尚未保存。";
  private editSerial = 0;
  private readSerial = 0;
  private inFlight = false;
  private compareCloud: Snapshot | null = null;
  private submitted: {
    readonly config: Draft;
    readonly expectedRevision: number;
    readonly editSerial: number;
  } | null = null;

  private active = true;

  constructor(
    private readonly view: SaveView,
    private readonly isCurrent: () => boolean = () => true,
  ) {}

  private current(): boolean {
    return this.active && this.isCurrent();
  }

  dispose(): void {
    this.active = false;
    this.readSerial += 1;
  }

  /** 导入/恢复只进入既有比较流程；绝不写云端或采用文件里的 revision。 */
  stageDraft(draft: Draft): void {
    if (!this.current() || this.inFlight) return;
    this.view.applyDraft(draft);
    this.editSerial += 1;
    this.compareCloud = this.cloud;
    this.phase = "conflict";
    this.message = "本机草稿已载入，请比较后返回编辑；保存后才会在云端生效。";
    this.paint();
  }

  private paint(): void {
    if (!this.current()) return;
    const draft = this.view.readDraft();
    this.view.render(this.phase, this.message, this.cloud, draft);
    this.view.compare(this.compareCloud, draft, this.phase === "conflict");
  }

  async start(readCloud = true): Promise<void> {
    if (!this.current()) return;
    // 游客没有可读的个人配置；CSRF Cookie 是同站可见的会话线索，不是认证判定。
    if (!readCloud || !csrfToken()) {
      this.phase = "guest";
      this.paint();
      return;
    }
    this.phase = "loading";
    this.message = "正在读取云端设置…";
    this.paint();
    await this.refresh();
  }

  edited(): void {
    if (!this.current()) return;
    this.editSerial += 1;
    if (this.phase === "conflict") {
      this.paint();
      return;
    }
    if (this.inFlight) {
      this.message = "保存请求进行中；后续修改仍是本机草稿。";
      this.paint();
      return;
    }
    this.phase =
      this.cloud?.config && same(normalize(this.view.readDraft()), this.cloud.config)
        ? "saved"
        : "dirty";
    this.message = this.phase === "saved" ? "当前选择与云端已保存设置一致。" : "当前选择尚未保存。";
    this.paint();
  }

  async refresh(): Promise<void> {
    if (!this.current()) return;
    if (!csrfToken() || this.inFlight) return;
    const readSerial = ++this.readSerial;
    try {
      const latest = await readCloud();
      if (!this.current() || readSerial !== this.readSerial || this.inFlight) return;
      const changed =
        this.cloud !== null
          ? latest.revision !== this.cloud.revision
          : latest.config !== null && this.editSerial !== 0;
      const hasDraft =
        this.cloud === null
          ? this.editSerial !== 0
          : !same(normalize(this.view.readDraft()), this.cloud.config);
      this.cloud = latest;
      if (changed && hasDraft) {
        this.compareCloud = latest;
        this.phase = "conflict";
        this.message = "另一设备的云端设置已变化，请比较后决定。";
      } else if (latest.config && !hasDraft) {
        this.view.applyDraft(latest.config);
        this.phase = "saved";
        this.message = "已读取云端设置。";
      } else {
        this.phase = latest.config ? "dirty" : "guest";
        this.message = latest.config ? "本机修改尚未保存。" : "尚无已保存订阅；当前是本机预选。";
      }
    } catch (error) {
      if (!this.current() || readSerial !== this.readSerial || this.inFlight) return;
      const feedback = feedbackForFailure(error);
      this.phase = "uncertain";
      this.message = `${feedback.title}。${feedback.nextStep}`;
    }
    this.paint();
  }

  async save(): Promise<void> {
    if (!this.current()) return;
    if (this.inFlight || this.phase === "conflict") return;
    const token = csrfToken();
    if (!token) {
      this.phase = "guest";
      this.message = "请先登录；当前选择未写入云端。";
      this.paint();
      return;
    }
    if (this.cloud === null) {
      await this.refresh();
      if (!this.current() || this.cloud === null || this.compareCloud !== null) return;
    }
    const config = normalize(this.view.readDraft());
    if (!config) {
      this.view.validation(undefined);
      return;
    }
    if (this.cloud.config && same(config, this.cloud.config)) {
      this.phase = "saved";
      this.message = "当前选择与云端已保存设置一致，无需再次保存。";
      this.paint();
      return;
    }
    const submission = {
      config,
      expectedRevision: this.cloud.revision,
      editSerial: this.editSerial,
    };
    this.submitted = submission;
    this.inFlight = true;
    this.readSerial += 1;
    this.phase = "saving";
    this.message = "正在保存云端设置…";
    this.paint();
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({
          expected_revision: submission.expectedRevision,
          config: submission.config,
        }),
      });
      const body: unknown = await response.json();
      if (!this.current()) return;
      if (response.status === 409) {
        const current = (body as { current?: unknown }).current;
        this.enterComparison(
          parseSnapshot(current),
          "云端设置已变化，请比较后决定。当前草稿未覆盖云端。",
        );
      } else if (!response.ok) {
        const feedback = feedbackForFailure(body);
        this.phase = feedback.outcome === "uncertain" ? "uncertain" : "dirty";
        this.message = `${feedback.title}。${feedback.nextStep}`;
        if (feedback.firstInvalidField) this.view.validation(feedback.firstInvalidField);
      } else {
        this.cloud = parseSnapshot(body);
        this.submitted = null;
        const laterEdits = this.editSerial !== submission.editSerial;
        if (!laterEdits && this.cloud.config) this.view.applyDraft(this.cloud.config);
        this.phase = laterEdits ? "dirty" : "saved";
        this.message = laterEdits
          ? "提交时的配置已保存；之后的本机修改仍未保存。"
          : "云端设置已保存。外部日历的更新时间由客户端决定。";
      }
    } catch (_error) {
      if (!this.current()) return;
      this.phase = "uncertain";
      this.message = "保存结果尚不确定，正在重新读取云端核对。";
      await this.reconcile();
    } finally {
      this.inFlight = false;
      this.paint();
    }
  }

  private async reconcile(): Promise<void> {
    const submission = this.submitted;
    if (!submission) return;
    try {
      const latest = await readCloud();
      if (!this.current()) return;
      this.cloud = latest;
      if (
        latest.config &&
        same(latest.config, submission.config) &&
        this.editSerial === submission.editSerial
      ) {
        this.view.applyDraft(latest.config);
        this.phase = "saved";
        this.message = "已从云端确认提交的配置。外部日历的更新时间由客户端决定。";
        this.submitted = null;
      } else {
        this.enterComparison(latest, "保存结果未能与当前草稿一致，请比较云端与本机设置。", false);
      }
    } catch (_error) {
      if (!this.current()) return;
      this.phase = "uncertain";
      this.message = "无法确认保存结果；草稿和提交快照仍保留。请稍后重新读取云端。";
    }
  }

  async recheck(): Promise<void> {
    if (!this.current()) return;
    if (this.submitted) await this.reconcile();
    else await this.refresh();
    this.paint();
  }

  private enterComparison(snapshot: Snapshot, message: string, paint = true): void {
    this.cloud = snapshot;
    this.compareCloud = snapshot;
    this.phase = "conflict";
    this.message = message;
    if (paint) this.paint();
  }

  adoptCloud(): void {
    if (!this.current()) return;
    if (this.phase !== "conflict" || !this.cloud) return;
    if (this.cloud.config) this.view.applyDraft(this.cloud.config);
    this.compareCloud = null;
    this.submitted = null;
    this.phase = this.cloud.config ? "saved" : "guest";
    this.message = "已采用云端设置。";
    this.paint();
  }

  keepDraft(): void {
    if (!this.current()) return;
    if (this.phase !== "conflict") return;
    this.compareCloud = null;
    this.submitted = null;
    this.phase = "dirty";
    this.message = "草稿已保留；下次显式保存将以最新云端版本为基线。";
    this.paint();
  }

  discard(): void {
    if (!this.current()) return;
    if (this.cloud?.config) this.view.applyDraft(this.cloud.config);
    this.compareCloud = null;
    this.submitted = null;
    this.phase = this.cloud?.config ? "saved" : "guest";
    this.message = this.cloud?.config
      ? "已恢复云端已保存设置。"
      : "已放弃本机修改；仍无已保存订阅。";
    this.paint();
  }

  getSnapshot(): Snapshot | null {
    return this.cloud;
  }
}

export function makeDraft(fields: {
  games: string[];
  eventTypes: string[];
  nodeTypes: string[];
  ruleIds: string[];
  alarms: boolean;
  changes: Record<
    "new_event" | "important_change" | "cancelled_or_retracted" | "late_discovery",
    boolean
  >;
}): Draft {
  return {
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    scope: {
      games: fields.games as Draft["scope"]["games"],
      regions: [...SUPPORTED_SCOPE_REGIONS],
    },
    calendar: {
      event_types: fields.eventTypes as Draft["calendar"]["event_types"],
      node_types: fields.nodeTypes as Draft["calendar"]["node_types"],
      alarms_enabled: fields.alarms,
    },
    notifications: {
      rule_ids: fields.ruleIds as Draft["notifications"]["rule_ids"],
      ...fields.changes,
    },
  };
}
