import type { FeedbackContext } from "../../lib/errors/feedback";
import { feedbackForFailure } from "../../lib/errors/feedback";

interface ServiceFaultEventDetail {
  readonly failure: unknown;
  readonly context?: FeedbackContext;
}

/** 页面和请求层的统一故障入口，不接受服务端 message 作为页面文案。 */
export function publishServiceFault(failure: unknown, context?: FeedbackContext): void {
  document.dispatchEvent(
    new CustomEvent<ServiceFaultEventDetail>("hoyo:service-fault", {
      detail: { failure, context },
    }),
  );
}

export function initServiceFaultBanner(): void {
  const banner = document.getElementById("service-fault-banner");
  if (!(banner instanceof HTMLElement)) return;
  document.addEventListener("hoyo:service-fault", (event) => {
    const detail = (event as CustomEvent<ServiceFaultEventDetail>).detail;
    const feedback = feedbackForFailure(detail?.failure, detail?.context);
    const title = banner.querySelector("[data-fault-title]");
    const explanation = banner.querySelector("[data-fault-explanation]");
    const nextStep = banner.querySelector("[data-fault-next-step]");
    if (title) title.textContent = feedback.title;
    if (explanation) explanation.textContent = feedback.explanation;
    if (nextStep) nextStep.textContent = feedback.nextStep;
    banner.dataset.outcome = feedback.outcome;
    banner.hidden = false;
  });
}
