// 第 7 步效果的真实实现：创建挑战及发信任务（任务卡 P2-02；主方案 §4.3、§4.1、§9.1）。
//
// 注入位置：preauth/pipeline.ts 的效果接缝（CreateChallengeAndMailTask）。本函数承担：
// - 网络重试幂等：同一（预认证上下文, idempotency_key）只产生一个挑战与一个发送意图
//   （idx_auth_challenges_idem 部分唯一索引；并发重试的输家整批回滚后按已受理返回，
//   不创建第二个发送意图——「明确重发才创建新发送意图」，§4.3）。
// - 验证码均匀随机（P1-06 random.ts 拒绝采样）；验证表只存带独立 pepper 的 MAC
//   （六元组：用途、challenge_id、email_key、地址版本、generation=0、验证码）。
// - 验证码原值只进短期受控密文（otp-mail-payload；服务器发送阶段可解密——短期受控
//   密文，非「不可读取」）。
// - ★ 投递地址锁定（§4.1）：login 用途解密 users.email_ciphertext（已验证实际地址），
//   不按请求大小写改投；signup 用途取请求原文的投递形态（本地部分保留大小写）。
// - 发信预算：P1-07 reserveMailBudget 以 outbox 行为挂靠原子预占（decideMailIntent 的
//   SQL 化守卫）；预占失配（读侧判定与并发写入竞争输掉）时挑战终止、outbox 跳过并
//   即时清除验证码密文——不留下「永远不会发送的挑战」。

import { OUTBOX_UNRESERVED_PERIOD_KEY, poolOfMailIntent, utcDayPeriod } from "@hoyo/contracts";
import { macOtpVerification } from "../../storage/crypto/mac";
import { generateOtpCode } from "../../storage/crypto/random";
import { reserveMailBudget } from "../../storage/ledger/mail-ledger";
import type { CreateChallengeAndMailTask } from "../preauth/pipeline";
import { decryptDeliveryAddress, deliveryAddressForm } from "./delivery";
import { asEnvelopeBytes, encryptOtpPayload, OTP_PAYLOAD_KIND } from "./payload";
import { purposeOfAdmissionIntent } from "./purposes";

/**
 * mail_outbox.priority 的取值：认证邮件是最高优先级（§7.4）；数值阶梯的完整语义属
 * P4-03 调度卡，本卡沿用 P2-01 测试桩的 0（阶梯最高档），不另立业务参数。
 */
const AUTH_MAIL_PRIORITY = 0;

/** 首次生成：generation 固定 0；重发递增（§4.3）。 */
const INITIAL_GENERATION = 0;

/** 首次生成：错误尝试计数从 0 起（§4.3 OTP_ATTEMPTS 上限）。 */
const INITIAL_ATTEMPTS = 0;

/** 新地址挑战的地址版本起点（§4.1：消费时检查身份/地址版本；首次绑定从 0 起）。 */
const INITIAL_ADDRESS_VERSION = 0;

function isIdempotencyUniqueError(error: unknown): boolean {
  // 部分唯一索引 idx_auth_challenges_idem 命中即整批回滚；SQLite 报错文案对索引命中的
  // 列举格式随版本有差异，按「UNIQUE + 本表」识别（其余唯一键：主键 UUID 不可能撞）。
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    /auth_challenges/i.test(error.message)
  );
}

/**
 * 创建挑战及发信任务（第 7 步真实效果）。成功创建或幂等重放均正常返回；
 * 挑战终止（预算竞争失配）由落库状态承载，不向管线抛错——申请响应仍走折叠 202。
 */
