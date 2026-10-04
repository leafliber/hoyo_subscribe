import { BROWSE_TIMEZONE, browseTimestamp } from "@hoyo/contracts";
import { AdminRequestError, request } from "./api";
import {
  type DraftSelection,
  draftBadge,
  gameName,
  renderDecided,
  renderDraft,
  renderReadableBlocks,
} from "./draft";
import type {
  AdoptReply,
  CandidateDetail,
  PublicationReply,
  QueuePage,
  QueueRow,
  ReviewAction,
} from "./types";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("admin_markup_missing");
  return node as T;
}
const login = element<HTMLFormElement>("login");
const secret = element<HTMLInputElement>("secret");
const workspace = element("workspace");
const review = element("review");
const notice = element("notice");
const proposal = element<HTMLTextAreaElement>("proposal_json");
const reason = element<HTMLTextAreaElement>("reason");
const reasonPreset = element<HTMLSelectElement>("reason-preset");
const articleId = element<HTMLInputElement>("article_version_id");
const action = element<HTMLSelectElement>("action");
const target = element<HTMLInputElement>("target_event_id");
const retryButton = element<HTMLButtonElement>("retry-publication");
const publication = element("publication");
const advanced = element<HTMLDetailsElement>("advanced");
const adoptButton = element<HTMLButtonElement>("adopt-approve");
const noEventButton = element<HTMLButtonElement>("confirm-no-event");
const rejectButton = element<HTMLButtonElement>("quick-reject");
let current: CandidateDetail | null = null;
let selection: DraftSelection | null = null;
let creating = false;
let busy = false;
let retry: {
  action: ReviewAction;
  id: string;
  reason: string;
  target?: string;
  proposal: string;
} | null = null;

