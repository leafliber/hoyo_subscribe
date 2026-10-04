// P3-17（ADR-0009）· 审核页的可读正文与 AI 草稿视图。全部按文本写入（el 构建器，不用 innerHTML）；
// 草稿内容、校验与发布规则都以服务端为准，这里只负责展示与收集"排除哪些条目、是否确认歧义"。
import {
  BROWSE_TIMEZONE,
  browseTimestamp,
  EVENT_NAMES,
  GAME_NAMES,
  type GameId,
  NODE_NAMES,
  type TimeValue,
} from "@hoyo/contracts";
import { el } from "../../lib/dom";
import type { CandidateDetail, DraftStatus, DraftView } from "./types";

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  ready: "AI 草稿就绪",
  invalid: "草稿需人工修正",
  failed: "草稿生成失败",
  skipped: "未生成草稿",
};

export function draftBadge(status: DraftStatus | null | undefined): HTMLElement {
  const kind =
    status === "ready"
      ? " badge--success"
      : status === "invalid" || status === "failed"
        ? " badge--warning"
        : "";
  return el("span", { class: `badge${kind}` }, status ? DRAFT_STATUS_LABELS[status] : "暂无草稿");
}

export function gameName(game: string | null | undefined): string {
  return game && game in GAME_NAMES ? GAME_NAMES[game as GameId] : (game ?? "未知游戏");
}

/** 精确时刻固定按北京时间显示；纯日期不补时刻；其余保留官方原文。版本时间表推导的值标明推导与原文。 */
export function formatDraftTime(time: TimeValue): string {
  const derived = time.time_basis === "deterministic_derived";
  if (time.precision === "datetime")
    return `${browseTimestamp(time.utc_ms)}（${BROWSE_TIMEZONE}${time.time_basis === "official_estimate" ? "，预计" : ""}${derived ? `，由「${time.raw_expression}」按版本时间表推导` : ""}）`;
  if (time.precision === "date")
    return derived
      ? `${time.date}（仅日期，由「${time.raw_expression}」按版本时间表推导）`
      : `${time.date}（仅日期）`;
  return `${time.raw_expression}（原文，未定时刻）`;
}

/** 左栏：服务端给的可读文本优先；没有时退回原文块文本。块号与证据引用一致。 */
export function renderReadableBlocks(container: HTMLElement, detail: CandidateDetail): void {
  container.replaceChildren();
  const texts =
    detail.readable_blocks ??
    detail.article.blocks.map((block) => (block.kind === "html" ? block.html : block.text));
  texts.forEach((text, index) => {
    if (text.length === 0) return;
    container.append(
      el(
        "div",
        { class: "readable-block", id: `block-${index}`, "data-ref": `blocks/${index}` },
        el("span", { class: "readable-ref" }, `blocks/${index}`),
        el("p", { class: "readable-text" }, text),
      ),
    );
  });
}