export const createChallengeAndMailTask: CreateChallengeAndMailTask = async (ctx) => {
  // —— 网络重试幂等（§4.3）：同一 (preauth_id, idempotency_key) 已受理则不再创建 ——
  if (ctx.idempotencyKey !== null) {
    const existing = await ctx.db
      .prepare("SELECT id FROM auth_challenges WHERE preauth_id = ? AND idempotency_key = ?")
      .bind(ctx.preauthId, ctx.idempotencyKey)
      .first();
    if (existing !== null) {
      return;
    }
  }

  const purpose = purposeOfAdmissionIntent(ctx.intent);

  // —— 投递地址解析（§4.1）：login 锁定已验证地址；signup 绑定请求投递形态 ——
  let address: string;
  let addressVersion: number;
  let recipientUserId: string | null = null;
  if (purpose === "login") {
    const user = await ctx.db
      .prepare("SELECT id, email_ciphertext, email_version FROM users WHERE email_key = ?")
      .bind(ctx.emailKey)
      .first<{ id: string; email_ciphertext: Uint8Array; email_version: number }>();
    if (user === null) {
      // 准入第 5 步已确认存在；此处消失只可能是并发删除——失败关闭，不按请求地址改投。
      throw new Error("login 用途未找到已验证投递地址（并发状态变化，失败关闭）");
    }
    address = await decryptDeliveryAddress(
      ctx.keys.fieldEncryption(),
      user.id,
      asEnvelopeBytes(user.email_ciphertext),
    );
    addressVersion = user.email_version;
    recipientUserId = user.id;
  } else {
    address = deliveryAddressForm(ctx.rawEmail);
    addressVersion = INITIAL_ADDRESS_VERSION;
  }

  // —— 验证码与 MAC（§4.3：均匀随机 + 独立 pepper 六元组，generation=0） ——
  const challengeId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const code = generateOtpCode();
  const mac = await macOtpVerification(ctx.keys.otpMac(), {
    purpose,
    challengeId,
    emailKey: ctx.emailKey,
    addressVersion,
    generation: INITIAL_GENERATION,
    code,
  });
  const payload = await encryptOtpPayload(ctx.keys.fieldEncryption(), outboxId, {
    challengeId,
    generation: INITIAL_GENERATION,
    code,
    address,
  });

  // —— 挑战与发信任务同批落库（D1 batch 事务：任一 SQL 失败整批回滚） ——
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO auth_challenges
             (id, purpose, email_key, address_version, preauth_id, idempotency_key, mac,
              generation, attempts, deadline, reservation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          challengeId,
          purpose,
          ctx.emailKey,
          addressVersion,
          ctx.preauthId,
          ctx.idempotencyKey,
          mac,
          INITIAL_GENERATION,
          INITIAL_ATTEMPTS,
          ctx.challengeDeadline,
          ctx.reservationId,
          ctx.now,
          ctx.now,
        ),
      ctx.db
        .prepare(
          `INSERT INTO mail_outbox
             (id, purpose, priority, period_key, recipient_user_id, address_version,
              payload_kind, payload_ref, payload_ciphertext, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          outboxId,
          poolOfMailIntent(ctx.intent),
          AUTH_MAIL_PRIORITY,
          OUTBOX_UNRESERVED_PERIOD_KEY,
          recipientUserId,
          addressVersion,
          OTP_PAYLOAD_KIND,
          challengeId,
          payload,
          ctx.now,
          ctx.now,
        ),
    ]);
  } catch (error) {
    if (isIdempotencyUniqueError(error)) {
      // 并发网络重试的输家：赢家已创建挑战与发送意图，此处按已受理返回（§4.3）。
      return;
    }
    throw error;
  }

  // —— 发信预算预占（P1-07 账本；守卫谓词即 decideMailIntent 的 SQL 化） ——
  const reservation = await reserveMailBudget(ctx.db, {
    intent: ctx.intent,
    period: utcDayPeriod(ctx.now),
    now: ctx.now,
    outboxId,
  });
  if (reservation.outcome === "condition_missed") {
    // 读侧判定被并发写入竞争掉：终止挑战、跳过任务并即时清除验证码密文（§4.3 清除条款）。
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE mail_outbox SET status = 'skipped', payload_ciphertext = NULL, payload_ref = NULL,
             updated_at = ? WHERE id = ? AND status = 'pending' AND period_key = ?`,
        )
        .bind(ctx.now, outboxId, OUTBOX_UNRESERVED_PERIOD_KEY),
      ctx.db
        .prepare(
          "UPDATE auth_challenges SET aborted_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL",
        )
        .bind(ctx.now, ctx.now, challengeId),
    ]);
  }
};
