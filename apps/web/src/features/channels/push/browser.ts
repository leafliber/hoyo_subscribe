// F5-01 · 本浏览器的通知能力与本机凭证（前端 §9.3；主方案 §7.8；ADR-0025）。
//
// - 只在用户点击后才申请系统权限、注册 Service Worker、订阅推送（§9.3 第一段）；读取状态不产生这些副作用。
// - 本浏览器持有哪条绑定由本机保存的 { binding_id, receipt_token } 决定，不按 endpoint 认领（D3 §2.8）。
//   记录放在 IndexedDB，与 /sw.js 共用（Service Worker 读不到 localStorage）。receipt token 是只能确认
//   本浏览器接收的窄能力，不能管理账号；它不进 URL、日志、草稿或偏好导出。

export type BrowserPermission = "unsupported" | "default" | "denied" | "granted";

export const SERVICE_WORKER_URL = "/sw.js";
/** 与 apps/web/public/sw.js 的同名常量一致（Service Worker 是独立脚本，不能 import 本模块）。 */
const DB_NAME = "hoyo-push";
const STORE = "binding";
const KEY = "current";

export interface LocalBinding {
  readonly binding_id: string;
  readonly receipt_token: string;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    typeof indexedDB !== "undefined"
  );
}

/** iPhone / iPad 只有从主屏幕打开的网页应用才能接收推送（iOS 16.4 起）。 */
export function iosNeedsHomeScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function browserPermission(): BrowserPermission {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

/** 必须在点击处理函数里最先调用（部分浏览器要求权限申请紧跟用户手势）。 */
export function requestBrowserPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const text = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export interface BrowserSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}
function toBrowserSubscription(subscription: PushSubscription): BrowserSubscription {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error("push_subscription_incomplete");
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** 用户已点击并授权后：注册 Service Worker 并订阅（已有订阅时复用同一端点）。 */
export async function subscribeBrowser(applicationServerKey: string): Promise<BrowserSubscription> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  const ready = await navigator.serviceWorker.ready;
  const manager = (ready ?? registration).pushManager;
  const existing = await manager.getSubscription();
  const subscription =
    existing ??
    (await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(applicationServerKey),
    }));
  return toBrowserSubscription(subscription);
}

/** 只读：本浏览器当前是否还有推送订阅（不注册、不申请权限）。 */
export async function currentBrowserSubscription(): Promise<BrowserSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? toBrowserSubscription(subscription) : null;
  } catch {
    return null;
  }
}

/** 用户明确选择"为当前账号重新创建本浏览器的通知订阅"时：退订后重新订阅得到新端点。 */
export async function resetBrowserSubscription(
  applicationServerKey: string,
): Promise<BrowserSubscription> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  const ready = await navigator.serviceWorker.ready;
  const manager = (ready ?? registration).pushManager;
  await (await manager.getSubscription())?.unsubscribe();
  return toBrowserSubscription(
    await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(applicationServerKey),
    }),
  );
}

/** 删除本浏览器的绑定后顺带退订，避免推送服务继续保留无主端点。失败不影响服务端结果。 */
export async function unsubscribeBrowser(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    /* 浏览器侧清理是尽力而为 */
  }
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openStore();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve((request.result as T | undefined) ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function readLocalBinding(): Promise<LocalBinding | null> {
  if (!pushSupported()) return null;
  try {
    const value = await withStore<unknown>("readonly", (store) => store.get(KEY));
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as LocalBinding).binding_id === "string" &&
      typeof (value as LocalBinding).receipt_token === "string"
    )
      return value as LocalBinding;
    return null;
  } catch {
    return null;
  }
}
export async function writeLocalBinding(record: LocalBinding): Promise<void> {
  await withStore("readwrite", (store) =>
    store.put({ binding_id: record.binding_id, receipt_token: record.receipt_token }, KEY),
  );
}
export async function clearLocalBinding(): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(KEY));
  } catch {
    /* 尽力而为 */
  }
}

/** Service Worker 报回执后通知页面重新读取（只带结果码，不带凭证）。 */
export function onReceipt(listener: () => void, signal: AbortSignal): void {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener(
    "message",
    (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === "hoyo-push-receipt") listener();
    },
    { signal },
  );
}
