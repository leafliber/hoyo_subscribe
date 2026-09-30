import { EXECUTOR_BATCH_WALL_LIMIT, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { classifyPipelineFailure } from "../../executors/pipeline/failure";
import { logEvent } from "../../shell/logger";
import type { MailProvider, MailResult } from "../provider/types";
import { type MailContentDeps, prepareMail } from "./prepare";
import { claimMail, transitionMail } from "./state";
import { MailDataError } from "./types";
export interface SendDeps extends MailContentDeps {
  db: D1Database;
  provider: MailProvider;
  available: () => Promise<boolean>;
  pause: () => Promise<void>;
  now?: () => number;
  batchDeadline?: number;
}
export async function sendOneMail(deps: SendDeps, owner: string, id?: string): Promise<boolean> {
  const now = deps.now ?? Date.now;
  if (!(await deps.available())) return false;
  const start = now();
  const deadline = Math.min(
    deps.batchDeadline ?? Infinity,
    start + EXECUTOR_BATCH_WALL_LIMIT * 1000,
  );
  const row = await claimMail(deps.db, owner, start, id);
  if (!row) return false;
  let calling = false;
  try {
    const prepared = await prepareMail(deps.db, row, now(), deps);
    if ("invalid" in prepared) {
      await transitionMail(deps.db, row, now(), {
        status: prepared.invalid,
        reason: `preflight_${prepared.invalid}`,
        budget: { from: "reserved", to: null },
      });
      return true;
    }
    if (!(await deps.available()) || now() >= deadline) {
      await transitionMail(deps.db, row, now(), {
        status: "retry_wait",
        reason: "paused_or_wall_limit",
      });
      return true;
    }
    if (now() >= prepared.expiresAt) {
      await transitionMail(deps.db, row, now(), {
        status: "expired",
        reason: "preflight_expired",
        budget: { from: "reserved", to: null },
      });
      return true;
    }
    calling = await transitionMail(deps.db, row, now(), {
      status: "calling_provider",
      budget: { from: "reserved", to: "uncertain" },
      extraGuard: prepared.guard,
    });
    if (!calling) {
      await transitionMail(deps.db, row, now(), {
        status: "retry_wait",
        reason: "preflight_changed",
      });
      return true;
    }
    // 超时只停止等待，不能证明平台没接受；剩余 promise 不再写库或再次调用。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<MailResult>([
      deps.provider
        .send(prepared.mail)
        .catch(() => ({ kind: "unknown", reason: "provider_threw", pause: false }) as const),
      new Promise<MailResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "unknown", reason: "provider_timeout", pause: false }),
          Math.max(0, deadline - now()),
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    const called = { ...row, status: "calling_provider" as const };
    if (result.kind === "accepted") {
      await transitionMail(deps.db, called, now(), {
        status: "accepted",
        messageId: result.messageId,
        budget: { from: "uncertain", to: "settled" },
      });
    } else {
      // 原生适配器只给固定原因码；替身/后续实现同样不得把异常原文塞进 reason。
      const reason =
        result.kind === "unknown"
          ? "provider_unknown"
          : result.retryable
            ? "provider_retryable_rejection"
            : "provider_rejected";
      await transitionMail(deps.db, called, now(), {
        status:
          result.kind === "unknown" ? "unknown" : result.retryable ? "retry_wait" : "rejected",
        reason,
        ...(result.kind === "rejected"
          ? { budget: { from: "uncertain" as const, to: "settled" as const } }
          : {}),
      });
      if (result.kind === "rejected" && result.pause) await deps.pause();
      logEvent("error", "mail_provider_failed", { reason_code: reason, count: row.attempts + 1 });
    }
  } catch (error) {
    if (calling) {
      // 已越过外调边界，写回失败也不能释放预算或回到 pending。
      logEvent("error", "mail_result_persistence_failed", {
        reason_code: "await_watchdog",
        count: row.attempts + 1,
      });
      // 已领取的单封邮件独立终止；只有连这个条件写回也失败才上抛为执行器故障。
      await transitionMail(deps.db, { ...row, status: "calling_provider" }, now(), {
        status: "unknown",
        reason: "result_persistence_unknown",
      });
      return true;
    }
    const failure =
      error instanceof MailDataError ||
      (error instanceof Error && error.name === "FieldCryptoError")
        ? { terminal: true, reason: "invalid_data" }
        : classifyPipelineFailure(error);
    await transitionMail(deps.db, row, now(), {
      status: failure.terminal ? "failed" : "retry_wait",
      reason: failure.reason,
      ...(failure.terminal ? { budget: { from: "reserved" as const, to: null } } : {}),
    });
    logEvent("error", "mail_preflight_failed", {
      reason_code: failure.reason,
      count: row.attempts + 1,
    });
  }
  return true;
}
// HTTP 快速路径与后台完全共享领取/复核/外调逻辑，不存在第二套发送入口。
export const tryAuthMailFastPath = (deps: SendDeps, id: string) =>
  sendOneMail(deps, "HTTP/auth", id);
export const retryAt = (now: number) => now + WATCHDOG_INTERVAL * 1000;
