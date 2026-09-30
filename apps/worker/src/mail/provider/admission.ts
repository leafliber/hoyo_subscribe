// P4-03 最小认证接线：在任何验证码生成前检查，成功提交后只安排后台唤醒。
import { ApiError } from "../../shell/errors";
import { environmentMailAvailable, wakeDelivery } from "./environment";
export interface MailAdmissionHook {
  check(env: Env): Promise<void>;
  committed(env: Env): Promise<void>;
}
export const mailAdmissionHook: MailAdmissionHook = {
  async check(env) {
    if (!(await environmentMailAvailable(env)))
      throw new ApiError("temporarily_unavailable", { code: "temporarily_unavailable" });
  },
  committed: wakeDelivery,
};
export async function withMailAdmission<T>(
  env: Env,
  hook: MailAdmissionHook | undefined,
  work: () => Promise<T>,
): Promise<T> {
  await hook?.check(env);
  const result = await work();
  // 唤醒失败不能把已经受理的挑战伪装成失败；D1 待办由 Cron 修复。
  try {
    await hook?.committed(env);
  } catch {
    /* 持久 outbox 保留 */
  }
  return result;
}
