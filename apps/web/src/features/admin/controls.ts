/**
 * 管理端「运行开关」：读取 GET /api/v2/admin/controls，按 CAS 版本逐项 PUT。
 * 每次写入都要求选择理由（服务端写审计）；写入后重新读取核实实际值，409 时重新读取，不盲目覆盖。
 * P3-20：二次确认在页面内完成，不用 window.confirm——内嵌浏览器会直接吞掉确认框、视为取消，
 * 点击后毫无反应。来源行另外说明它能抓什么、最近抓取状态，维护中可在此解除。
 */
import { browseTimestamp, REDEEM_STATUS_CHECK_HOURS } from "@hoyo/contracts";
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
/** ADR-0034：正在跟踪的一场直播（兑换码、截止时间与采集阶段）。 */
type TrackedLive = {
  act_id: string;
  first_seen_at: number;
  closed_at: number | null;
  title: string | null;
  checked_at: number | null;
  phase: "reading" | "deadline" | "checking";
  next_check_at: number | null;
  codes: { code: string; revealed_at: number; gone_at: number | null }[];
  official_expiry: { expires_at: number; text: string } | null;
  manual_expiry: { expires_at: number; text: string; updated_at: number } | null;
};
type LiveTracking = {
  hints: { act_id: string; added_at: number }[];
  tracked: TrackedLive[];
};
type SourceInfo = {
  game: string;
  adapter: string;
  state: SourceState | null;
  /** ADR-0030：直播兑换码来源的登记与正在跟踪的直播活动。 */
  lives?: LiveTracking;
};
type ControlRow = {
  control: string;
  source?: string;
  value: boolean | "unknown";
  updated_at: number;
  info?: SourceInfo;
};
/** 等待页面内确认的一次修改；同一时间只有一项。 */
type Pending =
  | { kind: "toggle"; key: string; enabled: boolean }
  | { kind: "resume"; key: string }
  | { kind: "expiry"; key: string; source: string; live: TrackedLive; value: string };

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
  push_enabled: {
    name: "浏览器通知（Web Push）",
    desc: "允许用户在浏览器开启通知并外发；还需部署 VAPID 密钥并打开外发总闸。推送服务拒绝本站身份（401/403）时系统会自动关闭此开关，核对 VAPID 配置后再打开。",
  },
  model_enabled: {
    name: "AI 草稿（模型抽取）",
    desc: "用 Workers AI 为待审公告预填草稿，人工批准后才发布；需同时打开外发总闸、关闭只读模式。",
  },
  review_skip_enabled: {
    name: "跳过审核",
    desc: "新生成的 AI 草稿通过全部检查后由系统直接批准发布，不经人工核对；疑似重复、遇人工锁定、时间未定或有歧义的仍留在审核队列。需同时开启 AI 草稿。",
    danger: true,
  },
  account_reclaim_enabled: { name: "账号回收", desc: "允许回收长期不活跃的账号。" },
  seat_reclaim_enabled: { name: "邮件席位回收", desc: "允许回收不活跃账号的邮件席位。" },
  source_enabled: { name: "来源抓取", desc: "允许抓取该官方来源。" },
};
const ADAPTERS: Record<string, string> = {
  "announcement-webview": "游戏内公告",
  miyolive: "直播兑换码",
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
/** 展开了"手动登记"的直播来源：重绘后保持展开（ADR-0033）。 */
const manualOpen = new Set<string>();

function key(row: ControlRow): string {
  return row.source ? `source:${row.source}` : row.control;
}

function displayName(row: ControlRow): string {
  const meta = LABELS[row.control] ?? { name: row.control };
  if (!row.source) return meta.name;
  if (!row.info) return `${meta.name} · ${row.source}`;
  return `${meta.name} · ${gameName(row.info.game)}${ADAPTERS[row.info.adapter] ?? row.source}`;
}

/** ADR-0034：没有截止时间时的核对时刻（北京时间），由 contracts 参数推出，不另写一份。 */
const CHECK_HOURS = `${REDEEM_STATUS_CHECK_HOURS.join("、")} 点`;

/** 来源能抓什么：游戏内公告（ADR-0016 起不再有仅列表的来源）与直播兑换码（ADR-0030）。 */
const SOURCE_DESCRIPTION: Record<string, string> = {
  "announcement-webview": "抓取公告列表（含图文资讯）与完整正文，版本公告、活动、卡池都从这里来。",
  miyolive: `开启后全自动：每次轮询从米游社首页发现前瞻直播，读取官方直播页的兑换码——兑换码随即出现在首页「有效兑换码」条，取到兑换码时兑换码事件随本开关自动发布到日历，不经「自动发布」。官方直播页没写有效期时，可在下方照官方在别处发布的说明登记截止时间；没有截止时间的，直播收尾后每天 ${CHECK_HOURS}（北京时间）核对一次，官方不再列出即从首页收回。正常情况下不需要手动登记直播。`,
};

/** 北京时间"YYYY-MM-DDTHH:MM:SS"，作 datetime-local 输入框的值。 */
function beijingInputValue(ms: number): string {
  const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${browseTimestamp(ms).replace(" ", "T")}:${seconds}`;
}

/** 这场直播现在怎么采集（ADR-0034）。 */
function livePhase(live: TrackedLive): string {
  if (live.closed_at !== null) return `官方已结束（${stamp(live.closed_at)}），不再读取`;
  if (live.phase === "deadline") return "直播已收尾、有截止时间，不再读取官方";
  if (live.phase === "checking")
    return `直播已收尾、没有截止时间：北京时间每天 ${CHECK_HOURS}核对官方是否还列出兑换码，下一次 ${stamp(live.next_check_at)}`;
  return "直播进行中或还有待发放的兑换码，每次轮询读取";
}

/** 截止时间的来源与写法：管理员登记的优先，其次官方兑换码说明。 */
function liveExpiry(live: TrackedLive): string {
  if (live.manual_expiry)
    return `截止时间：${live.manual_expiry.text}（管理员登记，${stamp(live.manual_expiry.updated_at)}）`;
  if (live.official_expiry) return `截止时间：${live.official_expiry.text}（官方兑换码说明）`;
  return "截止时间：官方未写。可照官方在别处发布的说明登记。";
}

/**
 * ADR-0034：一场直播的兑换码、截止时间与登记表单。登记后首页条立即按它显示；
 * 日历由下一次采集写进正文后发布"兑换码过期"，已有截止时间时改动即一次改期。
 */
function trackedLive(row: ControlRow, live: TrackedLive): HTMLElement {
  const source = row.source ?? "";
  const liveKey = `expiry:${source}:${live.act_id}`;
  const codes = live.codes.length
    ? `兑换码：${live.codes
        .map(
          (code) =>
            `${code.code}（${stamp(code.revealed_at)} 发放${code.gone_at === null ? "" : `；${stamp(code.gone_at)} 起官方不再列出`}）`,
        )
        .join("、")}`
    : "兑换码：还没有发放";
  const current = live.manual_expiry?.expires_at ?? live.official_expiry?.expires_at ?? null;
  const input = el("input", {
    type: "datetime-local",
    step: "1",
    class: "input",
    name: `expiry-${source}-${live.act_id}`,
    "aria-label": `「${live.title ?? live.act_id}」的兑换码截止时间（北京时间）`,
  });
  if (current !== null) input.value = beijingInputValue(current);
  const submit = el(
    "button",
    { type: "submit", class: "button button--secondary button--sm" },
    live.manual_expiry ? "修改截止时间" : "登记截止时间",
  );
  input.disabled = busy || pending?.key === liveKey;
  submit.disabled = busy || pending?.key === liveKey;
  const form = el(
    "form",
    { class: "control-live-form" },
    el("span", { class: "control-desc" }, "北京时间"),
    input,
    submit,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!status) return;
    if (!input.value) {
      status.textContent = "请填写截止时间（北京时间，照官方说明）。";
      input.focus();
      return;
    }
    ask({ kind: "expiry", key: liveKey, source, live, value: input.value });
  });
  let confirm: HTMLElement | null = null;
  if (pending?.kind === "expiry" && pending.key === liveKey) {
    const value = pending.value.replace("T", " ").replace(/-/g, "/");
    confirm = confirmBox(
      `确认把「${live.title ?? live.act_id}」的兑换码截止时间${live.manual_expiry || live.official_expiry ? "改为" : "设为"} ${value}（北京时间）？首页「有效兑换码」条立即按它显示、到点收回；日历随后发布「兑换码过期」${live.manual_expiry || live.official_expiry ? "，这是一次改期，订阅了兑换码的用户会收到变更通知" : ""}。请确认这是官方写明的时间。`,
      "确认登记",
      () => {
        if (pending?.kind === "expiry") void saveExpiry(pending);
      },
    );
  }
  return el(
    "li",
    { class: "control-live-item" },
    el(
      "p",
      { class: "control-live-title" },
      live.title ?? "（还没读到标题）",
      " ",
      el("code", {}, live.act_id),
    ),
    el("p", { class: "control-desc" }, `发现于 ${stamp(live.first_seen_at)} · ${livePhase(live)}`),
    el("p", { class: "control-desc" }, codes),
    el("p", { class: "control-desc" }, liveExpiry(live)),
    form,
    confirm,
  );
}

/** ADR-0030：直播来源正在跟踪的活动与登记入口。登记只把活动 ID 交给下一次采集，采集照常核验。 */
function liveTracking(row: ControlRow): HTMLElement | null {
  const lives = row.info?.lives;
  if (!lives || !row.source) return null;
  const tracked = lives.tracked.length
    ? el("ul", { class: "control-lives" }, ...lives.tracked.map((live) => trackedLive(row, live)))
    : el(
        "p",
        { class: "control-desc" },
        row.value === true
          ? "正在跟踪的直播：暂无（每次轮询自动从米游社首页发现）。"
          : "正在跟踪的直播：暂无（开启后自动从米游社首页发现）。",
      );
  const input = el("input", {
    type: "text",
    class: "input",
    name: `live-${row.source}`,
    inputmode: "url",
    autocomplete: "off",
    placeholder: "官方直播页链接或活动 ID",
    "aria-label": `为「${displayName(row)}」登记直播活动`,
  });
  const submit = el(
    "button",
    { type: "submit", class: "button button--secondary button--sm" },
    "登记",
  );
  submit.disabled = busy;
  input.disabled = busy;
  const form = el(
    "form",
    { class: "control-live-form" },
    input,
    submit,
    lives.hints.length
      ? el(
          "p",
          { class: "control-key" },
          `已登记：${lives.hints.map((hint) => `${hint.act_id}（${stamp(hint.added_at)}）`).join("、")}`,
        )
      : null,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void registerLive(row, input.value);
  });
  // ADR-0033：手动登记只是备用方案（首页没有放出直播入口时），默认收起。
  const source = row.source;
  const manual = el(
    "details",
    { class: "control-live-manual" },
    el(
      "summary",
      {},
      `备用：手动登记直播${lives.hints.length ? `（已登记 ${lives.hints.length} 个）` : ""}`,
    ),
    el(
      "p",
      { class: "control-desc" },
      "只在官方已经公布直播、但开启后这里一直没有出现在「正在跟踪的直播」时使用（例如米游社首页没有放出直播入口）。登记的活动 ID 交给下一次轮询，照常核验。",
    ),
    form,
  );
  manual.open = manualOpen.has(source);
  manual.addEventListener("toggle", () => {
    if (manual.open) manualOpen.add(source);
    else manualOpen.delete(source);
  });
  return el("div", { class: "control-live" }, tracked, manual);
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
    el(
      "p",
      { class: "control-desc" },
      row.info ? (SOURCE_DESCRIPTION[row.info.adapter] ?? "") : meta.desc,
    ),
    row.info ? sourceState(row) : null,
    liveTracking(row),
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
      rows.filter((r) =>
        [
          "automatic_publication_enabled",
          "model_enabled",
          "review_skip_enabled",
          "source_enabled",
        ].includes(r.control),
      ),
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
            "model_enabled",
            "review_skip_enabled",
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

/** ADR-0030：登记直播活动；需先选理由。认不出的链接由服务端拒绝（400），不自动重试。 */
async function registerLive(row: ControlRow, value: string): Promise<void> {
  if (busy || !status || !row.source) return;
  if (!reasonSelect?.value) {
    status.textContent = "请先在上方选择修改理由。";
    reasonSelect?.focus();
    return;
  }
  if (!value.trim()) {
    status.textContent = "请填写官方直播页链接或活动 ID。";
    return;
  }
  const name = displayName(row);
  busy = true;
  render();
  status.textContent = "正在登记直播活动…";
  try {
    const reply = await request<{ act_id?: string }>("admin/redeem-lives", {
      source: row.source,
      live: value.trim(),
      reason: reasonSelect.value,
    });
    busy = false;
    await load();
    status.textContent = `已为「${name}」登记直播活动 ${reply.act_id ?? ""}，下一次采集会读取它。`;
  } catch (error) {
    busy = false;
    await load();
    status.textContent =
      error instanceof AdminRequestError && error.status === 400
        ? "认不出这个链接：需要米游社官方直播页（webstatic.mihoyo.com/bbs/event/live/index.html）的链接或其中的 act_id。"
        : error instanceof AdminRequestError && error.status === 409
          ? "登记在别处同时变化，已重新读取，请核对后再试。"
          : error instanceof AdminRequestError && error.status === 401
            ? "管理端登录已失效，请重新登录。"
            : "登记未确认，已重新读取当前状态；没有自动重试。";
  }
}

/**
 * ADR-0034：登记一场直播的兑换码截止时间（北京时间）。带页面上看到的登记版本（还没有登记为 0），
 * 已在别处修改时 409 重新读取；认不出的时间、不晚于第一个兑换码发放、不在跟踪的直播由服务端拒绝（400）。
 */
async function saveExpiry(next: Extract<Pending, { kind: "expiry" }>): Promise<void> {
  if (busy || !status) return;
  const title = next.live.title ?? next.live.act_id;
  const reason = reasonSelect?.value ?? "";
  busy = true;
  pending = null;
  render();
  status.textContent = "正在登记截止时间…";
  try {
    const reply = await request<{ text?: string }>("admin/redeem-expiry", {
      source: next.source,
      act_id: next.live.act_id,
      expires_at: next.value,
      reason,
      expected_updated_at: next.live.manual_expiry?.updated_at ?? 0,
    });
    busy = false;
    await load();
    status.textContent = `已登记「${title}」的兑换码截止时间 ${reply.text ?? ""}（北京时间）：首页条已按它显示，日历在下一次采集后更新。`;
  } catch (error) {
    busy = false;
    await load();
    status.textContent =
      error instanceof AdminRequestError && error.status === 400
        ? "没有登记：时间认不出、不晚于这场直播第一个兑换码的发放时刻，或这场直播已不在跟踪。"
        : error instanceof AdminRequestError && error.status === 409
          ? "截止时间已在别处修改，已重新读取，请核对后再试。"
          : error instanceof AdminRequestError && error.status === 401
            ? "管理端登录已失效，请重新登录。"
            : "登记未确认，已重新读取当前状态；没有自动重试。";
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
