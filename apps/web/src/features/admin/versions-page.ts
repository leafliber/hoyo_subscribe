// 管理端「版本时间表」页（ADR-0011）：查看 AI 从版本公告里摘出的版本时间建议，逐项确认或清除。
// 只能采用已逐字核对的建议或"下一版本的更新开始"，不提供手填时刻；每次写入带 CAS 与理由。
import {
  BROWSE_TIMEZONE,
  browseTimestamp,
  compareVersions,
  SUPPORTED_SCOPE_GAMES,
} from "@hoyo/contracts";
import { el } from "../../lib/dom";
import { AdminRequestError, request } from "./api";
import { gameName } from "./draft";
import { startAdminSession } from "./session";
import type { VersionListing, VersionRecord, VersionSuggestion } from "./types";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("admin_markup_missing");
  return node as T;
}
const container = element("versions");
const reasonInput = element<HTMLInputElement>("reason");
const reasonPreset = element<HTMLSelectElement>("version-reason-preset");
let listing: VersionListing | null = null;

const session = startAdminSession({ load, reset, refresh, fields: ["reason"] });

function refresh(): void {
  reasonInput.disabled = session.isBusy();
  reasonPreset.disabled = session.isBusy();
}
function reset(): void {
  listing = null;
  container.replaceChildren();
}
async function load(): Promise<void> {
  listing = await request<VersionListing>("admin/versions");
  session.showLoggedIn();
  render();
}
const when = (ms: number) => `${browseTimestamp(ms)}（${BROWSE_TIMEZONE}）`;
function source(suggestion: VersionSuggestion | undefined, quote: string | undefined): string {
  if (!suggestion) return "";
  return `出自《${suggestion.title ?? suggestion.article_version_id}》${quote ? `：「${quote}」` : ""}`;
}

async function write(path: "confirm" | "clear", body: Record<string, unknown>): Promise<void> {
  const reason = reasonInput.value.trim();
  if (!reason) {
    element("reason-error").textContent = "请先填写或选择确认理由。";
    reasonInput.setAttribute("aria-invalid", "true");
    return;
  }
  element("reason-error").textContent = "";
  reasonInput.removeAttribute("aria-invalid");
  try {
    await request(`admin/versions/${path}`, { ...body, reason });
    session.notice.textContent =
      path === "confirm"
        ? "已确认。尚未采用的草稿会按新时间推导；已采用但未批准的候选须与新值一致才能批准；已发布的事件不会自动改动。"
        : "已清除该项确认。尚未采用的草稿恢复为未定时刻；已采用的推导时间在批准前会被拦下；已发布的事件不会自动改动。";
  } catch (error) {
    if (error instanceof AdminRequestError && error.status === 409) {
      session.notice.textContent = "版本时间已在别处改过，已重新读取，请核对后再操作。";
      await load();
      return;
    }
    throw error;
  }
  await load();
}

function actionButton(label: string, onClick: () => Promise<void>, secondary = false): HTMLElement {
  const button = el(
    "button",
    {
      type: "button",
      class: secondary ? "button button--secondary button--sm" : "button button--sm",
    },
    label,
  );
  button.disabled = session.isBusy();
  button.addEventListener("click", () => void session.run(onClick));
  return button;
}

