import type { PublicSourceStatus } from "@hoyo/contracts";

/** 逐来源展示，不将某一来源的降级合成为整个游戏不可用。 */
export function sourceFeedback(source: PublicSourceStatus): { label: string; affected: boolean } {
  if (source.degradationReasons.includes("maintenance_required"))
    return { label: "维护中，暂不可用", affected: true };
  if (source.verificationState === "unavailable") return { label: "来源暂不可用", affected: true };
  if (source.degradationReasons.includes("content_unavailable"))
    return {
      label:
        source.verificationState === "verified"
          ? "仅列表可用，正文暂不可用"
          : "正文暂不可用，核验状态未知",
      affected: true,
    };
  return source.verificationState === "verified"
    ? { label: "已核验", affected: false }
    : { label: "核验状态未知", affected: true };
}