function controls(): void {
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    // 运行开关面板自管忙碌与“未知值不可写”状态，审核流程不覆盖它。
    if (button.closest("#controls-panel")) return;
    button.disabled = busy;
  });
  secret.disabled = busy;
  reason.disabled = busy;
  reasonPreset.disabled = busy;
  element<HTMLFieldSetElement>("editor-fields").disabled = busy || (!creating && current === null);
  articleId.readOnly = !creating;
  action.disabled = creating || busy;
  element("target-field").hidden = creating || action.value !== "associate";
  target.required = !creating && action.value === "associate";
  element("submit").textContent = creating ? "新建候选" : "提交操作";
  retryButton.hidden = retry === null;
  element("retry-help").hidden = retry === null;
  // 快捷操作：只在读到候选且草稿可用时开放；有歧义的草稿必须先勾选确认。
  const usable = !busy && !creating && current !== null && selection?.usable === true;
  // 新建候选时理由仍要填写，只隐藏针对草稿的按钮。
  element("quick-buttons").hidden = creating;
  element("quick-help").hidden = creating;
  noEventButton.hidden = selection?.noEvent !== true;
  adoptButton.hidden = selection?.noEvent === true;
  adoptButton.disabled =
    !usable ||
    selection?.noEvent === true ||
    (selection?.keptCount() ?? 0) === 0 ||
    (selection?.uncertain === true && !selection.confirmed());
  noEventButton.disabled = !usable || selection?.noEvent !== true;
  rejectButton.disabled = busy || creating || current === null;
}
function clearErrors(): void {
  document.querySelectorAll(".field-error").forEach((node) => {
    node.textContent = "";
  });
  document.querySelectorAll('[aria-invalid="true"]').forEach((node) => {
    node.removeAttribute("aria-invalid");
  });
}
function loggedOut(): void {
  current = null;
  selection = null;
  creating = false;
  retry = null;
  workspace.hidden = true;
  review.hidden = true;
  login.hidden = false;
  secret.value = "";
  proposal.value = "";
  reason.value = "";
  reasonPreset.value = "";
  target.value = "";
  articleId.value = "";
  element("queue").replaceChildren();
  element("blocks").replaceChildren();
  element("readable-blocks").replaceChildren();
  element("draft-panel").replaceChildren();
  element("evidence").replaceChildren();
  element("ai-usage").textContent = "";
  publication.textContent = "";
}
function waitMessage(error: AdminRequestError): string {
  const wait = error.detail?.code === "rate_limited" ? error.detail.retry_after_ms : undefined;
  return typeof wait === "number" && Number.isFinite(wait) && wait >= 0
    ? `请求过于频繁，请等待 ${Math.ceil(wait / 1_000)} 秒后再试。`
    : "请求过于频繁，请稍后再试。";
}
const KNOWN_FIELDS = ["article_version_id", "proposal_json", "reason", "target_event_id"];
function showError(error: unknown): void {
  if (error instanceof AdminRequestError) {
    if (error.status === 401) {
      loggedOut();
      notice.textContent = "需要重新登录管理端。";
      return;
    }
    if (error.status === 429) {
      notice.textContent = waitMessage(error);
      return;
    }
    if (error.status === 400 && error.detail?.code === "validation") {
      let first: HTMLElement | null = null;
      for (const field of error.detail.fields) {
        const fieldName = field.path.replace(/^\$\./, "").split(/[.[]/)[0];
        const known = KNOWN_FIELDS.includes(fieldName);
        const message = known ? element(`${fieldName}-error`) : element("candidate-error");
        message.textContent += `${field.path}: ${field.reason} `;
        if (known) {
          const input = element(fieldName);
          input.setAttribute("aria-invalid", "true");
          first ??= input;
          if (fieldName === "target_event_id") element("target-field").hidden = false;
        }
      }
      notice.textContent = "操作未完成，请检查字段提示。";
      // fieldset 在本次请求结束后才解锁，届时聚焦。
      if (first) queueMicrotask(() => first?.focus());
      return;
    }
  }
  notice.textContent = "请求未能确认完成，请重新读取后核对结果；不会自动重发写操作。";
}
async function run(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  controls();
  try {
    await work();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    controls();
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    if (!login.hidden) secret.focus();
  }
}
function textBlock(parent: HTMLElement, value: string): void {
  const pre = document.createElement("pre");
  pre.textContent = value;
  parent.append(pre);
}
function articleTitle(detail: CandidateDetail): string | null {
  const first = detail.article.blocks[0];
  return first && first.kind !== "html" && first.text.length > 0 ? first.text : null;
}
function renderDetail(detail: CandidateDetail, preserveDraft = false): void {
  current = detail;
  creating = false;
  review.hidden = false;
  const { candidate, article, evidence } = detail;
  element("detail-title").textContent = articleTitle(detail) ?? "候选详情";
  element("candidate-meta").textContent =
    `候选 ${candidate.id} · ${candidate.review_status} · 已读版本 ${candidate.updated_at}`;
  element("article-meta").textContent =
    `来源 ${article.sourceId} · 文章 ${article.externalId} · ${article.completeness} · ${article.officialUrl}`;
  element("media-warning").hidden = !(detail.media_count && detail.media_count > 0);
  articleId.value = article.articleVersionId;
  const saved = JSON.stringify(candidate.proposal_json, null, 2);
  if (!preserveDraft) proposal.value = saved;
  element("saved-proposal").textContent = saved;
  renderReadableBlocks(element("readable-blocks"), detail);
  const blocks = element("blocks");
  blocks.replaceChildren();
  article.blocks.forEach((block, index) => {
    textBlock(blocks, `blocks/${index}\n${block.kind === "html" ? block.html : block.text}`);
  });
  const evidenceList = element("evidence");
  evidenceList.replaceChildren();
  for (const item of evidence) {
    const li = document.createElement("li");
    textBlock(li, JSON.stringify(item, null, 2));
    evidenceList.append(li);
  }
  if (evidence.length === 0) {
    const li = document.createElement("li");
    li.textContent = "没有已保存的证据引用；候选中的引文请对照正文核验。";
    evidenceList.append(li);
  }
  // 草稿只对仍待审的候选有意义；没有可用草稿时直接展开高级编辑。
  selection =
    candidate.review_status === "pending"
      ? renderDraft(element("draft-panel"), detail.draft, controls)
      : renderDecided(element("draft-panel"), candidate.review_status);
  advanced.open = !selection.usable;
}
async function readDetail(id: string, preserveDraft = false): Promise<CandidateDetail> {
  // 读取失败时不能继续用旧版本写入。
  current = null;
  selection = null;
  const detail = await request<CandidateDetail>(
    `admin/review/candidates/${encodeURIComponent(id)}`,
  );
  renderDetail(detail, preserveDraft);
  return detail;
}
function queueItem(row: QueueRow): HTMLLIElement {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-item";
  const title = row.title ?? null;
  // 读屏名固定为"查看候选 + 标题"；没有标题的旧数据退回候选 ID。
  button.setAttribute("aria-label", `查看候选 ${title ?? row.id}`);
  button.disabled = busy;
  const heading = document.createElement("span");
  heading.className = "queue-title";
  heading.textContent = title ?? `候选 ${row.id}`;
  const meta = document.createElement("span");
  meta.className = "queue-meta";
  const createdAt = document.createElement("time");
  const instant = new Date(row.created_at);
  createdAt.dateTime = instant.toISOString();
  // 日期与时分共用 contracts 的 UTC+8 展示；秒不受整小时时区偏移影响。
  createdAt.textContent = `${browseTimestamp(row.created_at)}:${instant.getUTCSeconds().toString().padStart(2, "0")} · ${BROWSE_TIMEZONE}`;
  const parts = [
    row.game ? gameName(row.game) : null,
    row.source_id ? `来源 ${row.source_id}` : null,
    row.external_id ? `文章 ${row.external_id}` : null,
  ].filter((part): part is string => part !== null);
  meta.append(createdAt, parts.length > 0 ? ` · ${parts.join(" · ")}` : "");
  button.append(heading, meta, draftBadge(row.draft_status));
  button.addEventListener(
    "click",
    () =>
      void run(async () => {
        clearErrors();
        retry = null;
        publication.textContent = "";
        reason.value = "";
        reasonPreset.value = "";
        target.value = "";
        await readDetail(row.id);
        notice.textContent = "已读取候选，请对照原文核对草稿。";
        element("detail-title").focus();
      }),
  );
  li.append(button);
  return li;
}
async function loadQueue(): Promise<void> {
  const list = element("queue");
  const state = element("queue-state");
  list.replaceChildren();
  state.textContent = "正在读取待审队列…";
  let cursor: string | null = null;
  let count = 0;
  let firstPage = true;
  const seen = new Set<string>();
  try {
    do {
      const page: QueuePage = await request(
        `admin/review/queue${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      );
      workspace.hidden = false;
      login.hidden = true;
      if (firstPage && page.ai_usage)
        element("ai-usage").textContent =
          `今日 AI 草稿用量 ${page.ai_usage.settled + page.ai_usage.reserved} / ${page.ai_usage.cap} Neurons（UTC ${page.ai_usage.day}）`;
      firstPage = false;
      // 队列一页已带标题、来源与草稿状态，不再逐条读详情。
      for (const row of page.candidates) {
        list.append(queueItem(row));
        count++;
      }
      cursor = page.next_cursor;
      if (cursor !== null) {
        if (seen.has(cursor)) throw new Error("queue_cursor_repeated");
        seen.add(cursor);
      }
    } while (cursor !== null); // 空页仍按 next_cursor 继续。
    state.textContent = count ? `已读完队列，共 ${count} 个待审核候选。` : "没有待审核的候选";
  } catch (error) {
    state.textContent = "队列未读完，请重新读取。";
    throw error;
  }
}
async function conflict(id: string): Promise<void> {
  retry = null;
  notice.textContent = "已在别处改过。正在重新读取；本地 JSON 与理由保留，不会自动覆盖或提交。";
  try {
    await readDetail(id, true);
    notice.textContent =
      "已在别处改过。已重新读取最新版本，请对照“服务端已保存的候选”核对本地 JSON 后，再手动提交。";
  } catch (error) {
    if (error instanceof AdminRequestError && error.status === 401) throw error;
    notice.textContent = "已在别处改过，重新读取失败。写操作已暂停，请重新打开候选。";
  }
}
async function write(
  actionName: ReviewAction,
  id: string,
  body: Record<string, unknown>,
  savedProposal: string,
): Promise<void> {
  try {
    const result = await request<PublicationReply>(`admin/review/${actionName}`, body);
    if (actionName === "revise" || actionName === "reject") {
      retry = null;
      publication.textContent =
        actionName === "revise" ? "候选已修正，请核对后再裁定。" : "候选已驳回。";
    } else {
      const outcome = result.publication?.outcome;
      if (typeof outcome !== "string") throw new Error("unknown_publication");
      publication.textContent =
        outcome === "published"
          ? `已批准、已发布。publication.outcome: ${outcome}`
          : outcome === "unchanged"
            ? `已批准，本次未发生新发布。publication.outcome: ${outcome}（不代表此前从未发布）`
            : `已批准、未发布。publication.outcome: ${outcome}`;
      retry =
        outcome === "published"
          ? null
          : {
              action: actionName,
              id,
              reason: String(body.reason),
              ...(actionName === "associate" ? { target: String(body.target_event_id) } : {}),
              proposal: savedProposal,
            };
    }
    // 不能只用写响应猜状态；读取成功后才解锁下一次写入。
    await readDetail(id);
    notice.textContent = "已读取操作后的候选状态。";
    await loadQueue();
  } catch (error) {
    if (error instanceof AdminRequestError && error.status === 409) await conflict(id);
    else throw error;
  }
}
function requireReason(): boolean {
  if (reason.value.trim()) return true;
  element("reason-error").textContent = "请填写操作理由。";
  reason.setAttribute("aria-invalid", "true");
  return false;
}
/** 一键批准：先采用草稿（带排除与歧义确认），重新读取最新版本后用同一理由批准。 */
async function adoptAndApprove(): Promise<void> {
  clearErrors();
  if (!current || !selection?.usable || !requireReason()) return;
  const id = current.candidate.id;
  retry = null;
  publication.textContent = "";
  try {
    await request<AdoptReply>("admin/review/adopt-draft", {
      candidate_id: id,
      expected_updated_at: current.candidate.updated_at,
      // 后台可能已按新模型重新起草：绑定页面上显示的这一版草稿，变了就 409 重新读取。
      expected_draft_updated_at: current.draft?.updated_at,
      reason: reason.value,
      exclude: selection.exclude(),
      confirm_ambiguities: selection.confirmed(),
    });
  } catch (error) {
    if (error instanceof AdminRequestError && error.status === 409) return conflict(id);
    throw error;
  }
  const adopted = await readDetail(id);
  publication.textContent = "草稿已采用为候选，正在提交批准…";
  await write(
    "approve",
    id,
    {
      candidate_id: id,
      expected_updated_at: adopted.candidate.updated_at,
      reason: reason.value,
    },
    JSON.stringify(adopted.candidate.proposal_json, null, 2),
  );
}

login.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  let submitted = secret.value;
  secret.value = ""; // 在任何 await 之前清空；无 name，也无原生表单凭证提交。
  void run(async () => {
    notice.textContent = "正在登录…";
    try {
      await request("auth/preauth", {});
      const pending = request("admin/session/bootstrap", { secret: submitted });
      submitted = "";
      await pending;
    } catch (error) {
      loggedOut();
      notice.textContent =
        error instanceof AdminRequestError && error.status === 429
          ? `无法登录。${waitMessage(error)}`
          : "无法登录";
      return;
    } finally {
      submitted = "";
    }
    await loadQueue();
    notice.textContent = "已登录管理端。";
  });
});
element("reload").addEventListener(
  "click",
  () =>
    void run(async () => {
      await loadQueue();
      notice.textContent = "已重新读取队列。";
    }),
);
element("logout").addEventListener(
  "click",
  () =>
    void run(async () => {
      const receipt = await request<{ logged_out?: unknown }>("admin/session/logout", {});
      if (receipt.logged_out !== true) throw new Error("logout_not_confirmed");
      loggedOut();
      notice.textContent = "已退出管理端。";
    }),
);
element("new").addEventListener("click", () => {
  if (busy) return;
  current = null;
  selection = null;
  creating = true;
  retry = null;
  clearErrors();
  review.hidden = false;
  advanced.open = true;
  element("detail-title").textContent = "新建候选";
  element("candidate-meta").textContent = "新建绑定不可变文章版本；成功后重新读取正文与候选。";
  element("article-meta").textContent = "请填写已有的 article_version_id。";
  element("media-warning").hidden = true;
  element("blocks").replaceChildren();
  element("readable-blocks").replaceChildren();
  element("draft-panel").replaceChildren();
  element("evidence").replaceChildren();
  element("saved-proposal").textContent = "尚未保存";
  publication.textContent = "";
  articleId.value = "";
  proposal.value = "";
  reason.value = "";
  reasonPreset.value = "";
  target.value = "";
  controls();
  articleId.focus();
});
reasonPreset.addEventListener("change", () => {
  if (reasonPreset.value) reason.value = reasonPreset.value;
});
action.addEventListener("change", controls);
adoptButton.addEventListener("click", () => void run(adoptAndApprove));
noEventButton.addEventListener("click", () => void run(adoptAndApprove));
rejectButton.addEventListener(
  "click",
  () =>
    void run(async () => {
      clearErrors();
      if (!current || !requireReason()) return;
      retry = null;
      publication.textContent = "";
      await write(
        "reject",
        current.candidate.id,
        {
          candidate_id: current.candidate.id,
          expected_updated_at: current.candidate.updated_at,
          reason: reason.value,
        },
        JSON.stringify(current.candidate.proposal_json, null, 2),
      );
    }),
);
element<HTMLFormElement>("editor").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    clearErrors();
    if (!requireReason()) return;
    if (creating) {
      // create 没有已有候选，P3-10 schema 不接受 expected_updated_at；文章版本不可变。
      const result = await request<{ candidate: { candidateId: string } }>("admin/review/create", {
        article_version_id: articleId.value,
        proposal_json: proposal.value,
        reason: reason.value,
      });
      creating = false;
      await readDetail(result.candidate.candidateId);
      publication.textContent = "候选已新建，尚未批准。";
      await loadQueue();
      notice.textContent = "已读取新建候选。";
      return;
    }
    if (!current) return;
    const selected = action.value as ReviewAction;
    const saved = JSON.stringify(current.candidate.proposal_json, null, 2);
    if (selected !== "revise" && proposal.value !== saved) {
      notice.textContent = "JSON 有未保存修改，请先选择“修正”并提交，再进行裁定。";
      return;
    }
    retry = null;
    publication.textContent = "";
    await write(
      selected,
      current.candidate.id,
      {
        candidate_id: current.candidate.id,
        expected_updated_at: current.candidate.updated_at,
        reason: reason.value,
        ...(selected === "revise" ? { proposal_json: proposal.value } : {}),
        ...(selected === "associate" ? { target_event_id: target.value } : {}),
      },
      saved,
    );
  });
});
retryButton.addEventListener(
  "click",
  () =>
    void run(async () => {
      if (!retry) return;
      clearErrors();
      const operation = retry;
      const latest = await readDetail(operation.id, true);
      if (
        JSON.stringify(latest.candidate.proposal_json, null, 2) !== operation.proposal ||
        latest.candidate.review_status !== "approved"
      ) {
        retry = null;
        notice.textContent = "已在别处改过。已读取最新候选，请重新核对并选择操作；未重试发布。";
        return;
      }
      await write(
        operation.action,
        operation.id,
        {
          candidate_id: operation.id,
          expected_updated_at: latest.candidate.updated_at,
          reason: operation.reason,
          ...(operation.target === undefined ? {} : { target_event_id: operation.target }),
        },
        operation.proposal,
      );
    }),
);
void run(loadQueue);
