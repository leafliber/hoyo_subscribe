// F2-04 获准跨卡：只挂草稿读写、导入入口与身份清理，不改变表单业务语义。
// F2-03 获准跨卡改动：只连接 F2-01 表单与保存状态机，不改变四类设置语义。
import {
  changeNotificationScope,
  type EventType,
  type GameId,
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SUBSCRIPTION_RULE_COPY,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";
import { CalendarChannelLifecycle } from "../channels/calendar/lifecycle";
import { EmailChannelLifecycle } from "../channels/email/lifecycle";
import { SubscriptionDraftController } from "./draft/controller";
import { CalendarPreview } from "./preview/controller";
import {
  type Draft,
  makeDraft,
  type Phase,
  type Snapshot,
  SubscriptionSaveMachine,
} from "./save/machine";

const form = document.getElementById("subscription-form");

if (form instanceof HTMLFormElement) {
  const choices = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const initialChoice = new Map(choices.map((choice) => [choice, choice.checked]));
  const cloudState = document.getElementById("cloud-state");
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
  const comparison = document.getElementById("save-comparison");
  const differences = document.getElementById("save-differences");
  const recheck = document.getElementById("recheck-save");
  const saveButton = document.getElementById("save-subscription");
  const discardButton = document.getElementById("discard-changes");
  const channelSummary = document.getElementById("channel-saved-summary");
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
        ? "已选择日历提醒；请在接收方式核对地址与客户端状态。"
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
        ? `本机已选：${active.map((item) => item.label).join("、")}；接收状态请查看下方接收方式`
        : "本机已关闭全部变更消息";
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
    if (!config)
      return {
        游戏: "暂无",
        提醒: "暂无",
        日历显示: "暂无",
        变更消息: "暂无",
      };
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
      提醒: ruleNames.join("、") || "未选择提前提醒",
      日历显示: `事件 ${eventNames.join("、") || "未选择"}；节点 ${nodeNames.join("、") || "未选择"}；日历提醒${config.calendar.alarms_enabled ? "开启" : "关闭"}`,
      变更消息: changes.map((item) => item.label).join("、") || "全部关闭",
    };
  }

  let drafts: SubscriptionDraftController | undefined;
  let email: EmailChannelLifecycle | undefined;
  let calendar: CalendarChannelLifecycle | undefined;
  let calendarEnabled = false;
  let savePhase: Phase = "guest";
  function createMachine(): SubscriptionSaveMachine {
    return new SubscriptionSaveMachine(
      {
        readDraft: draftFromForm,
        applyDraft,
        render(phase: Phase, message: string, snapshot: Snapshot | null) {
          drafts?.paint(phase);
          savePhase = phase;
          email?.update(phase, snapshot);
          calendar?.update(phase, snapshot);
          const saved = snapshot?.config;
          if (cloudState)
            cloudState.textContent = saved
              ? `云端已保存 · 版本 ${snapshot.revision}`
              : "尚无已保存订阅";
          if (draftState)
            draftState.textContent = (
              {
                guest: "本机预选 · 尚未保存",
                loading: "正在读取云端设置",
                saved: "当前选择与云端一致",
                dirty: "本机未保存修改",
                saving: "正在保存",
                conflict: "云端与本机草稿待比较",
                uncertain: "云端结果尚未确认",
              } satisfies Record<Phase, string>
            )[phase];
          if (saveResult)
            saveResult.textContent =
              message + (phase === "saved" && calendarEnabled ? " 地址保持不变。" : "");
          if (saveButton instanceof HTMLButtonElement)
            saveButton.disabled = phase === "saving" || phase === "loading" || phase === "conflict";
          if (discardButton instanceof HTMLButtonElement)
            discardButton.disabled = phase === "saving";
          if (recheck instanceof HTMLButtonElement)
            recheck.hidden = phase === "guest" || phase === "saving" || phase === "loading";
          if (channelSummary)
            channelSummary.textContent = saved
              ? `接收方式将使用已保存的配置：游戏 ${groupText(saved).游戏}；提醒 ${groupText(saved).提醒}；日历显示 ${groupText(saved).日历显示}；变更消息 ${groupText(saved).变更消息}。版本 ${snapshot.revision}。`
              : "尚无已保存配置可用于开通接收方式。";
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
          for (const group of ["游戏", "提醒", "日历显示", "变更消息"] as const) {
            const section = document.createElement("section");
            const heading = document.createElement("h3");
            heading.textContent = `${group}${cloudGroups[group] === draftGroups[group] ? " · 相同" : " · 不同"}`;
            const cloudLine = document.createElement("p");
            cloudLine.textContent = `云端：${cloudGroups[group]}`;
            const draftLine = document.createElement("p");
            draftLine.textContent = `本机草稿：${draftGroups[group]}`;
            section.append(heading, cloudLine, draftLine);
            differences.append(section);
          }
        },
        validation(path) {
          if (path?.includes("scope.games")) showError(gameError);
          else if (path?.includes("calendar.event_types")) {
            if (calendarDetails instanceof HTMLDetailsElement) calendarDetails.open = true;
            showError(eventTypeError);
          }
          if (saveResult) saveResult.textContent = "请检查所选内容；草稿未写入云端。";
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
    reset() {
      email?.invalidate();
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
      if (cloudState) cloudState.textContent = "身份待确认";
      if (channelSummary) channelSummary.textContent = "身份待确认，未展示已保存配置。";
      if (draftState) draftState.textContent = "本机预选 · 尚未保存";
      if (saveResult) saveResult.textContent = "";
      if (comparison) comparison.hidden = true;
      differences?.replaceChildren();
      if (previewRoot) previewRoot.textContent = "身份待确认，已清除原预览。";
      if (saveButton instanceof HTMLButtonElement) saveButton.disabled = false;
      if (discardButton instanceof HTMLButtonElement) discardButton.disabled = false;
      return machine;
    },
  });

  form.addEventListener("change", () => {
    if (!drafts?.current()) return;
    hideErrors();
    sync();
    machine.edited();
    drafts.edited();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!drafts?.current()) return;
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
    await drafts?.save();
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
    if (window.confirm("采用云端设置会丢弃本机草稿。确定继续吗？")) {
      if (!machine.getSnapshot()?.config) {
        for (const choice of choices) choice.checked = initialChoice.get(choice) ?? false;
        sync();
      }
      machine.adoptCloud();
      drafts?.discarded();
    }
  });
  document.getElementById("keep-draft")?.addEventListener("click", () => machine.keepDraft());
  recheck?.addEventListener("click", () => void drafts?.refresh(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void drafts?.refresh();
  });

  const calendarRoot = document.getElementById("calendar-channel");
  if (calendarRoot)
    calendar = new CalendarChannelLifecycle(calendarRoot, {
      machine: () => machine,
      readDraft: draftFromForm,
      phase: () => savePhase,
      save: async () => {
        await drafts?.save();
      },
      current: () => drafts?.current() ?? false,
      addressChanged: (enabled) => {
        calendarEnabled = enabled;
      },
      disableAlarms: async () => {
        const draft = draftFromForm();
        applyDraft({ ...draft, calendar: { ...draft.calendar, alarms_enabled: false } });
        machine.edited();
        drafts?.edited();
        await drafts?.save();
      },
    });
  const mailRoot = document.getElementById("mail-channel");
  if (mailRoot) {
    email = new EmailChannelLifecycle(mailRoot, {
      machine: () => machine,
      readDraft: draftFromForm,
      phase: () => savePhase,
      save: async () => {
        await drafts?.save();
      },
      current: () => drafts?.current() ?? false,
    });
  }
  window.addEventListener("pagehide", () => {
    calendar?.destroy();
    preview?.destroy();
    preview = undefined;
  });
  sync();
  void drafts.start();
}
