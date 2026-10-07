import {
  buildApiErrorBody,
  type CalendarPreviewResponse,
  CalendarPreviewResponseSchema,
  calendarEntryTitle,
  FEED_DIAGNOSTICS,
  PUBLIC_CACHE_FRESH,
  SUBSCRIPTION_RULE_COPY,
} from "@hoyo/contracts";
import { CalendarRequestError, errorDetail, request } from "./api";

/** Cancelable waiting uses the server's retry_after_ms, never a second rate-limit constant. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
export async function savedPreview(
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<CalendarPreviewResponse> {
  let first: CalendarPreviewResponse | null = null;
  let cursor: string | null = null;
  let deadline = Infinity;
  const items: CalendarPreviewResponse["items"] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  for (;;) {
    let page: CalendarPreviewResponse;
    try {
      page = CalendarPreviewResponseSchema.parse(
        await request(
          `me/calendar/preview${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          signal,
        ),
      );
    } catch (error) {
      const delay = errorDetail(error).retry_after_ms;
      if (
        error instanceof CalendarRequestError &&
        error.status === 429 &&
        typeof delay === "number" &&
        Number.isFinite(delay) &&
        delay > 0
      ) {
        progress(
          `预览不完整；请求频率受限，按服务端要求等待 ${Math.ceil(delay / 1000)} 秒后继续当前页。`,
        );
        await wait(delay, signal);
        if (Date.now() > deadline)
          throw new CalendarRequestError(
            409,
            buildApiErrorBody("conflict", { code: "conflict", reason: "preview_outdated" }),
          );
        continue;
      }
      throw error;
    }
    if (!first) {
      first = page;
      deadline =
        Date.now() + Math.max(0, PUBLIC_CACHE_FRESH * 1000 - (page.server_time - page.asOf));
    } else {
      const signature = (p: CalendarPreviewResponse) =>
        JSON.stringify([
          p.subscription,
          p.publication,
          p.asOf,
          p.config,
          p.totals,
          p.omitted,
          p.outcome,
          p.outcome === "blocked" ? p.diagnostic : null,
        ]);
      if (signature(first) !== signature(page))
        throw new CalendarRequestError(
          409,
          buildApiErrorBody("conflict", { code: "conflict", reason: "preview_outdated" }),
        );
    }
    for (const item of page.items) {
      if (ids.has(item.milestoneId)) throw new Error("duplicate_preview_item");
      ids.add(item.milestoneId);
      items.push(item);
    }
    if (items.length > first.totals.items) throw new Error("invalid_preview_count");
    progress(
      `服务端已保存预览：已读取 ${items.length} / ${first.totals.items} 条；${page.outcome === "blocked" ? `受阻：${FEED_DIAGNOSTICS[page.diagnostic]}。请缩小已保存范围或稍后重试；` : ""}尚未确认完整。`,
    );
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || page.items.length === 0))
      throw new Error("invalid_preview_cursor");
    if (cursor) cursors.add(cursor);
    if (!cursor) break;
  }
  if (!first || items.length !== first.totals.items) throw new Error("incomplete_preview");
  return { ...first, items, nextCursor: null };
}
export function renderSavedPreview(root: HTMLElement, preview: CalendarPreviewResponse): void {
  root.replaceChildren();
  const time = (ms: number) =>
    new Date(ms).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const box = make("div", "confirm-summary");
  box.append(
    make("p", "confirm-title", preview.outcome === "ok" ? "完整预览 · 即将启用的日历" : "预览受阻"),
  );
  if (preview.outcome !== "ok") {
    box.append(
      make(
        "p",
        "callout callout--warning",
        `预览受阻：${FEED_DIAGNOSTICS[preview.diagnostic]}。请缩小订阅范围；如果是数据源过期，请稍后重试。`,
      ),
    );
  } else {
    const stats = make("div", "preview-stats");
    for (const [value, label] of [
      [preview.totals.items, "个日程"],
      [preview.totals.withAlarm, "个带提醒"],
      [preview.totals.reminderAssociated, "个提醒关联"],
    ] as const) {
      const stat = make("div", "stat");
      stat.append(make("strong", "", String(value)), make("span", "", label));
      stats.append(stat);
    }
    box.append(stats);
  }
  box.append(
    make(
      "p",
      "text-aux",
      `基于已保存的第 ${preview.subscription.revision} 版设置 · 数据时间 ${time(preview.asOf)} · 发布代次 ${preview.publication.generation}。包含 ${time(preview.window.start)} 至 ${time(preview.window.end)} 的活动（不含结束时刻）。`,
    ),
  );
  if (preview.outcome === "ok" && preview.items.length === 0)
    box.append(
      make("p", "text-secondary", "真实没有匹配的日历条目。你仍可以启用，以后有新活动会自动出现。"),
    );
  const rules = (ids: string[]) =>
    ids.map((id) => SUBSCRIPTION_RULE_COPY.find((r) => r.rule_id === id)?.label ?? id).join("、");
  const list = make("ol", "confirm-list");
  for (const item of preview.items) {
    const li = make("li", "confirm-item");
    li.dataset.milestone = item.milestoneId;
    li.append(
      make(
        "span",
        "confirm-when",
        item.time.precision === "date" ? `${item.time.date} 全天` : time(item.time.utc_ms),
      ),
    );
    // ADR-0031：与日历里的条目标题一致。
    const main = make("span", "confirm-what", calendarEntryTitle(item));
    li.append(main);
    const notes: string[] = [];
    if (item.inclusion.kind === "reminder_associated")
      notes.push(
        `提醒关联节点：为「${rules(item.inclusion.ruleIds)}」保留；${item.inclusion.hiddenBy.map((by) => (by === "event_type" ? "事件类型已隐藏" : "节点类型已隐藏")).join("、")}`,
      );
    if (item.patch) notes.push(`更正：${item.patch.factReason}`);
    if (item.cancelled) notes.push("已取消，不是即将发生的安排");
    if (item.alarm)
      notes.push(
        item.alarm.blocked
          ? `无精确闹钟：${{ alarms_disabled: "日历提醒已关闭", cancelled: "条目已取消", date_only: "只有日期", estimated: "预计或未确定时间" }[item.alarm.blocked]}`
          : `闹钟：${rules(item.alarm.ruleIds)}`,
      );
    else notes.push("没有匹配的提醒规则");
    li.append(make("span", "confirm-note", `${notes.join("；")}。`));
    list.append(li);
  }
  if (preview.items.length) box.append(list);
  if (preview.omitted.unknownTime || preview.omitted.reminderNotExact)
    box.append(
      make(
        "p",
        "text-aux",
        `未进入日历：时间待定 ${preview.omitted.unknownTime} 条；提醒时间不精确 ${preview.omitted.reminderNotExact} 条。`,
      ),
    );
  box.append(make("p", "text-aux", "订阅后内容会随官方公告更新；日历应用何时刷新由应用决定。"));
  root.append(box);
}
