// 管理端「版本时间表」页（ADR-0011）：查看 AI 从版本公告里摘出的版本时间建议，逐项确认或清除。
// 只能采用已逐字核对的建议或"紧接着的下一版本的更新开始"，不提供手填时刻；每次写入带 CAS 与理由。
import {
  BROWSE_TIMEZONE,
  browseTimestamp,
  compareVersions,
  nextKnownVersion,
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
function officialLink(raw: string | null): HTMLElement | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol)
      ? el(
          "a",
          {
            href: url.href,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "version-source-link",
          },
          "打开官方原文",
        )
      : null;
  } catch {
    return null;
  }
}
/** 出处只作文本；附官方原文链接，便于核对摘录到底是不是这一项时间。 */
function source(suggestion: VersionSuggestion | undefined, quote: string | undefined): HTMLElement {
  if (!suggestion) return el("span", { class: "field-hint" });
  return el(
    "span",
    { class: "field-hint" },
    ` 出自《${suggestion.title ?? suggestion.article_version_id}》${quote ? `：「${quote}」` : ""} `,
    officialLink(suggestion.official_url),
  );
}

// 服务端按业务规则拒绝时给出能照着做的说明，而不是字段代码。
const REFUSALS: Record<string, string> = {
  next_version_unknown: "还没有紧接着的下一版本的公告摘录，暂时不能取下一版本的更新开始。",
  next_version_unconfirmed: "下一版本的更新开始尚未确认，请先确认它。",
  referenced_by_previous_end: "这个更新开始已被上一版本的结束引用，请先清除上一版本的版本结束。",
  end_not_after_start: "版本结束必须晚于更新开始，请核对。",
  not_confirmed: "该项尚未确认，无需清除。",
};

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
      await load();
      session.notice.textContent = "版本时间已在别处改过，已重新读取，请核对后再操作。";
      return;
    }
    const refusal =
      error instanceof AdminRequestError &&
      error.status === 400 &&
      error.detail?.code === "validation"
        ? error.detail.fields.map((field) => REFUSALS[field.reason]).find(Boolean)
        : undefined;
    if (refusal !== undefined) {
      await load();
      session.notice.textContent = refusal;
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

interface FieldContext {
  readonly game: string;
  readonly version: string;
  readonly record: VersionRecord | undefined;
  readonly suggestions: VersionSuggestion[];
  /** 紧接着的下一版本（版本结束可取它的更新开始）；没有已知的下一版本时为 null。 */
  readonly next: { readonly version: string; readonly record: VersionRecord | undefined } | null;
  /** 版本结束取自本版本更新开始的那个版本；有它时本版本的更新开始不能改或清除。 */
  readonly referencedBy: VersionRecord | undefined;
}

function fieldRow(
  label: string,
  field: "update_start" | "version_end",
  context: FieldContext,
): HTMLElement {
  const { game, version, record, suggestions, next, referencedBy } = context;
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
          source(
            confirmedSource,
            field === "update_start"
              ? confirmedSource?.update_start?.quote
              : confirmedSource?.version_end?.quote,
          ),
        );
  if (field === "update_start" && value != null && referencedBy !== undefined)
    return el(
      "div",
      { class: "version-field" },
      el("p", { class: "version-field-name" }, label, " ", status),
      current,
      el(
        "p",
        { class: "field-hint" },
        `已被 ${referencedBy.version} 版本的结束引用：要修改或清除，先清除 ${referencedBy.version} 的版本结束。`,
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
          source(s, quote),
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
  const nextStart = next?.record?.update_start_ms ?? null;
  // 已按"下一版本的更新开始"确认、且值仍一致时不重复列出。
  if (
    field === "version_end" &&
    next !== null &&
    nextStart !== null &&
    (record?.version_end_basis !== "next_update" || record.version_end_ms !== nextStart)
  )
    options.push(
      el(
        "li",
        { class: "version-suggestion" },
        el(
          "span",
          {},
          `${when(nextStart)}`,
          el(
            "span",
            { class: "field-hint" },
            ` 取 ${next.version} 版本的更新开始（版本结束即下一版本开始更新）`,
          ),
        ),
        actionButton("采用", () =>
          write("confirm", {
            game,
            version,
            field,
            from_next_version: true,
            // 绑定页面上看到的值：下一版本的更新开始在这之间被改过时服务端返回 409。
            expected_next_update_start_ms: nextStart,
            expected_updated_at: expected,
          }),
        ),
      ),
    );
  const nextHint =
    field === "version_end" && next !== null && nextStart === null
      ? el(
          "p",
          { class: "field-hint" },
          `下一版本 ${next.version} 的更新开始尚未确认；确认后可以取它作为本版本的结束。`,
        )
      : null;
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
    nextHint,
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
      const nextVersion = nextKnownVersion(version, versions);
      const context: FieldContext = {
        game,
        version,
        record,
        suggestions: suggestions.filter((s) => s.version === version),
        next:
          nextVersion === null
            ? null
            : { version: nextVersion, record: records.find((r) => r.version === nextVersion) },
        referencedBy:
          record?.update_start_source == null
            ? undefined
            : records.find(
                (r) =>
                  r.version !== version &&
                  r.version_end_basis === "next_update" &&
                  r.version_end_source === record.update_start_source,
              ),
      };
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
          fieldRow("更新开始", "update_start", context),
          fieldRow("版本结束", "version_end", context),
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
