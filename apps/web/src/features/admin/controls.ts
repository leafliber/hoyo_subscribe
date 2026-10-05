/**
 * 管理端「运行开关」：读取 GET /api/v2/admin/controls，按 CAS 版本逐项 PUT。
 * 每次写入都要求选择理由（服务端写审计）；写入后重新读取核实实际值，409 时重新读取，不盲目覆盖。
 * P3-20：二次确认在页面内完成，不用 window.confirm——内嵌浏览器会直接吞掉确认框、视为取消，
 * 点击后毫无反应。来源行另外说明它能抓什么、最近抓取状态，维护中可在此解除。
 */
import { el } from "../../lib/dom";
import { stamp } from "../../lib/format";
import { AdminRequestError, request } from "./api";
import { gameName } from "./draft";

type SourceState = {
  verification_state: string;
  last_success_at: number | null;
  updated_at: number | null;
  job_status: string | null;
  job_last_error: string | null;
};
type SourceInfo = {
  game: string;
  adapter: string;
  list_only: boolean;
  state: SourceState | null;
};
type ControlRow = {
  control: string;
  source?: string;
  value: boolean | "unknown";
  updated_at: number;
  info?: SourceInfo;
};
/** 等待页面内确认的一次修改；同一时间只有一项。 */
type Pending = { kind: "toggle"; key: string; enabled: boolean } | { kind: "resume"; key: string };

const LABELS: Record<string, { name: string; desc: string; danger?: boolean }> = {
  read_only: {
    name: "只读模式",
    desc: "开启时拒绝大部分写入（发布、审核写入等）；终止类操作仍可用。",
    danger: true,
  },
  outbound_enabled: { name: "外发总闸", desc: "关闭时停止来源抓取、邮件与推送等全部对外请求。" },
  registration_open: { name: "开放注册", desc: "允许新邮箱创建账号。" },
  mail_sending_available: {
    name: "邮件发送可用",
    desc: "验证码与业务邮件的发送总开关（还需配置齐全）。",
  },
  business_mail_enabled: { name: "业务邮件", desc: "取消/更正/提醒等业务邮件。" },
  email_seats_open: { name: "开放邮件新席位", desc: "允许用户新开启邮件通知。" },
  email_routine_enabled: { name: "常规提醒邮件", desc: "常规提前提醒与新活动邮件。" },
  calendar_enabled: { name: "开放日历订阅", desc: "允许用户启用个人日历订阅。" },
  automatic_publication_enabled: { name: "自动发布", desc: "规则抽取的候选无需人工审核即可发布。" },
  push_enabled: { name: "浏览器推送", desc: "首版未实现。" },
  model_enabled: {
    name: "AI 草稿（模型抽取）",
    desc: "用 Workers AI 为待审公告预填草稿，人工批准后才发布；需同时打开外发总闸、关闭只读模式。",
  },
  account_reclaim_enabled: { name: "账号回收", desc: "允许回收长期不活跃的账号。" },
  seat_reclaim_enabled: { name: "邮件席位回收", desc: "允许回收不活跃账号的邮件席位。" },
  source_enabled: { name: "来源抓取", desc: "允许抓取该官方来源。" },
};
const ADAPTERS: Record<string, string> = {
  "announcement-webview": "游戏内公告",
  "miyoushe-painter-news": "米游社官方资讯",
};
const REASONS: [string, string][] = [
  ["initial_deployment", "首次部署"],
  ["verified_configuration", "已核实配置"],
  ["evidence_reviewed", "证据已复核"],
  ["maintenance", "维护"],
  ["incident_containment", "事故处置"],
];

function csrf(): string {
  return (
    document.cookie
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("__Host-hoyo_csrf="))
      ?.slice("__Host-hoyo_csrf=".length) ?? ""
  );
}

async function put(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/v2/admin/controls", {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", "x-csrf-token": csrf() },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new AdminRequestError(response.status);
  return value;
}

const root = document.getElementById("controls-panel");
const list = document.getElementById("controls-list");
const status = document.getElementById("controls-status");
const reasonSelect = document.getElementById("controls-reason") as HTMLSelectElement | null;
const refreshButton = document.getElementById("controls-refresh");
const workspace = document.getElementById("workspace");
let rows: ControlRow[] = [];
let busy = false;
let pending: Pending | null = null;

function key(row: ControlRow): string {
  return row.source ? `source:${row.source}` : row.control;
}

function displayName(row: ControlRow): string {
  const meta = LABELS[row.control] ?? { name: row.control };
  if (!row.source) return meta.name;
  if (!row.info) return `${meta.name} · ${row.source}`;
  return `${meta.name} · ${gameName(row.info.game)}${ADAPTERS[row.info.adapter] ?? row.source}`;
}

