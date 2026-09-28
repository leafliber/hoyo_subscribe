// P2-05：挑战用途由 Worker 与恢复入口共同使用，故在 contracts 唯一定义。
/** §4.3 MAC 绑定的挑战用途。 */
export const CHALLENGE_PURPOSES = ["login", "signup", "email_change", "recovery"] as const;

export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/** 拒绝未登记的数据库用途进入 MAC 校验。 */
export function isChallengePurpose(value: string): value is ChallengePurpose {
  return (CHALLENGE_PURPOSES as readonly string[]).includes(value);
}
