/**
 * ADR-0032 公开数据的页面副本：只存公开接口（目录、日程、详情、原文、状态、兑换码）的响应，
 * 放在本标签页的 sessionStorage——关掉标签页即清空，不跨标签页、不跨会话，不含任何账号或私人数据
 * （私人接口仍是 no-store，不经过这里；前端 §12.3）。
 * 站内切换或返回时直接复用；超过 CLIENT_RECHECK_INTERVAL 由客户端用条件请求核对（ETag，内容没变回 304）。
 * 存储不可用（隐私模式、配额满、Node 测试环境）时一切照常请求，只是不复用。
 */
const PREFIX = "hoyo:public:v1:";
const INDEX = `${PREFIX}index`;

export interface StoredResponse {
  /** 服务端给的 ETag；没有时为 null（不做条件请求）。 */
  readonly etag: string | null;
  /** 响应 JSON 原样（读取时仍按 contracts schema 校验）；其中 cache 字段是最近一次核对的时间。 */
  readonly body: unknown;
  /** 最近一次与服务端核对（200 或 304）的本机时间。 */
  readonly checkedAt: number;
}

function storage(): Storage | null {
  try {
    // 只在浏览器页面里复用（Node 自带的 sessionStorage 是整个进程共用的，不属于任何标签页）。
    return typeof window === "undefined" || typeof sessionStorage === "undefined"
      ? null
      : sessionStorage;
  } catch {
    return null;
  }
}

function readIndex(store: Storage): string[] {
  try {
    const value: unknown = JSON.parse(store.getItem(INDEX) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function readStored(path: string): StoredResponse | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + path);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<StoredResponse>;
    if (typeof value.checkedAt !== "number" || !("body" in value)) return null;
    return {
      etag: typeof value.etag === "string" ? value.etag : null,
      body: value.body,
      checkedAt: value.checkedAt,
    };
  } catch {
    return null;
  }
}

/** 写入并记为最近使用；配额不够时从最久未用的副本开始删，直到写得下或删完。 */
export function writeStored(path: string, entry: StoredResponse): void {
  checkedThisPage.add(path);
  const store = storage();
  if (!store) return;
  const key = PREFIX + path;
  const value = JSON.stringify(entry);
  let index = readIndex(store).filter((item) => item !== path);
  for (;;) {
    try {
      store.setItem(key, value);
      store.setItem(INDEX, JSON.stringify([...index, path]));
      return;
    } catch {
      const oldest = index.shift();
      if (oldest === undefined) {
        try {
          store.removeItem(key);
        } catch {
          // 写不进去就不复用。
        }
        return;
      }
      try {
        store.removeItem(PREFIX + oldest);
      } catch {
        index = [];
      }
    }
  }
}

export function forgetStored(path: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + path);
    store.setItem(INDEX, JSON.stringify(readIndex(store).filter((item) => item !== path)));
  } catch {
    // 忽略：读取时校验失败也会当作没有副本。
  }
}

/**
 * 本次页面是不是用户按了刷新（浏览器刷新按钮、⌘R）。刷新时本页的首次读取一律向服务端核对，
 * 不直接用副本——这是"按需刷新"里用户主动要求的那一种。
 */
export const pageReloaded: boolean = (() => {
  try {
    // Navigation API 优先；不支持时看导航计时。
    const activation = (
      globalThis as { navigation?: { activation?: { navigationType?: string } | null } }
    ).navigation?.activation;
    if (activation?.navigationType) return activation.navigationType === "reload";
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "reload";
  } catch {
    return false;
  }
})();

/** 本页加载以来与服务端核对过（200 或 304）的路径：刷新进入的页面只认这些，不认刷新之前的核对。 */
export const checkedThisPage = new Set<string>();
