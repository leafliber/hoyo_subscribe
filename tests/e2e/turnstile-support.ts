import type { Page } from "@playwright/test";

type SyntheticWidget = {
  action: string;
  sitekey: string;
  resets: number;
  callback(token: string): void;
  "expired-callback"(): void;
  "error-callback"(): void;
};
declare global {
  interface Window {
    bindingWidgets: Record<string, SyntheticWidget>;
  }
}
/** Explicit completion only: reset must not hand tests a new token automatically. */
export async function manualTurnstile(page: Page) {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.bindingWidgets ??= {}; window.turnstile = {
      render(el, options) { window.bindingWidgets[el.id] = {...options, resets: 0}; options.callback('synthetic-first-' + el.id); return el.id; },
      reset(id) { window.bindingWidgets[id].resets++; }
    };`,
    }),
  );
}
export async function widgetState(page: Page, id: string) {
  return page.evaluate((id) => {
    const widget = window.bindingWidgets?.[id];
    return widget
      ? { action: widget.action, sitekey: widget.sitekey, resets: widget.resets }
      : null;
  }, id);
}
export async function widgetEvent(page: Page, id: string, event: "complete" | "expired" | "error") {
  await page.evaluate(
    ({ id, event }) => {
      const widget = window.bindingWidgets[id];
      if (event === "complete") widget.callback(`synthetic-next-${id}`);
      else widget[`${event}-callback`]();
    },
    { id, event },
  );
}
