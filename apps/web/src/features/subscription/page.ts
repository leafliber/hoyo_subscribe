import {
  changeNotificationScope,
  type EventType,
  type GameId,
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";

const form = document.getElementById("subscription-form");

if (form instanceof HTMLFormElement) {
  const choices = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const initialChoice = new Map(choices.map((choice) => [choice, choice.checked]));
  const draftState = document.getElementById("draft-state");
  const calendarSummary = document.getElementById("calendar-summary");
  const changeSummary = document.getElementById("change-summary");
  const changeScopeText = document.getElementById("change-scope");
  const alarmStatus = document.getElementById("alarm-status");
  const emptyRuleNote = document.getElementById("rule-empty-note");
  const saveResult = document.getElementById("save-result");
  const gameError = document.getElementById("game-error");
  const eventTypeError = document.getElementById("event-type-error");
  const calendarDetails = document.getElementById("calendar-settings");

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
    const changed = choices.some((choice) => choice.checked !== initialChoice.get(choice));
    if (draftState) draftState.textContent = changed ? "本机未保存修改" : "本机预选 · 尚未保存";
    if (emptyRuleNote) emptyRuleNote.hidden = ruleIds.length !== 0;
    if (alarmStatus) {
      alarmStatus.textContent = alarm
        ? "已选择日历提醒；个人 Feed 尚未启用。"
        : "已关闭日历提醒；只影响日历闹钟与提醒关联节点。";
    }
    if (calendarSummary) {
      const eventNames = eventTypes.map((type) => SUBSCRIPTION_EVENT_TYPE_LABELS[type]);
      const nodeNames = nodeTypes.map((type) => SUBSCRIPTION_NODE_TYPE_LABELS[type]);
      calendarSummary.textContent = `事件：${eventNames.join("、") || "未选择"}；节点：${nodeNames.join("、") || "未选择"}；日历提醒${alarm ? "已选" : "关闭"}`;
    }

    // 与 Worker 共用 §5.3 的并集求解；页面只把求解结果转为显示文案。
    const scope = changeNotificationScope({
      scope: { games, regions: SUPPORTED_SCOPE_REGIONS },
      calendar: { event_types: eventTypes },
      notifications: { rule_ids: ruleIds },
    });
    if (changeScopeText) {
      const gameNames = [...scope.games].map((game) => SUBSCRIPTION_GAME_LABELS[game]);
      const typeNames = [...scope.event_types].map((type) => SUBSCRIPTION_EVENT_TYPE_LABELS[type]);
      changeScopeText.textContent = `当前范围：${gameNames.join("、") || "未选游戏"} · ${typeNames.join("、") || "未选事件类型"}。`;
    }
    if (changeSummary) {
      const active = SUBSCRIPTION_CHANGE_COPY.filter((item) =>
        choices.some((choice) => choice.name === item.key && choice.checked),
      );
      changeSummary.textContent = active.length
        ? `本机已选：${active.map((item) => item.label).join("、")}；接收方式尚未开启`
        : "本机已关闭全部变更消息";
    }
  }

  form.addEventListener("change", () => {
    hideErrors();
    if (saveResult) saveResult.textContent = "当前选择尚未保存。";
    sync();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hideErrors();
    if (selected("games").length === 0) {
      if (saveResult) saveResult.textContent = "请先选择至少一个关注的游戏。";
      showError(gameError);
      return;
    }
    if (selected("event_types").length === 0) {
      if (calendarDetails instanceof HTMLDetailsElement) calendarDetails.open = true;
      if (saveResult) saveResult.textContent = "请先选择至少一种日历事件类型。";
      showError(eventTypeError);
      return;
    }
    if (saveResult) saveResult.textContent = "保存功能尚未接入，所选内容未写入云端。";
  });

  document.getElementById("discard-changes")?.addEventListener("click", () => {
    for (const choice of choices) choice.checked = initialChoice.get(choice) ?? false;
    hideErrors();
    if (saveResult) saveResult.textContent = "已放弃本机修改；仍无已保存订阅。";
    sync();
  });

  sync();
}
