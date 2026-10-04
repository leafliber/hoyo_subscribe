/**
 * 管理端「运行开关」：读取 GET /api/v2/admin/controls，按 CAS 版本逐项 PUT。
 * 每次写入都要求选择理由（服务端写审计）；写入后重新读取核实实际值，409 时重新读取，不盲目覆盖。
 */
import { el } from "../../lib/dom";
import { stamp } from "../../lib/format";
import { AdminRequestError, request } from "./api";

type ControlRow = {
  control: string;
  source?: string;
  value: boolean | "unknown";
  updated_at: number;
};

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
  model_enabled: { name: "模型抽取", desc: "首版不使用。" },
  account_reclaim_enabled: { name: "账号回收", desc: "允许回收长期不活跃的账号。" },
  seat_reclaim_enabled: { name: "邮件席位回收", desc: "允许回收不活跃账号的邮件席位。" },
  source_enabled: { name: "来源抓取", desc: "允许抓取该官方来源。" },
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

function key(row: ControlRow): string {
  return row.source ? `source:${row.source}` : row.control;
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
    const group = el("div", { class: "control-group" }, el("h3", {}, title));
    for (const row of items) {
      const meta = LABELS[row.control] ?? { name: row.control, desc: "" };
      const on = row.value === true;
      const unknown = row.value === "unknown";
      const toggle = el(
        "button",
        {
          type: "button",
          class: on ? "button button--secondary button--sm" : "button button--sm",
          "data-control": key(row),
        },
        on ? "关闭" : "开启",
      );
      toggle.disabled = busy || unknown;
      toggle.addEventListener("click", () => void write(row, !on));
      group.append(
        el(
          "div",
          { class: "control-row" },
          el(
            "div",
            { class: "control-text" },
            el(
              "p",
              { class: "control-name" },
              row.source ? `${meta.name} · ${row.source}` : meta.name,
              el(
                "span",
                {
                  class: `badge ${unknown ? "badge--warning" : on ? (meta.danger ? "badge--warning" : "badge--success") : ""}`,
                },
                unknown ? "未知" : on ? "开" : "关",
              ),
            ),
            el("p", { class: "control-desc" }, meta.desc),
            el(
              "p",
              { class: "control-key" },
              `${key(row)} · 更新于 ${row.updated_at ? stamp(row.updated_at) : "从未"}`,
            ),
          ),
          toggle,
        ),
      );
    }
    list.append(group);
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
  if (!reason) {
    status.textContent = "请先在上方选择修改理由。";
    reasonSelect?.focus();
    return;
  }
  const meta = LABELS[row.control] ?? { name: row.control };
  if (
    !window.confirm(
      `${enabled ? "开启" : "关闭"}「${row.source ? `${meta.name} · ${row.source}` : meta.name}」？这会立即影响线上服务，并写入审计记录。`,
    )
  )
    return;
  busy = true;
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
        ? `已${enabled ? "开启" : "关闭"}「${meta.name}」，已重新读取核实。`
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

if (root && list && status && workspace) {
  if (reasonSelect)
    reasonSelect.append(
      el("option", { value: "" }, "选择修改理由…"),
      ...REASONS.map(([value, label]) => el("option", { value }, label)),
    );
  refreshButton?.addEventListener("click", () => void load());
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
      render();
    }
  };
  new MutationObserver(observe).observe(workspace, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  observe();
}
