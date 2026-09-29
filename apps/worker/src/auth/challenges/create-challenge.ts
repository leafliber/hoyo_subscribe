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
// - P2-03 裁定授权注入：同一实际投递串另以 auth_challenges.id 为 AAD 独立加密落库，
//   供发送载荷清除后的消费与重发读取；预算拒绝终止挑战时一并清除。
// - 发信预算：P1-07 reserveMailBudget 以 outbox 行为挂靠原子预占（decideMailIntent 的
//   SQL 化守卫）；预占失配（读侧判定与并发写入竞争输掉）时挑战终止、outbox 跳过并
//   即时清除验证码密文——不留下「永远不会发送的挑战」。

import { OUTBOX_UNRESERVED_PERIOD_KEY, poolOfMailIntent, utcDayPeriod } from "@hoyo/contracts";
import { ACCOUNTS_TOTAL_CAPACITY_KEY } from "../../accounts/admission/registration";
import { ApiError } from "../../shell";
import { encryptField } from "../../storage/crypto/aead";
import { macOtpVerification } from "../../storage/crypto/mac";
import { generateOtpCode } from "../../storage/crypto/random";
import { reserveMailBudget } from "../../storage/ledger/mail-ledger";
import type { ChallengeAndMailTaskContext, CreateChallengeAndMailTask } from "../preauth/pipeline";
import { authQuotaGuard, decideAuthQuota, readAuthQuotaSnapshot } from "../preauth/quota";
import {
  DELIVERY_ADDRESS_RECORD_TYPE,
  decryptDeliveryAddress,
  deliveryAddressForm,
} from "./delivery";
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
/** HTTP 准入效果：共享读侧口径的守卫必须与挑战、意图一起原子提交。 */
export const createAdmittedChallengeAndMailTask: CreateChallengeAndMailTask = (ctx) =>
  createChallenge(ctx, authQuotaGuard(ctx.emailKey, ctx.now));

/** 仅供测试：底层构造原语（既有消费测试的夹具接缝，不挂路由）；HTTP 只使用上面的准入效果。 */
export const createChallengeAndMailTask: CreateChallengeAndMailTask = (ctx) =>
  createChallenge(ctx, { sql: "1", params: [] });

async function createChallenge(
  ctx: ChallengeAndMailTaskContext,
  quota: ReturnType<typeof authQuotaGuard>,
): Promise<void> {
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

  const eligible = ctx.sendEligible !== false;
  const purpose = eligible ? purposeOfAdmissionIntent(ctx.intent) : "equalization";
  // 每条路径执行同形状的身份读取；占位挑战不保存地址、可校验 MAC 或发信载荷。
  const user = await ctx.db
    .prepare("SELECT id, email_ciphertext, email_version FROM users WHERE email_key = ?")
    .bind(ctx.emailKey)
    .first<{ id: string; email_ciphertext: Uint8Array; email_version: number }>();
  let address = deliveryAddressForm(ctx.rawEmail);
  let addressVersion = INITIAL_ADDRESS_VERSION;
  let recipientUserId: string | null = null;
  if (purpose === "login") {
    if (user === null) throw new Error("login 用途未找到已验证投递地址（失败关闭）");
    address = await decryptDeliveryAddress(
      ctx.keys.fieldEncryption(),
      user.id,
      asEnvelopeBytes(user.email_ciphertext),
    );
    addressVersion = user.email_version;
    recipientUserId = user.id;
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
  const deliveryAddressCiphertext = await encryptField(
    ctx.keys.fieldEncryption(),
    { type: DELIVERY_ADDRESS_RECORD_TYPE, id: challengeId },
    address,
  );

  // —— 挑战与发信任务同批落库（D1 batch 事务：任一 SQL 失败整批回滚） ——
  try {
    const results = await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE capacity_state SET updated_at = ? WHERE key = ? AND ${quota.sql}`)
        .bind(ctx.now, ACCOUNTS_TOTAL_CAPACITY_KEY, ...quota.params),
      ctx.db
        .prepare(
          `INSERT INTO auth_challenges
             (id, purpose, email_key, address_version, preauth_id, idempotency_key, mac,
              generation, attempts, deadline, reservation_id, delivery_address_ciphertext,
              created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          challengeId,
          purpose,
          ctx.emailKey,
          addressVersion,
          ctx.preauthId,
          ctx.idempotencyKey,
          eligible ? mac : "never-authorize",
          INITIAL_GENERATION,
          INITIAL_ATTEMPTS,
          ctx.challengeDeadline,
          ctx.reservationId,
          eligible ? deliveryAddressCiphertext : null,
          ctx.now,
          ctx.now,
        ),
      ctx.db
        .prepare(
          `INSERT INTO mail_outbox
             (id, purpose, priority, period_key, recipient_user_id, address_version,
              payload_kind, payload_ref, payload_ciphertext, status, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE changes() = 1 AND ?`,
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
          eligible ? 1 : 0,
        ),
      // 同邮箱的新挑战共享预占，预占必须覆盖最新挑战截止；只随成功插入一起提交。
      ctx.db
        .prepare(`UPDATE admission_reservations SET expires_at = max(expires_at, ?), updated_at = ?
        WHERE id = ? AND state = 'reserved' AND EXISTS (SELECT 1 FROM auth_challenges WHERE id = ?)`)
        .bind(ctx.challengeDeadline, ctx.now, ctx.reservationId, challengeId),
    ]);
    if (results[1]?.meta.changes !== 1) {
      const decision = decideAuthQuota(
        await readAuthQuotaSnapshot(ctx.db, ctx.emailKey, ctx.now),
        ctx.now,
      );
      if (!decision.ok && decision.rejection.reason === "challenges_max") return;
      throw new ApiError("rate_limited", {
        code: "rate_limited",
        ...(!decision.ok && decision.rejection.reason === "cooldown"
          ? { retry_after_ms: decision.rejection.retryAfterMs }
          : {}),
      });
    }
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
  // 读侧判定被并发写入竞争掉：终止挑战、跳过任务并即时清除验证码密文（§4.3 清除条款）。
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE mail_outbox SET status = 'skipped', payload_ciphertext = NULL, payload_ref = NULL,
             updated_at = ? WHERE id = ? AND status = 'pending' AND period_key = ? AND ?`,
      )
      .bind(
        ctx.now,
        outboxId,
        OUTBOX_UNRESERVED_PERIOD_KEY,
        eligible && reservation.outcome === "condition_missed" ? 1 : 0,
      ),
    ctx.db
      .prepare(
        "UPDATE auth_challenges SET aborted_at = ?, delivery_address_ciphertext = NULL, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND aborted_at IS NULL AND ?",
      )
      .bind(
        ctx.now,
        ctx.now,
        challengeId,
        eligible && reservation.outcome === "condition_missed" ? 1 : 0,
      ),
  ]);
}