/** 来源能抓什么：能力来自注册表（list_only），这里只负责写成人话。 */
function sourceDescription(info: SourceInfo): string {
  return info.list_only
    ? "仅列表：只有标题和封面。正文接口受源站访问控制，按规则不接入，因此开启后产生的条目正文不完整、不能批准，首次开启还会逐页补抓历史帖子。版本公告与活动正文已由游戏内公告覆盖，通常不需要开启。"
    : "抓取公告列表（含图文资讯）与完整正文，版本公告、活动、卡池都从这里来。";
}

/** 最近一次抓取得怎样；维护中给出解除入口说明。 */
function sourceState(row: ControlRow): HTMLElement {
  const state = row.info?.state ?? null;
  if (state === null)
    return el(
      "p",
      { class: "control-desc" },
      "抓取状态：尚未建立（开关开启后的第一次轮询时建立）。",
    );
  if (state.verification_state === "maintenance-required")
    return el(
      "p",
      { class: "control-desc" },
      el("span", { class: "badge badge--warning" }, "需维护"),
      " 源站拒绝访问，抓取已暂停；确认对方恢复正常后再解除维护，仍受限时会自动重新进入维护。",
    );
  const success =
    state.last_success_at === null
      ? "尚未成功抓取"
      : `最近成功抓取：${stamp(state.last_success_at)}`;
  const job =
    state.job_last_error === "source_switch_unavailable_or_disabled"
      ? "；开关关闭或外发未开，抓取任务暂停中"
      : state.job_status === "failed"
        ? `；抓取任务已停止（${state.job_last_error ?? "原因未知"}）`
        : "";
  return el("p", { class: "control-desc" }, `抓取状态：${success}${job}。`);
}

/** 行内二次确认：说明后果，确认才提交；取消也给出提示。 */
function confirmBox(text: string, confirmLabel: string, onConfirm: () => void): HTMLElement {
  const yes = el("button", { type: "button", class: "button button--sm" }, confirmLabel);
  const no = el("button", { type: "button", class: "button button--secondary button--sm" }, "取消");
  yes.disabled = busy;
  no.disabled = busy;
  yes.addEventListener("click", onConfirm);
  no.addEventListener("click", () => {
    pending = null;
    if (status) status.textContent = "已取消，没有修改。";
    render();
  });
  return el(
    "div",
    { class: "control-confirm", role: "group", "aria-label": confirmLabel },
    el("p", {}, text),
    el("div", { class: "control-confirm-actions" }, yes, no),
  );
}

/** 先确认理由已选，再进入页面内确认。 */
function ask(next: Pending): void {
  if (busy || !status) return;
  if (!reasonSelect?.value) {
    status.textContent = "请先在上方选择修改理由。";
    reasonSelect?.focus();
    return;
  }
  pending = next;
  status.textContent = "请在该项下方确认这次修改。";
  render();
}

function controlRow(row: ControlRow): HTMLElement {
  const meta = LABELS[row.control] ?? { name: row.control, desc: "" };
  const on = row.value === true;
  const unknown = row.value === "unknown";
  const name = displayName(row);
  const toggle = el(
    "button",
    {
      type: "button",
      class: on ? "button button--secondary button--sm" : "button button--sm",
      "data-control": key(row),
    },
    on ? "关闭" : "开启",
  );
  toggle.disabled = busy || unknown || pending?.key === key(row);
  toggle.addEventListener("click", () => ask({ kind: "toggle", key: key(row), enabled: !on }));
  const actions = el("div", { class: "control-actions" }, toggle);
  if (row.info?.state?.verification_state === "maintenance-required") {
    const release = el(
      "button",
      { type: "button", class: "button button--secondary button--sm" },
      "解除维护",
    );
    release.disabled = busy || pending?.key === key(row);
    release.addEventListener("click", () => ask({ kind: "resume", key: key(row) }));
    actions.append(release);
  }
  const text = el(
    "div",
    { class: "control-text" },
    el(
      "p",
      { class: "control-name" },
      name,
      el(
        "span",
        {
          class: `badge ${unknown ? "badge--warning" : on ? (meta.danger ? "badge--warning" : "badge--success") : ""}`,
        },
        unknown ? "未知" : on ? "开" : "关",
      ),
    ),
    el("p", { class: "control-desc" }, row.info ? sourceDescription(row.info) : meta.desc),
    row.info ? sourceState(row) : null,
    el(
      "p",
      { class: "control-key" },
      `${key(row)} · 更新于 ${row.updated_at ? stamp(row.updated_at) : "从未"}`,
    ),
  );
  let confirm: HTMLElement | null = null;
  if (pending?.key === key(row) && pending.kind === "toggle") {
    const enabled = pending.enabled;
    confirm = confirmBox(
      `确认${enabled ? "开启" : "关闭"}「${name}」？这会立即影响线上服务，并写入审计记录。`,
      `确认${enabled ? "开启" : "关闭"}`,
      () => void write(row, enabled),
    );
  } else if (pending?.key === key(row) && pending.kind === "resume") {
    confirm = confirmBox(
      `确认解除「${name}」的维护？会放回一次正常抓取；源站仍受限时会重新进入维护。`,
      "确认解除维护",
      () => void resume(row),
    );
  }
  return el(
    "div",
    { class: "control-row" },
    el("div", { class: "control-main" }, text, actions),
    confirm,
  );
}

