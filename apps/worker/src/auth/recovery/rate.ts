// P2-05 · recovery_id 精确 D1 双窗口 + 来源近似进程内双窗口（§4.6、§8.3）。
// 来源原文只在一次请求的局部变量存在；内存 Map 存加盐摘要，D1 只存 ID 摘要。
import {
  RATE_WINDOWS_MAX,
  RECOVERY_ATTEMPTS_DAY,
  RECOVERY_ATTEMPTS_HOUR,
  utcDayPeriod,
} from "@hoyo/contracts";
import { conditionalCommit } from "../../storage/cas";
import { toHex, utf8Encode } from "../../storage/crypto/bytes";
import { generateSecretToken } from "../../storage/crypto/random";

const HOUR_MS = 60 * 60 * 1_000;

async function sha256(value: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

export interface RecoverySourceGate {
  charge(request: Request, now: number): Promise<boolean>;
}

interface SourceWindow {
  hour: number;
  hourCount: number;
  day: number;
  dayCount: number;
}

export class InMemoryRecoverySourceGate implements RecoverySourceGate {
  readonly #salt = generateSecretToken().bytes;
  readonly #windows = new Map<string, SourceWindow>();

  async charge(request: Request, now: number): Promise<boolean> {
    const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const bytes = utf8Encode(source);
    const input = new Uint8Array(this.#salt.length + bytes.length);
    input.set(this.#salt);
    input.set(bytes, this.#salt.length);
    const key = await sha256(input);
    const hour = Math.floor(now / HOUR_MS);
    const day = utcDayPeriod(now).startMs;
    const previous = this.#windows.get(key);
    const current: SourceWindow =
      previous === undefined
        ? { hour, hourCount: 0, day, dayCount: 0 }
        : {
            hour,
            hourCount: previous.hour === hour ? previous.hourCount : 0,
            day,
            dayCount: previous.day === day ? previous.dayCount : 0,
          };
    if (current.hourCount >= RECOVERY_ATTEMPTS_HOUR || current.dayCount >= RECOVERY_ATTEMPTS_DAY)
      return false;
    if (previous === undefined && this.#windows.size >= RATE_WINDOWS_MAX) {
      for (const [candidate, window] of this.#windows) {
        if (window.day !== day) this.#windows.delete(candidate);
      }
      if (this.#windows.size >= RATE_WINDOWS_MAX) return false;
    }
    this.#windows.set(key, {
      ...current,
      hourCount: current.hourCount + 1,
      dayCount: current.dayCount + 1,
    });
    return true;
  }
}

/** 未知 recovery_id 同样入账；超过任一窗口均返回同一稍后重试。 */
export async function chargeRecoveryId(
  db: D1Database,
  recoveryId: string,
  now: number,
): Promise<boolean> {
  const subject = await sha256(utf8Encode(`recovery-id:v1:${recoveryId}`));
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = utcDayPeriod(now);
  await db.prepare("DELETE FROM recovery_attempt_windows WHERE expires_at <= ?").bind(now).run();
  const outcome = await conditionalCommit(db, {
    preamble: [
      {
        sql: `INSERT INTO recovery_attempt_windows
          (subject_hash, period_kind, period_start, attempts, expires_at, updated_at)
          VALUES (?, 'hour', ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
        params: [subject, hourStart, hourStart + HOUR_MS, now],
      },
      {
        sql: `INSERT INTO recovery_attempt_windows
          (subject_hash, period_kind, period_start, attempts, expires_at, updated_at)
          VALUES (?, 'day', ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
        params: [subject, day.startMs, day.endMsExclusive, now],
      },
    ],
    guard: {
      sql: `UPDATE recovery_attempt_windows SET attempts = attempts + 1, updated_at = ?
        WHERE subject_hash = ? AND period_kind = 'hour' AND period_start = ? AND attempts < ?
          AND (SELECT attempts FROM recovery_attempt_windows
            WHERE subject_hash = ? AND period_kind = 'day' AND period_start = ?) < ?`,
      params: [
        now,
        subject,
        hourStart,
        RECOVERY_ATTEMPTS_HOUR,
        subject,
        day.startMs,
        RECOVERY_ATTEMPTS_DAY,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "recovery_attempt_windows",
        set: { attempts: { sql: "attempts + 1" }, updated_at: now },
        where: {
          sql: "subject_hash = ? AND period_kind = 'day' AND period_start = ?",
          params: [subject, day.startMs],
        },
      },
    ],
  });
  return outcome.outcome === "committed";
}
