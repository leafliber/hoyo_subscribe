// 管理端各页共用的登录会话：引导秘密换会话、退出、忙碌状态与错误提示（F6-01 行为，P3-19 拆页后共用）。
// 是否已登录只以管理接口是否返回 401 为准，不在浏览器里另存登录标志。
import { AdminRequestError, request } from "./api";

export interface AdminPage {
  /** 登录后或页面打开时读取本页数据；成功后调用 session.showLoggedIn()。 */
  load(): Promise<void>;
  /** 退出或会话失效时清空本页状态。 */
  reset(): void;
  /** 忙碌状态变化后刷新本页自己的按钮。 */
  refresh?(): void;
  /** 字段级 400 能落到的输入框 id（其提示元素为 `${id}-error`）。 */
  fields?: readonly string[];
}

export interface AdminSession {
  run(work: () => Promise<void>): Promise<void>;
  isBusy(): boolean;
  showLoggedIn(): void;
  readonly notice: HTMLElement;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("admin_markup_missing");
  return node as T;
}

function waitMessage(error: AdminRequestError): string {
  const wait = error.detail?.code === "rate_limited" ? error.detail.retry_after_ms : undefined;
  return typeof wait === "number" && Number.isFinite(wait) && wait >= 0
    ? `请求过于频繁，请等待 ${Math.ceil(wait / 1_000)} 秒后再试。`
    : "请求过于频繁，请稍后再试。";
}

export function startAdminSession(page: AdminPage): AdminSession {
  const login = element<HTMLFormElement>("login");
  const secret = element<HTMLInputElement>("secret");
  const workspace = element("workspace");
  const notice = element("notice");
  const logout = element<HTMLButtonElement>("logout");
  let busy = false;

  const controls = () => {
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      // 运行开关面板自管忙碌与“未知值不可写”状态，会话层不覆盖它。
      if (button.closest("#controls-panel")) return;
      button.disabled = busy;
    });
    secret.disabled = busy;
    page.refresh?.();
  };
  const loggedOut = () => {
    workspace.hidden = true;
    login.hidden = false;
    logout.hidden = true;
    secret.value = "";
    page.reset();
  };
  const showLoggedIn = () => {
    workspace.hidden = false;
    login.hidden = true;
    logout.hidden = false;
  };
  const showError = (error: unknown) => {
    if (error instanceof AdminRequestError) {
      if (error.status === 401) {
        loggedOut();
        notice.textContent = "需要重新登录管理端。";
        return;
      }
      if (error.status === 429) {
        notice.textContent = waitMessage(error);
        return;
      }
      if (error.status === 400 && error.detail?.code === "validation") {
        let first: HTMLElement | null = null;
        for (const field of error.detail.fields) {
          const name = field.path.replace(/^\$\./, "").split(/[.[]/)[0];
          const known = page.fields?.includes(name) === true;
          const message =
            (known ? document.getElementById(`${name}-error`) : null) ??
            document.getElementById("candidate-error") ??
            notice;
          message.textContent += `${field.path}: ${field.reason} `;
          if (known) {
            const input = element(name);
            input.setAttribute("aria-invalid", "true");
            first ??= input;
            if (name === "target_event_id") element("target-field").hidden = false;
          }
        }
        notice.textContent = error.detail.fields.some(
          (field) => field.reason === "version_derivation_mismatch",
        )
          ? "版本锚点的时间与当前版本时间表不一致（时间表可能刚被修改），请重新读取本条后再处理。"
          : "操作未完成，请检查字段提示。";
        // 输入框在本次请求结束后才解锁，届时聚焦。
        if (first) queueMicrotask(() => first?.focus());
        return;
      }
    }
    notice.textContent = "请求未能确认完成，请重新读取后核对结果；不会自动重发写操作。";
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    controls();
    try {
      await work();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      controls();
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      if (!login.hidden) secret.focus();
    }
  };

  login.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    let submitted = secret.value;
    secret.value = ""; // 在任何 await 之前清空；无 name，也无原生表单凭证提交。
    void run(async () => {
      notice.textContent = "正在登录…";
      try {
        await request("auth/preauth", {});
        const pending = request("admin/session/bootstrap", { secret: submitted });
        submitted = "";
        await pending;
      } catch (error) {
        loggedOut();
        notice.textContent =
          error instanceof AdminRequestError && error.status === 429
            ? `无法登录。${waitMessage(error)}`
            : "无法登录";
        return;
      } finally {
        submitted = "";
      }
      await page.load();
      notice.textContent = "已登录管理端。";
    });
  });
  logout.addEventListener(
    "click",
    () =>
      void run(async () => {
        const receipt = await request<{ logged_out?: unknown }>("admin/session/logout", {});
        if (receipt.logged_out !== true) throw new Error("logout_not_confirmed");
        loggedOut();
        notice.textContent = "已退出管理端。";
      }),
  );
  const session: AdminSession = { run, isBusy: () => busy, showLoggedIn, notice };
  queueMicrotask(() => void run(() => page.load()));
  return session;
}
