import { parseSubscriptionConfig } from "@hoyo/contracts";
import type { Draft, Phase, SubscriptionSaveMachine } from "../../subscription/save/machine";

/** Host supplies the existing F2-03 machine and F2-04 save/identity lifecycle. */
export interface EmailSubscriptionHost {
  machine(): SubscriptionSaveMachine;
  readDraft(): Draft;
  phase(): Phase;
  save(): Promise<void>;
  current(): boolean;
  /** 读到或改变了邮件席位状态（ADR-0029 引导据此判断第 2 步是否完成）。 */
  stateChanged?(enabled: boolean): void;
}
export function hasUnsavedSubscription(host: EmailSubscriptionHost): boolean {
  const config = host.machine().getSnapshot()?.config;
  if (!config) return true;
  const parsed = parseSubscriptionConfig("initialized", {
    ...host.readDraft(),
    revision: config.revision,
  });
  return !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(config);
}

export async function saveBeforeEmail(host: EmailSubscriptionHost): Promise<boolean> {
  await host.save();
  return host.current() && host.phase() === "saved" && !hasUnsavedSubscription(host);
}