function render(): void {
  if (!list) return;
  list.replaceChildren();
  const groups: [string, ControlRow[]][] = [
    ["安全与总闸", rows.filter((r) => ["read_only", "outbound_enabled"].includes(r.control))],
    [
      "用户功能",
      rows.filter((r) =>
        [
          "registration_open",
          "calendar_enabled",
          "mail_sending_available",
          "business_mail_enabled",
          "email_seats_open",
          "email_routine_enabled",
        ].includes(r.control),
      ),
    ],
    [
      "数据管线",
      rows.filter((r) => ["automatic_publication_enabled", "source_enabled"].includes(r.control)),
    ],
    [
      "其他",
      rows.filter(
        (r) =>
          ![
            "read_only",
            "outbound_enabled",
            "registration_open",
            "calendar_enabled",
            "mail_sending_available",
            "business_mail_enabled",
            "email_seats_open",
            "email_routine_enabled",
            "automatic_publication_enabled",
            "source_enabled",
          ].includes(r.control),
      ),
    ],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    list.append(el("div", { class: "control-group" }, el("h3", {}, title), items.map(controlRow)));
  }
}

async function load(): Promise<void> {
  if (!status) return;
  try {
    const reply = await request<{ controls?: ControlRow[] }>("admin/controls");
    rows = Array.isArray(reply.controls) ? reply.controls : [];
    status.textContent = `已读取 ${rows.length} 个开关。每次修改都会写入审计记录。`;
  } catch (error) {
    rows = [];
    status.textContent =
      error instanceof AdminRequestError && error.status === 401
        ? "需要登录管理端。"
        : "无法读取运行开关，请稍后重试。";
  }
  render();
}

async function write(row: ControlRow, enabled: boolean): Promise<void> {
  if (busy || !status) return;
  const reason = reasonSelect?.value ?? "";
  const name = displayName(row);
  busy = true;
  pending = null;
  render();
  status.textContent = "正在提交…";
  try {
    await put({
      control: row.control,
      enabled,
      ...(row.source ? { source: row.source } : {}),
      expected_updated_at: row.updated_at,
      reason,
    });
    busy = false;
    await load();
    const latest = rows.find((item) => key(item) === key(row));
    status.textContent =
      latest?.value === enabled
        ? `已${enabled ? "开启" : "关闭"}「${name}」，已重新读取核实。`
        : "提交已返回，但重新读取的值不一致，请再次核对。";
  } catch (error) {
    busy = false;
    await load();
    status.textContent =
      error instanceof AdminRequestError && error.status === 409
        ? "该开关已在别处修改，已重新读取最新值，请核对后再操作。"
        : error instanceof AdminRequestError && error.status === 401
          ? "管理端登录已失效，请重新登录。"
          : "修改未确认，已重新读取当前值；没有自动重试。";
  }
}

/** 解除来源维护：绑定页面上看到的来源行版本，状态已变化时 409 重新读取。 */
async function resume(row: ControlRow): Promise<void> {
  const updatedAt = row.info?.state?.updated_at;
  if (busy || !status || !row.source || typeof updatedAt !== "number") return;
  const name = displayName(row);
  busy = true;
  pending = null;
  render();
  status.textContent = "正在解除维护…";
  try {
    await request("admin/sources/resume", {
      source: row.source,
      expected_updated_at: updatedAt,
      reason: reasonSelect?.value ?? "",
    });
    busy = false;
    await load();
    status.textContent = `已解除「${name}」的维护，下一次轮询会重新抓取。`;
  } catch (error) {
    busy = false;
    await load();
    status.textContent =
      error instanceof AdminRequestError && error.status === 409
        ? "来源状态已在别处变化，已重新读取，请核对后再操作。"
        : error instanceof AdminRequestError && error.status === 401
          ? "管理端登录已失效，请重新登录。"
          : "解除维护未确认，已重新读取当前状态；没有自动重试。";
  }
}

if (root && list && status && workspace) {
  if (reasonSelect)
    reasonSelect.append(
      el("option", { value: "" }, "选择修改理由…"),
      ...REASONS.map(([value, label]) => el("option", { value }, label)),
    );
  refreshButton?.addEventListener("click", () => {
    pending = null;
    void load();
  });
  // 工作区出现（已登录）时读取一次；不在后台轮询。
  let loaded = false;
  const observe = () => {
    if (!workspace.hidden && !loaded) {
      loaded = true;
      void load();
    }
    if (workspace.hidden) {
      loaded = false;
      rows = [];
      pending = null;
      render();
    }
  };
  new MutationObserver(observe).observe(workspace, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  observe();
}
