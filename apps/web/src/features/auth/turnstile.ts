interface Widget {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
}
export class Turnstile {
  private token = "";
  private widget: Widget | undefined;
  private id: string | undefined;
  constructor(private readonly status: HTMLElement) {}
  async load(sitekey: string, element: HTMLElement): Promise<void> {
    if (!sitekey) {
      this.status.textContent =
        "登录验证暂不可用：尚未配置人机验证。可继续公开浏览或使用恢复入口。";
      return;
    }
    this.status.textContent = "正在加载人机验证。";
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("widget_unavailable"));
        document.head.append(script);
      });
      this.widget = (window as Window & { turnstile?: Widget }).turnstile;
      if (!this.widget) throw new Error("widget_unavailable");
      this.id = this.widget.render(element, {
        sitekey,
        size: "flexible",
        "response-field": false,
        callback: (token: string) => {
          this.token = token;
          this.status.textContent = "人机验证已完成。";
        },
        "expired-callback": () => {
          this.token = "";
          this.status.textContent = "人机验证已过期，请重新验证。";
        },
        "error-callback": () => {
          this.token = "";
          this.status.textContent = "人机验证暂不可用，请稍后重试。";
        },
      });
    } catch {
      this.status.textContent = "人机验证加载失败，请检查网络后重新打开页面。";
    }
  }
  take(): string {
    const token = this.token;
    this.token = "";
    return token;
  }
  reset(): void {
    this.token = "";
    if (this.id !== undefined) this.widget?.reset(this.id);
  }
}
