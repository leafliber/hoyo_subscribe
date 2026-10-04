import { ARTICLE_COMPLETENESS_NOTES, type PublicEventArticlesResponse } from "@hoyo/contracts";
import { closeDialog, openDialog } from "../../components/dialog";
import { callout, el, icon } from "../../lib/dom";
import { stamp } from "../../lib/format";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";
import { articleTitle, external, renderArticleBody, safeExternalUrl } from "./article";
import { loadFeedback } from "./render";

// P3-22（ADR-0014）：「查看官方公告」打开的原文弹窗。官方接口只允许米哈游自家域名跨域读取，
// 浏览器不能直接请求官方；这里读取本站采集时保存的同一份正文（不可变版本），在浏览器里整理成文字。

type Article = PublicEventArticlesResponse["articles"][number];

const api = new PublicApiClient();
let root: HTMLElement | null = null;
let body: HTMLElement;
let request: AbortController | null = null;

function closeButton(label: string, className: string) {
  const button = el("button", { type: "button", class: className }, label);
  button.addEventListener("click", () => closeDialog(true));
  return button;
}

/** 弹窗根放在 body 直接子级：openDialog 会把 body 的其他子元素设为 inert。 */
function ensureDialog(): HTMLElement {
  if (root) return root;
  const backdrop = el("div", { class: "dialog-backdrop" });
  backdrop.addEventListener("click", () => closeDialog(true));
  const dismiss = el(
    "button",
    { type: "button", class: "article-dialog-close", "aria-label": "关闭" },
    icon("x"),
  );
  dismiss.addEventListener("click", () => closeDialog(true));
  // 只有正文区域滚动，标题栏与关闭按钮始终可见；可聚焦以便键盘滚动长公告。
  body = el("div", {
    class: "article-dialog-body",
    role: "region",
    "aria-label": "公告原文内容",
    tabindex: "0",
  });
  root = el(
    "div",
    {
      id: "article-dialog",
      class: "dialog article-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "article-dialog-title",
      hidden: true,
    },
    backdrop,
    el(
      "div",
      { class: "dialog-panel article-dialog-panel", "data-dialog-panel": "", tabindex: "-1" },
      el(
        "div",
        { class: "article-dialog-head" },
        el("h2", { id: "article-dialog-title", class: "dialog-title" }, "官方公告原文"),
        dismiss,
      ),
      body,
      el("div", { class: "dialog-actions" }, closeButton("关闭", "button button--secondary")),
    ),
  );
  document.body.append(root);
  return root;
}

function renderArticle(article: Article, heading: "h3" | "summary") {
  const title = articleTitle(article.blocks) ?? "（公告没有标题）";
  const source = safeExternalUrl(article.officialUrl);
  const facts = el(
    "p",
    { class: "article-facts" },
    `本站抓取于 ${stamp(article.fetchedAt)} · 第 ${article.versionNo} 版`,
    article.publishedAt === null ? null : ` · 官方发布于 ${stamp(article.publishedAt)}`,
    source
      ? [
          " · ",
          el(
            "a",
            { ...external(source), title: "官方接口返回的原始数据，适合核对，不适合直接阅读" },
            "官方数据源",
            icon("external-link"),
          ),
        ]
      : null,
  );
  const note =
    article.completeness === "complete"
      ? null
      : callout("warning", ARTICLE_COMPLETENESS_NOTES[article.completeness], {
          className: "article-gap",
        });
  const content = renderArticleBody(article.blocks);
  const parts = [facts, note, content.childNodes.length ? content : null];
  return heading === "h3"
    ? el("section", { class: "article-doc" }, el("h3", { class: "article-title" }, title), ...parts)
    : el(
        "details",
        { class: "article-doc disclosure" },
        el("summary", { class: "article-title" }, title),
        ...parts,
      );
}

function renderLoaded(response: PublicEventArticlesResponse, officialUrl: string | null) {
  if (!response.articles.length) {
    const source = safeExternalUrl(officialUrl);
    body.replaceChildren(
      callout(
        "info",
        [
          "暂时无法确认这个活动依据的公告原文版本，可能是本站正在更新发布数据，请稍后再试。",
          source
            ? el("p", {}, el("a", external(source), "打开官方数据源核对", icon("external-link")))
            : null,
        ],
        { className: "article-empty" },
      ),
    );
    return;
  }
  // 多份原文时，最新抓取的一份展开，其余折叠，免得一屏塞满重复内容。
  const [first, ...rest] = response.articles;
  body.replaceChildren(
    renderArticle(first, rest.length ? "summary" : "h3"),
    ...rest.map((article) => renderArticle(article, "summary")),
  );
  const firstDoc = body.querySelector<HTMLDetailsElement>("details.article-doc");
  if (firstDoc) firstDoc.open = true;
}

function failureText(error: unknown): string {
  if (error instanceof PublicReadError && error.status === 404)
    return "当前发布的日程里已经没有这个活动，请返回日程查看最新安排。";
  if (error instanceof PublicReadError && (error.status === 409 || error.body))
    return loadFeedback(error);
  return "网络连接失败或服务没有回应，请检查网络后重试。";
}

async function load(eventId: string, officialUrl: string | null) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  body.setAttribute("aria-busy", "true");
  body.replaceChildren(
    el("p", { class: "text-aux", role: "status" }, "正在读取本站保存的公告原文…"),
    el("div", { class: "skeleton skeleton-block" }),
  );
  try {
    renderLoaded(await api.articles(eventId, controller.signal), officialUrl);
  } catch (error) {
    if (controller.signal.aborted) return;
    const retry = el(
      "button",
      { type: "button", class: "button button--secondary" },
      icon("refresh"),
      "重试",
    );
    retry.addEventListener("click", () => void load(eventId, officialUrl));
    body.replaceChildren(
      callout("warning", failureText(error), { title: "原文没有读取成功", role: "status" }),
      el("div", { class: "button-row" }, retry),
    );
  } finally {
    if (request === controller) body.removeAttribute("aria-busy");
  }
}

/**
 * 打开原文弹窗。详情页可能在弹窗打开期间重绘，触发按钮会被替换；
 * 关闭时若原按钮已不在页面上，焦点回到重绘后同一位置的按钮。
 */
export function openArticleDialog(
  eventId: string,
  officialUrl: string | null,
  opener: HTMLElement,
) {
  const dialog = ensureDialog();
  if (!dialog.hidden) return;
  const origin = opener.dataset.articleOrigin;
  const watcher = new MutationObserver(() => {
    if (!dialog.hidden) return;
    watcher.disconnect();
    request?.abort();
    if (!opener.isConnected)
      document
        .querySelector<HTMLElement>(`[data-action="read-article"][data-article-origin="${origin}"]`)
        ?.focus();
  });
  watcher.observe(dialog, { attributes: true, attributeFilter: ["hidden"] });
  openDialog(dialog, opener);
  void load(eventId, officialUrl);
}
