import {
  buildApiErrorBody,
  type CalendarPreviewResponse,
  CalendarPreviewResponseSchema,
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
  const p = (text: string) => {
    const el = document.createElement("p");
    el.textContent = text;
    root.append(el);
  };
  const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  p(
    `服务端已保存设置 · 版本 ${preview.subscription.revision} · 发布代次 ${preview.publication.generation} · 数据时间 ${time(preview.asOf)}（北京时间 UTC+8）`,
  );
  p(
    `基础窗口：${time(preview.window.start)} 至 ${time(preview.window.end)}（不含结束时刻）；更正条目可能延长窗口。`,
  );
  p(
    preview.outcome === "ok"
      ? `完整预览 · ${preview.totals.items} 条；提醒关联 ${preview.totals.reminderAssociated} 条，带闹钟 ${preview.totals.withAlarm} 条。`
      : `预览受阻：${FEED_DIAGNOSTICS[preview.diagnostic]}。请缩小已保存范围；来源过期时稍后重试。`,
  );
  p(
    `未进入日历：时间待定 ${preview.omitted.unknownTime} 条；提醒时间不精确 ${preview.omitted.reminderNotExact} 条。`,
  );
  if (preview.outcome === "ok" && preview.items.length === 0) p("真实没有匹配的日历条目。");
  const rules = (ids: string[]) =>
    ids.map((id) => SUBSCRIPTION_RULE_COPY.find((r) => r.rule_id === id)?.label ?? id).join("、");
  const list = document.createElement("ol");
  for (const item of preview.items) {
    const li = document.createElement("li");
    li.textContent = `${item.eventTitle} · ${item.milestoneTitle} · ${item.time.precision === "date" ? `${item.time.date}（具体时刻未公布）` : time(item.time.utc_ms)}。`;
    if (item.inclusion.kind === "reminder_associated")
      li.append(
        `提醒关联节点：为「${rules(item.inclusion.ruleIds)}」保留；${item.inclusion.hiddenBy.map((by) => (by === "event_type" ? "事件类型已隐藏" : "节点类型已隐藏")).join("、")}。`,
      );
    if (item.patch) li.append(`更正：${item.patch.factReason}。`);
    if (item.cancelled) li.append("已取消，不是即将发生的安排。");
    if (item.alarm)
      li.append(
        item.alarm.blocked
          ? `无精确闹钟：${{ alarms_disabled: "日历提醒已关闭", cancelled: "条目已取消", date_only: "只有日期", estimated: "预计或未确定时间" }[item.alarm.blocked]}。`
          : `闹钟：${rules(item.alarm.ruleIds)}。`,
      );
    else li.append("没有匹配的提醒规则。");
    list.append(li);
  }
  root.append(list);
  p("订阅后内容随官方更新变化；此预览不保证客户端稍后所见一致。地址是只读凭证，请勿公开分享。");
}
