import { localDraft } from "../../features/subscription/draft/preferences";
import type { Draft } from "../../features/subscription/save/machine";

export type DraftIdentity =
  | { status: "unknown" }
  | { status: "guest" }
  | { status: "confirmed"; userId: string };
export type StoredDraft = { config: Draft; savedAt: number };

function owner(identity: DraftIdentity): string | null {
  if (identity.status === "unknown") return null;
  return identity.status === "guest" ? "guest" : `user:${identity.userId}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("hoyo-local-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("draft_storage_unavailable"));
    request.onblocked = () => reject(new Error("draft_storage_unavailable"));
  });
}

/** 账号空间不是加密；只保存规范白名单草稿，不保存私人 API 响应或会话。 */
export class DraftStorage {
  private queue: Promise<unknown> = Promise.resolve();

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  read(identity: DraftIdentity): Promise<StoredDraft | null> {
    const key = owner(identity);
    if (key === null) return Promise.resolve(null);
    return this.run(async () => {
      const db = await open();
      try {
        return await new Promise<StoredDraft | null>((resolve, reject) => {
          const request = db.transaction("drafts").objectStore("drafts").get(key);
          request.onsuccess = () => {
            try {
              const row = request.result;
              if (!row) return resolve(null);
              if (!Number.isSafeInteger(row.savedAt) || row.savedAt < 0) throw new Error();
              resolve({ config: localDraft(row.config), savedAt: row.savedAt });
            } catch {
              reject(new Error("invalid_local_draft"));
            }
          };
          request.onerror = () => reject(new Error("draft_storage_unavailable"));
        });
      } finally {
        db.close();
      }
    });
  }

  write(identity: DraftIdentity, config: Draft | null): Promise<void> {
    const key = owner(identity);
    if (key === null) return Promise.resolve();
    // 在排队前捕获身份与完整快照，旧写入不能被后来账号或草稿改写。
    const row = config === null ? null : { config: localDraft(config), savedAt: Date.now() };
    return this.run(async () => {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("drafts", "readwrite");
          const store = transaction.objectStore("drafts");
          if (row === null) store.delete(key);
          else store.put(row, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () =>
            reject(new Error("draft_storage_unavailable"));
        });
      } finally {
        db.close();
      }
    });
  }
}
