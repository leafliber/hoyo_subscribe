// HoYo日历 Service Worker（P6 / F5-01；主方案 §7.8；前端 §9.3；ADR-0025）。
//
// 只做三件事：
// 1. 收到推送就显示一条可见通知（userVisibleOnly）；
// 2. 用本机保存的 receipt 窄能力报回执：激活通知带随机挑战，业务/测试通知带消息 ID；
// 3. 点击通知打开本站的站内路径（只接受以单个 "/" 开头的路径）。
// 不缓存页面、不拦截请求、不做后台同步或周期同步，也不发任何心跳。
// receipt token 只能确认本浏览器接收，不能读取邮箱或管理账号；它不进 URL，只在请求体里。

// 与 src/features/channels/push/browser.ts 一致（Service Worker 不能 import 页面模块）。
const DB_NAME = "hoyo-push";
const STORE = "binding";
const KEY = "current";
const SITE_PATH = /^\/(?!\/)[^\s\\]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readBinding() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const get = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        get.onsuccess = () => {
          db.close();
          const value = get.result;
          resolve(
            value && typeof value.binding_id === "string" && SECRET.test(value.receipt_token)
              ? value
              : null,
          );
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

/** 载荷形状与 packages/contracts 的 PushPayloadSchema 一致；不符合的一律当作无法识别。 */
function parsePayload(event) {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    return null;
  }
  if (
    data?.v !== 1 ||
    !UUID.test(data.binding_id) ||
    typeof data.title !== "string" ||
    typeof data.body !== "string" ||
    typeof data.tag !== "string" ||
    !SITE_PATH.test(data.url)
  )
    return null;
  if (data.kind === "activation" && SECRET.test(data.challenge)) return data;
  if ((data.kind === "test" || data.kind === "notification") && UUID.test(data.message_id))
    return data;
  return null;
}

async function report(payload) {
  const local = await readBinding();
  // 本机没有与这条通知对应的凭证（例如站点数据被清除）：只显示，不回执。
  if (!local || local.binding_id !== payload.binding_id) return false;
  const activation = payload.kind === "activation";
  try {
    const response = await fetch(
      `/api/v2/push-bindings/${payload.binding_id}/${activation ? "activate" : "processed"}`,
      {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          activation
            ? { receipt_token: local.receipt_token, challenge: payload.challenge }
            : { receipt_token: local.receipt_token, message_id: payload.message_id },
        ),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function handlePush(event) {
  const payload = parsePayload(event);
  if (!payload) {
    await self.registration.showNotification("HoYo日历", {
      body: "收到一条无法识别的通知。",
      tag: "hoyo-unrecognized",
    });
    return;
  }
  // 先让用户看到通知，再报回执：激活证明的是"可见地收到了"。
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    lang: "zh-CN",
    data: { url: payload.url },
  });
  const ok = await report(payload);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows)
    client.postMessage({ type: "hoyo-push-receipt", kind: payload.kind, ok });
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url;
  const target = new URL(SITE_PATH.test(path) ? path : "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows)
        if (client.url === target && "focus" in client) return client.focus();
      return self.clients.openWindow(target);
    }),
  );
});