function evidenceButton(ref: string, quote: string): HTMLElement {
  const button = el(
    "button",
    { type: "button", class: "evidence-link", "data-ref": ref, title: "在左侧原文中定位" },
    `「${quote}」 · ${ref}`,
  );
  button.addEventListener("click", () => {
    const target = document.getElementById(`block-${ref.slice("blocks/".length)}`);
    if (!target) return;
    document.querySelectorAll(".readable-block--focus").forEach((node) => {
      node.classList.remove("readable-block--focus");
    });
    target.classList.add("readable-block--focus");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  return button;
}

export interface DraftSelection {
  readonly usable: boolean;
  readonly noEvent: boolean;
  readonly uncertain: boolean;
  exclude(): string[];
  confirmed(): boolean;
  keptCount(): number;
}

export const NO_DRAFT_SELECTION: DraftSelection = {
  usable: false,
  noEvent: false,
  uncertain: false,
  exclude: () => [],
  confirmed: () => false,
  keptCount: () => 0,
};

/** 已裁定的候选不再需要草稿；只说明状态，不渲染可操作的勾选项。 */
export function renderDecided(panel: HTMLElement, status: string): DraftSelection {
  panel.replaceChildren(
    el(
      "p",
      { class: "field-hint" },
      status === "approved"
        ? "候选已批准，草稿只在待审时使用。"
        : `候选状态：${status}，草稿只在待审时使用。`,
    ),
  );
  return NO_DRAFT_SELECTION;
}

/** 右栏：草稿状态、说明、歧义确认与可勾选排除的事件/节点。 */
export function renderDraft(
  panel: HTMLElement,
  draft: DraftView | null | undefined,
  onChange: () => void,
): DraftSelection {
  panel.replaceChildren();
  const none = NO_DRAFT_SELECTION;
  if (!draft) {
    panel.append(
      el("p", { class: "draft-status" }, draftBadge(null)),
      el(
        "p",
        { class: "field-hint" },
        "AI 草稿尚未生成（运行开关里的「模型抽取」关闭时不会生成）。可以驳回，或展开下方「高级」手动编辑。",
      ),
    );
    return none;
  }
  const usage = draft.usage ? ` · 用量 ${draft.usage.neurons} Neurons` : "";
  panel.append(
    el(
      "p",
      { class: "draft-status" },
      draftBadge(draft.status),
      el("span", { class: "field-hint" }, ` ${draft.profile_ref}${usage}`),
    ),
  );
  if (draft.notes.length > 0)
    panel.append(
      el(
        "ul",
        { class: "draft-notes", "aria-label": "草稿说明" },
        draft.notes.map((note) => el("li", {}, note)),
      ),
    );
  const proposal = draft.proposal;
  if (!proposal || (draft.status !== "ready" && draft.status !== "invalid")) {
    panel.append(
      el("p", { class: "field-hint" }, "没有可采用的草稿内容，请驳回或在「高级」中手动处理。"),
    );
    return none;
  }
  if (proposal.classification === "no_event") {
    panel.append(
      el(
        "p",
        { class: "draft-verdict" },
        "AI 判断：这篇公告不含四类日程（卡池、限时活动、维护、直播）。",
      ),
    );
    return { ...none, usable: true, noEvent: true };
  }
  let confirm: HTMLInputElement | null = null;
  if (proposal.classification === "uncertain") {
    confirm = el("input", { type: "checkbox", id: "confirm-ambiguities" });
    confirm.addEventListener("change", onChange);
    panel.append(
      el(
        "div",
        { class: "callout callout--warning draft-ambiguities" },
        el("p", { class: "callout-title" }, "AI 标出的疑点"),
        el(
          "ul",
          {},
          proposal.ambiguities.map((item) => el("li", {}, item)),
        ),
        el(
          "label",
          { class: "check", for: "confirm-ambiguities" },
          confirm,
          "我已对照原文核对，以上疑点不影响下面保留的日程",
        ),
      ),
    );
  }
  const boxes: { path: string; box: HTMLInputElement }[] = [];
  proposal.events.forEach((event, eventIndex) => {
    const eventBox = el("input", {
      type: "checkbox",
      checked: true,
      "data-path": `e${eventIndex}`,
      "aria-label": `保留事件：${event.title}`,
    });
    boxes.push({ path: `e${eventIndex}`, box: eventBox });
    const rows = event.milestones.map((milestone, milestoneIndex) => {
      const box = el("input", {
        type: "checkbox",
        checked: true,
        "data-path": `e${eventIndex}.m${milestoneIndex}`,
        "aria-label": `保留节点：${NODE_NAMES[milestone.node_type]} ${formatDraftTime(milestone.time)}`,
      });
      boxes.push({ path: `e${eventIndex}.m${milestoneIndex}`, box });
      return el(
        "li",
        { class: "draft-milestone" },
        box,
        el(
          "div",
          {},
          el(
            "p",
            { class: "draft-time" },
            `${NODE_NAMES[milestone.node_type]}：${formatDraftTime(milestone.time)}`,
          ),
          evidenceButton(milestone.time_evidence.block_ref, milestone.time_evidence.quote),
        ),
      );
    });
    panel.append(
      el(
        "section",
        { class: "draft-event", "aria-label": event.title },
        el(
          "label",
          { class: "draft-event-head" },
          eventBox,
          el(
            "span",
            { class: "badge badge--accent" },
            EVENT_NAMES[event.event_type] ?? event.event_type,
          ),
          el("strong", {}, event.title),
          event.status !== "scheduled"
            ? el("span", { class: "badge badge--warning" }, event.status)
            : null,
        ),
        el("ul", { class: "draft-milestones" }, rows),
      ),
    );
  });
  for (const { box } of boxes) box.addEventListener("change", onChange);
  const exclude = () => boxes.filter(({ box }) => !box.checked).map(({ path }) => path);
  return {
    usable: true,
    noEvent: false,
    uncertain: proposal.classification === "uncertain",
    exclude,
    confirmed: () => confirm?.checked === true,
    keptCount: () =>
      proposal.events.filter(
        (event, eventIndex) =>
          !exclude().includes(`e${eventIndex}`) &&
          event.milestones.some((_, m) => !exclude().includes(`e${eventIndex}.m${m}`)),
      ).length,
  };
}
