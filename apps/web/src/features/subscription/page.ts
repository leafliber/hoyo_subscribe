import {
  changeNotificationScope,
  type EventType,
  type GameId,
  parseSubscriptionConfig,
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SUBSCRIPTION_RULE_COPY,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";
import { el } from "../../lib/dom";
import { CalendarChannelLifecycle } from "../channels/calendar/lifecycle";
import { EmailChannelLifecycle } from "../channels/email/lifecycle";
import { PushChannelLifecycle } from "../channels/push/lifecycle";
import { SubscriptionCloudFlow } from "./cloud-flow";
import { SubscriptionDraftController } from "./draft/controller";
import { CalendarPreview } from "./preview/controller";
import {
  csrfToken,
  type Draft,
  makeDraft,
  type Phase,
  type Snapshot,
  SubscriptionSaveMachine,
} from "./save/machine";
import { SubscriptionTabs } from "./tabs";

const form = document.getElementById("subscription-form");
const tablist = document.querySelector<HTMLElement>(".sub-tablist");
const tabs = tablist ? new SubscriptionTabs(tablist) : undefined;

const PHASE_LABEL: Record<Phase, { text: string; kind: string }> = {
  guest: { text: "未登录 · 设置仅保存在本机", kind: "" },
  loading: { text: "正在读取云端设置…", kind: "" },
  saved: { text: "已保存到云端", kind: "success" },
  dirty: { text: "有未保存的修改", kind: "warning" },
  saving: { text: "正在保存…", kind: "accent" },
  conflict: { text: "需要处理冲突", kind: "danger" },
  uncertain: { text: "保存结果待确认", kind: "warning" },
};

if (form instanceof HTMLFormElement) {
  const choices = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const initialChoice = new Map(choices.map((choice) => [choice, choice.checked]));
  const cloudState = document.getElementById("cloud-state");
  const draftState = document.getElementById("draft-state");
  const calendarSummary = document.getElementById("calendar-summary");
  const changeScopeText = document.getElementById("change-scope");
  const alarmStatus = document.getElementById("alarm-status");
  const emptyRuleNote = document.getElementById("rule-empty-note");
  const saveResult = document.getElementById("save-result");
  const saveBar = document.getElementById("save-bar");
  const gameError = document.getElementById("game-error");
  const eventTypeError = document.getElementById("event-type-error");
  const comparison = document.getElementById("save-comparison");
  const differences = document.getElementById("save-differences");
  const recheck = document.getElementById("recheck-save");
  const saveButton = document.getElementById("save-subscription");
  const discardButton = document.getElementById("discard-changes");
  const channelSummary = document.getElementById("channel-saved-summary");
  const contentBadge = document.getElementById("tab-content-badge");
  const previewRoot = document.getElementById("calendar-preview-content");
  let preview: CalendarPreview | undefined;
  let identityGeneration = 0;

  function selected(name: string): string[] {
    return choices
      .filter((choice) => choice.name === name && choice.checked)
      .map((choice) => choice.value);
  }

  function hideErrors(): void {
    if (gameError) gameError.hidden = true;
    if (eventTypeError) eventTypeError.hidden = true;
  }

  function showError(element: HTMLElement | null): void {
    if (!element) return;
    // 「接收方式」里的「保存后继续」也可能撞上字段错误：先回到出错的分区再定位。
    tabs?.select("content");
    element.hidden = false;
    element.focus();
    element.scrollIntoView({ block: "center" });
  }

  function sync(): void {
    const games = selected("games") as GameId[];
    const eventTypes = selected("event_types") as EventType[];
    const nodeTypes = selected("node_types") as (keyof typeof SUBSCRIPTION_NODE_TYPE_LABELS)[];
    const ruleIds = selected("rule_ids");
    const alarm = choices.find((choice) => choice.name === "alarms_enabled")?.checked ?? false;
    if (emptyRuleNote) emptyRuleNote.hidden = ruleIds.length !== 0;
    if (alarmStatus) {
      alarmStatus.textContent = alarm
        ? "日历会按下方规则提前提醒你（需要日历客户端支持提醒）。"
        : "已关闭：日历只显示活动，不会弹出提醒。下方规则仍保留，可用于邮件通知。";
    }
    for (const rule of form?.querySelectorAll<HTMLElement>(".rule-groups") ?? [])
      rule.classList.toggle("is-muted", !alarm);
    if (calendarSummary)
      calendarSummary.textContent = `已选 ${nodeTypes.length} / ${Object.keys(SUBSCRIPTION_NODE_TYPE_LABELS).length}`;

    // 与 Worker 共用并集求解；页面只把结果转为显示文案。
    const scope = changeNotificationScope({
      scope: { games, regions: SUPPORTED_SCOPE_REGIONS },
      calendar: { event_types: eventTypes },
      notifications: { rule_ids: ruleIds },
    });
    if (changeScopeText) {
      const gameNames = [...scope.games].map((game) => SUBSCRIPTION_GAME_LABELS[game]);
      const typeNames = [...scope.event_types].map((type) => SUBSCRIPTION_EVENT_TYPE_LABELS[type]);
      changeScopeText.textContent =
        gameNames.length && typeNames.length
          ? `适用范围：${gameNames.join("、")} 的 ${typeNames.join("、")}（日历里显示或设了提醒的活动）。`
          : "选择游戏和活动类型后，这里会显示通知的适用范围。";
    }
  }

  function draftFromForm(): Draft {
    const enabled = (name: string) =>
      choices.find((choice) => choice.name === name)?.checked ?? false;
    return makeDraft({
      games: selected("games"),
      eventTypes: selected("event_types"),
      nodeTypes: selected("node_types"),
      ruleIds: selected("rule_ids"),
      alarms: enabled("alarms_enabled"),
      changes: {
        new_event: enabled("new_event"),
        important_change: enabled("important_change"),
        cancelled_or_retracted: enabled("cancelled_or_retracted"),
        late_discovery: enabled("late_discovery"),
      },
    });
  }

  function applyDraft(draft: Draft): void {
    const values: Record<string, readonly string[]> = {
      games: draft.scope.games,
      event_types: draft.calendar.event_types,
      node_types: draft.calendar.node_types,
      rule_ids: draft.notifications.rule_ids,
    };
    for (const choice of choices) {
      const selectedValues = values[choice.name];
      if (selectedValues) choice.checked = selectedValues.includes(choice.value);
      else if (choice.name === "alarms_enabled") choice.checked = draft.calendar.alarms_enabled;
      else if (choice.name in draft.notifications) {
        choice.checked = draft.notifications[choice.name as keyof Draft["notifications"]] === true;
      }
    }
    sync();
  }

  function groupText(config: Draft | null): Record<string, string> {
    if (!config) return { 游戏: "暂无", 提醒: "暂无", 日历显示: "暂无", 变化通知: "暂无" };
    // 比较规范化集合，而不是复选框或响应数组的显示顺序。
    const normalized = parseSubscriptionConfig("uninitialized", { ...config, revision: 1 });
    if (normalized.success) config = normalized.data;
    const gameNames = config.scope.games.map((game) => SUBSCRIPTION_GAME_LABELS[game]);
    const ruleNames = config.notifications.rule_ids.map(
      (id) => SUBSCRIPTION_RULE_COPY.find((rule) => rule.rule_id === id)?.label ?? id,
    );
    const eventNames = config.calendar.event_types.map(
      (type) => SUBSCRIPTION_EVENT_TYPE_LABELS[type],
    );
    const nodeNames = config.calendar.node_types.map((type) => SUBSCRIPTION_NODE_TYPE_LABELS[type]);
    const changes = SUBSCRIPTION_CHANGE_COPY.filter((item) => config.notifications[item.key]);
    return {
      游戏: gameNames.join("、") || "未选择",
      提醒: `${config.calendar.alarms_enabled ? "日历提醒开启" : "日历提醒关闭"}；${ruleNames.join("、") || "未选择提前提醒"}`,
      日历显示: `${eventNames.join("、") || "未选择"}；节点：${nodeNames.join("、") || "未选择"}`,
      变化通知: changes.map((item) => item.label).join("、") || "全部关闭",
    };
  }

  let drafts: SubscriptionDraftController | undefined;
  let email: EmailChannelLifecycle | undefined;
  let push: PushChannelLifecycle | undefined;
  let flow: SubscriptionCloudFlow | undefined;
  let calendar: CalendarChannelLifecycle | undefined;
  let calendarEnabled = false;
  let savePhase: Phase = "guest";

  let lastSnapshot: Snapshot | null = null;
  /** 游客 = 没有登录凭据，或服务端已答复未登录；身份待确认时不引导去登录。 */
  function guest(): boolean {
    return (drafts?.identityStatus() ?? (csrfToken() ? "unknown" : "guest")) === "guest";
  }
  function paintStatePill(): void {
    if (!cloudState) return;
    const signedIn = flow?.signedIn() ?? false;
    const isGuest = guest();
    // 身份确认前（首屏或身份重置后、尚未读到云端）不沿用游客文案或原账号状态，
    // 避免把已登录的人说成未登录；云端读写已有进展时照常显示保存阶段。
    const pending = !signedIn && !isGuest && savePhase === "guest";
    const label =
      isGuest && savePhase !== "conflict"
        ? PHASE_LABEL.guest
        : pending
          ? { text: "登录状态待确认", kind: "" }
          : savePhase === "guest"
            ? { text: "尚未保存到云端", kind: "warning" }
            : PHASE_LABEL[savePhase];
    cloudState.textContent = label.text;
    cloudState.className = `status-pill${label.kind ? ` status-pill--${label.kind}` : ""}`;
    if (draftState)
      draftState.textContent = isGuest
        ? "登录后可保存到云端"
        : lastSnapshot?.config
          ? `云端版本 ${lastSnapshot.revision}`
          : pending || savePhase === "loading"
            ? ""
            : "保存后即可开启日历订阅";
  }

  function updateSaveGate(): void {
    paintStatePill();
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.disabled =
        ["saving", "loading", "conflict"].includes(savePhase) || (flow?.saveBlocked() ?? false);
      saveButton.textContent = guest()
        ? "登录并保存"
        : savePhase === "saving"
          ? "正在保存…"
          : "保存订阅";
    }
  }

  function renderSaveBar(phase: Phase, message: string, snapshot: Snapshot | null): void {
    if (saveBar) {
      saveBar.dataset.phase = phase;
      saveBar.classList.toggle(
        "is-attention",
        ["dirty", "conflict", "uncertain", "guest"].includes(phase),
      );
    }
    const isGuest = guest();
    if (saveResult)
      saveResult.textContent =
        isGuest && ["guest", "dirty"].includes(phase)
          ? "未登录时设置只保存在这台设备上，登录后即可保存到云端。"
          : message + (phase === "saved" && calendarEnabled ? " 日历链接保持不变。" : "");
    if (discardButton instanceof HTMLButtonElement) {
      discardButton.disabled = phase === "saving";
      discardButton.hidden = !["dirty", "uncertain"].includes(phase) || !snapshot?.config;
    }
    // 游客没有云端可重新读取。
    if (recheck instanceof HTMLButtonElement)
      recheck.hidden = isGuest || !["uncertain", "dirty", "conflict"].includes(phase);
    // 在「接收方式」分区也能看出订阅内容还有没保存的修改。
    if (contentBadge) {
      contentBadge.hidden = isGuest || !["dirty", "uncertain", "conflict"].includes(phase);
      contentBadge.textContent = phase === "dirty" ? "未保存" : "待处理";
    }
    updateSaveGate();
  }

  function createMachine(): SubscriptionSaveMachine {
    return new SubscriptionSaveMachine(
      {
        readDraft: draftFromForm,
        applyDraft,
        render(phase: Phase, message: string, snapshot: Snapshot | null) {
          // 冲突要在「订阅内容」里选择保留哪一份；从「接收方式」触发的保存也切回去。
          if (phase === "conflict" && savePhase !== "conflict") tabs?.select("content");
          drafts?.paint(phase);
          savePhase = phase;
          flow?.update(phase, snapshot);
          email?.update(phase, snapshot);
          push?.update(phase, snapshot);
          calendar?.update(phase, snapshot);
          const saved = snapshot?.config;
          lastSnapshot = snapshot;
          const comparisonMessage = document.getElementById("save-comparison-message");
          if (comparisonMessage && phase === "conflict") comparisonMessage.textContent = message;
          renderSaveBar(phase, message, snapshot);
          if (channelSummary)
            channelSummary.textContent = saved
              ? phase === "dirty"
                ? `日历和邮件使用已保存的第 ${snapshot.revision} 版设置；你有未保存的修改，保存后才会同步。`
                : `日历和邮件使用已保存的第 ${snapshot.revision} 版设置。修改后需要保存才会同步到日历。`
              : "日历和邮件会使用你保存到云端的设置。";
          if (previewRoot) {
            preview ??= new CalendarPreview(previewRoot, () => drafts?.current() ?? false);
            preview.update({
              draft: draftFromForm(),
              snapshot,
              saved: phase === "saved",
              identityGeneration,
            });
          }
        },
        compare(cloud, draft, visible) {
          if (!comparison || !differences) return;
          comparison.hidden = !visible;
          const adopt = document.getElementById("adopt-cloud");
          if (adopt instanceof HTMLButtonElement) adopt.disabled = cloud === null;
          differences.replaceChildren();
          if (!visible) return;
          const cloudGroups = groupText(cloud?.config ?? null);
          const draftGroups = groupText(draft);
          const table = el(
            "table",
            { class: "diff" },
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", { scope: "col" }, "项目"),
                el("th", { scope: "col" }, "云端"),
                el("th", { scope: "col" }, "本机修改"),
              ),
            ),
          );
          const body = el("tbody");
          for (const group of ["游戏", "提醒", "日历显示", "变化通知"] as const) {
            const same = cloudGroups[group] === draftGroups[group];
            body.append(
              el(
                "tr",
                { class: same ? "is-same" : "is-different" },
                el("th", { scope: "row" }, el("h3", {}, `${group}${same ? " · 相同" : " · 不同"}`)),
                el("td", {}, el("p", {}, `云端：${cloudGroups[group]}`)),
                el("td", {}, el("p", {}, `本机草稿：${draftGroups[group]}`)),
              ),
            );
          }
          table.append(body);
          differences.append(table);
        },
        validation(path) {
          if (path?.includes("scope.games")) showError(gameError);
          else if (path?.includes("calendar.event_types")) showError(eventTypeError);
          if (saveResult) saveResult.textContent = "请检查标出的选项；修改还没有保存到云端。";
        },
      },
      () => drafts?.current() ?? true,
    );
  }
  let machine = createMachine();
  drafts = new SubscriptionDraftController({
    form,
    readDraft: draftFromForm,
    machine: () => machine,
    readIdentity: () => (flow ? flow.identify() : Promise.resolve({ status: "unknown" })),
    reset() {
      email?.invalidate();
      push?.invalidate();
      flow?.invalidate();
      calendar?.invalidate();
      identityGeneration += 1;
      preview?.invalidate();
      savePhase = "guest";
      machine.dispose();
      for (const choice of choices) choice.checked = initialChoice.get(choice) ?? false;
      hideErrors();
      sync();
      machine = createMachine();
      // 身份控制器决定何时重新读取；原账号的提示与比较立即清空。
      lastSnapshot = null;
      if (channelSummary) channelSummary.textContent = "日历和邮件会使用你保存到云端的设置。";
      if (saveResult) saveResult.textContent = "";
      if (comparison) comparison.hidden = true;
      differences?.replaceChildren();
      if (previewRoot) previewRoot.textContent = "登录状态待确认，已清除原账号的预览。";
      paintStatePill();
      if (saveButton instanceof HTMLButtonElement) saveButton.disabled = false;
      if (discardButton instanceof HTMLButtonElement) discardButton.disabled = false;
      return machine;
    },
  });

  form.addEventListener("change", (event) => {
    // 导入/导出区位于表单内；选择文件不是订阅选项的修改，不能打断导入。
    if (event.target instanceof Element && event.target.closest(".local-preferences")) return;
    if (!drafts?.current()) return;
    hideErrors();
    sync();
    machine.edited();
    drafts.edited();
  });

  async function goLogin(): Promise<void> {
    if (await drafts?.prepareLogin()) window.location.assign("/login?returnTo=%2Fsubscription");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!drafts?.current()) return;
    if (flow?.saveBlocked()) return;
    hideErrors();
    if (selected("games").length === 0) {
      if (saveResult) saveResult.textContent = "请先选择至少一个关注的游戏。";
      showError(gameError);
      return;
    }
    if (selected("event_types").length === 0) {
      if (saveResult) saveResult.textContent = "请先选择至少一种日历活动类型。";
      showError(eventTypeError);
      return;
    }
    if (guest()) {
      await goLogin();
      return;
    }
    await drafts?.save();
    void flow?.refresh();
  });

  document.getElementById("discard-changes")?.addEventListener("click", () => {
    if (!drafts?.current()) return;
    if (!machine.getSnapshot()?.config) {
      for (const choice of choices) choice.checked = initialChoice.get(choice) ?? false;
    }
    hideErrors();
    sync();
    machine.discard();
    drafts?.discarded();
  });

  document.getElementById("adopt-cloud")?.addEventListener("click", () => {
    if (!drafts?.current()) return;
    if (window.confirm("使用云端设置会丢弃本机的修改。确定继续吗？")) {
      if (!machine.getSnapshot()?.config) {
        for (const choice of choices) choice.checked = initialChoice.get(choice) ?? false;
        sync();
      }
      machine.adoptCloud();
      drafts?.discarded();
    }
  });
  document.getElementById("keep-draft")?.addEventListener("click", () => void drafts?.keepDraft());
  recheck?.addEventListener("click", () => {
    void drafts?.refresh(true);
    void flow?.refresh();
  });
  document.getElementById("subscription-login")?.addEventListener("click", async (event) => {
    event.preventDefault();
    await goLogin();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void drafts?.refresh();
  });

  const calendarRoot = document.getElementById("calendar-channel");
  function mountCalendar(): void {
    if (!calendarRoot || calendar) return;
    calendar = new CalendarChannelLifecycle(calendarRoot, {
      machine: () => machine,
      readDraft: draftFromForm,
      phase: () => savePhase,
      save: async () => {
        if (flow?.saveBlocked()) return;
        await drafts?.save();
        void flow?.refresh();
      },
      current: () => drafts?.current() ?? false,
      addressChanged: (enabled) => {
        calendarEnabled = enabled;
        flow?.setChannel("calendar", enabled);
      },
      disableAlarms: async () => {
        if (flow?.saveBlocked()) return;
        const draft = draftFromForm();
        applyDraft({ ...draft, calendar: { ...draft.calendar, alarms_enabled: false } });
        machine.edited();
        drafts?.edited();
        await drafts?.save();
        void flow?.refresh();
      },
    });
  }
  mountCalendar();
  const mailRoot = document.getElementById("mail-channel");
  if (mailRoot) {
    email = new EmailChannelLifecycle(mailRoot, {
      machine: () => machine,
      readDraft: draftFromForm,
      phase: () => savePhase,
      save: async () => {
        if (flow?.saveBlocked()) return;
        await drafts?.save();
        void flow?.refresh();
      },
      current: () => drafts?.current() ?? false,
      stateChanged: (enabled) => flow?.setChannel("mail", enabled),
    });
  }
  // F5-01：本浏览器通知卡片只在 Push 能力开放、或本人已有绑定时出现。
  const pushRoot = document.getElementById("push-channel");
  if (pushRoot)
    push = new PushChannelLifecycle(pushRoot, {
      current: () => drafts?.current() ?? false,
      stateChanged: (active) => flow?.setChannel("push", active),
    });
  flow = new SubscriptionCloudFlow({
    current: () => drafts?.current() ?? false,
    gateChanged: updateSaveGate,
  });
  window.addEventListener("pagehide", () => {
    calendar?.destroy();
    calendar = undefined;
    email?.invalidate();
    push?.invalidate();
    flow?.invalidate();
    preview?.destroy();
    preview = undefined;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) mountCalendar();
  });
  sync();
  void drafts.start();
}
