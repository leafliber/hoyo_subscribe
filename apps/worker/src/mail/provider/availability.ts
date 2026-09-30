// P4-03 · §2.3；缺省关闭。P5 负责受控恢复开关，失败不能自动重新开通。
import { ApiError } from "../../shell/errors";
export const MAIL_AVAILABILITY_KEY = "mail_sending_available";
export async function mailAvailable(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value_json FROM system_state WHERE key = ?")
    .bind(MAIL_AVAILABILITY_KEY)
    .first<{ value_json: string }>();
  return row !== null && JSON.parse(row.value_json) === true;
}
export async function pauseMail(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(`INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'false',?)
    ON CONFLICT(key) DO UPDATE SET value_json = 'false',updated_at = excluded.updated_at`)
    .bind(MAIL_AVAILABILITY_KEY, now)
    .run();
}
export async function requireMailAvailable(db: D1Database): Promise<void> {
  if (!(await mailAvailable(db)))
    throw new ApiError("temporarily_unavailable", { code: "temporarily_unavailable" });
}