function fieldRow(
  label: string,
  record: VersionRecord | undefined,
  field: "update_start" | "version_end",
  game: string,
  version: string,
  suggestions: VersionSuggestion[],
  nextVersion: VersionRecord | undefined,
): HTMLElement {
  const value = field === "update_start" ? record?.update_start_ms : record?.version_end_ms;
  const expected = record?.updated_at ?? 0;
  const confirmedSource =
    field === "update_start"
      ? suggestions.find((s) => s.id === record?.update_start_source)
      : suggestions.find((s) => s.id === record?.version_end_source);
  const status =
    value == null
      ? el("span", { class: "badge badge--warning" }, "未确认")
      : el("span", { class: "badge badge--success" }, "已确认");
  const basis =
    field === "version_end" && record?.version_end_basis === "next_update"
      ? "（取下一版本的更新开始）"
      : "";
  const current =
    value == null
      ? el("p", { class: "field-hint" }, "未确认：依赖它的节点保持未定时刻。")
      : el(
          "p",
          { class: "version-value" },
          `${when(value)}${basis}`,
          el(
            "span",
            { class: "field-hint" },
            ` ${source(confirmedSource, field === "update_start" ? confirmedSource?.update_start?.quote : confirmedSource?.version_end?.quote)}`,
          ),
        );
  const options = suggestions
    .filter((s) => (field === "update_start" ? s.update_start_ms : s.version_end_ms) != null)
    .map((s) => {
      const ms = (field === "update_start" ? s.update_start_ms : s.version_end_ms) as number;
      const quote = field === "update_start" ? s.update_start?.quote : s.version_end?.quote;
      const same =
        value === ms &&
        (field === "update_start" ? record?.update_start_source : record?.version_end_source) ===
          s.id;
      return el(
        "li",
        { class: "version-suggestion" },
        el(
          "span",
          {},
          `${when(ms)}`,
          field === "update_start" && s.update_duration ? `，${s.update_duration.quote}` : "",
          el("span", { class: "field-hint" }, ` ${source(s, quote)}`),
        ),
        same
          ? el("span", { class: "field-hint" }, "当前采用")
          : actionButton("采用", () =>
              write("confirm", {
                game,
                version,
                field,
                suggestion_id: s.id,
                expected_updated_at: expected,
              }),
            ),
      );
    });
  // 已按"下一版本的更新开始"确认、且值仍一致时不重复列出；下一版本的更新开始改过后可以直接重新采用。
  if (
    field === "version_end" &&
    nextVersion?.update_start_ms != null &&
    (record?.version_end_basis !== "next_update" ||
      record.version_end_ms !== nextVersion.update_start_ms)
  )
    options.push(
      el(
        "li",
        { class: "version-suggestion" },
        el(
          "span",
          {},
          `${when(nextVersion.update_start_ms)}`,
          el(
            "span",
            { class: "field-hint" },
            ` 取 ${nextVersion.version} 版本的更新开始（版本结束即下一版本开始更新）`,
          ),
        ),
        actionButton("采用", () =>
          write("confirm", {
            game,
            version,
            field,
            from_next_version: true,
            expected_updated_at: expected,
          }),
        ),
      ),
    );
  return el(
    "div",
    { class: "version-field" },
    el("p", { class: "version-field-name" }, label, " ", status),
    current,
    options.length > 0
      ? el(
          "ul",
          { class: "version-suggestions", "aria-label": `${version} ${label}的候选值` },
          options,
        )
      : el("p", { class: "field-hint" }, "暂无可采用的摘录：等 AI 草稿处理到该版本的公告。"),
    value == null
      ? null
      : actionButton(
          "清除确认",
          () => write("clear", { game, version, field, expected_updated_at: expected }),
          true,
        ),
  );
}

function render(): void {
  container.replaceChildren();
  if (!listing) return;
  for (const game of SUPPORTED_SCOPE_GAMES) {
    const records = listing.versions.filter((v) => v.game === game);
    const suggestions = listing.suggestions.filter((s) => s.game === game);
    const versions = [
      ...new Set([...records.map((r) => r.version), ...suggestions.map((s) => s.version)]),
    ].sort((a, b) => compareVersions(b, a));
    const section = el(
      "section",
      { class: "card admin-card version-game", "aria-label": gameName(game) },
      el("div", { class: "card-header" }, el("h2", {}, gameName(game))),
    );
    const body = el("div", { class: "card-body" });
    if (versions.length === 0)
      body.append(el("p", { class: "field-hint" }, "还没有该游戏的版本公告摘录。"));
    for (const version of versions) {
      const record = records.find((r) => r.version === version);
      const own = suggestions.filter((s) => s.version === version);
      const next = records
        .filter((r) => compareVersions(r.version, version) > 0 && r.update_start_ms != null)
        .sort((a, b) => compareVersions(a.version, b.version))[0];
      const refs = listing.pending_references[`${game}:${version}`] ?? 0;
      body.append(
        el(
          "article",
          { class: "version-card", "aria-label": `${gameName(game)} ${version} 版本` },
          el(
            "h3",
            {},
            `${version} 版本`,
            refs > 0
              ? el("span", { class: "badge badge--accent" }, `影响 ${refs} 条待审草稿`)
              : null,
          ),
          fieldRow("更新开始", record, "update_start", game, version, own, undefined),
          fieldRow("版本结束", record, "version_end", game, version, own, next),
        ),
      );
    }
    section.append(body);
    container.append(section);
  }
}

reasonPreset.addEventListener("change", () => {
  if (reasonPreset.value) reasonInput.value = reasonPreset.value;
});
element("versions-reload").addEventListener(
  "click",
  () =>
    void session.run(async () => {
      await load();
      session.notice.textContent = "已重新读取版本时间表。";
    }),
);
