// A-P3-DRAFT · AI 草稿编排与日账本（本地 D1 + 固定响应替身；零真实推理请求）。
import "../../admin/test-support";
import { env } from "cloudflare:test";
import {
  AI_DRAFT_PROFILE,
  AI_DRAFT_RESERVATION,
  AI_SOFT_DAY,
  MODEL_NETWORK_RETRIES,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { describe, expect, it } from "vitest";
import genshinContent from "../../../../../fixtures/sources/genshin-ann/content-21928.json";
import hsrContent from "../../../../../fixtures/sources/hsr-ann/content-1392.json";
import { type DraftJobInput, runDraftJob } from "./draft";
import { readUsageDay, reserveNeurons, settleNeurons } from "./ledger";
import { DRAFT_PROFILE_REF, readDraft } from "./store";
import {
  DRAFT_T0,
  type FixtureBody,
  fakeAi,
  fixtureEntry,
  GACHA_21876_OUTPUT,
  modelResponse,
  seedRuleCandidate,
} from "./test-support";

const genshin = genshinContent as unknown as FixtureBody;
const gachaEntry = fixtureEntry(genshin, 21876);
// 每个用例用不同的 UTC 日，账本互不干扰。
let day = 0;
const nextDay = () => DRAFT_T0 + ++day * 86_400_000;

async function candidateRow(id: string) {
  return env.DB.prepare(
    "SELECT run_id, review_status, proposal_json, updated_at FROM candidates WHERE id = ?",
  )
    .bind(id)
    .first<{
      run_id: string | null;
      review_status: string;
      proposal_json: string;
      updated_at: number;
    }>();
}
function job(
  overrides: Partial<DraftJobInput> & { candidateId: string; nowMs: number },
): DraftJobInput {
  const { nowMs, ...rest } = overrides;
  return {
    db: env.DB,
    ai: fakeAi(modelResponse(GACHA_21876_OUTPUT)),
    modelEnabled: true,
    deadline: nowMs + 120_000,
    now: () => nowMs,
    ...rest,
  };
}

describe("A-P3-DRAFT 日账本", () => {
  it("先预占后结算：超过上限的预占被拒，结算按实际值向上取整并释放预占", async () => {
    const now = nextDay();
    const first = await reserveNeurons(env.DB, now, 60, 100);
    expect(first).toEqual({ day: utcDayPeriod(now).key, amount: 60 });
    if (first === null) throw new Error("预占应当成立");
    expect(await reserveNeurons(env.DB, now, 50, 100)).toBeNull();
    await settleNeurons(env.DB, first, 12.37, now);
    expect(await readUsageDay(env.DB, now)).toMatchObject({ reserved: 0, settled: 13, calls: 1 });
    expect(await reserveNeurons(env.DB, now, 50, 100)).not.toBeNull();
    await expect(reserveNeurons(env.DB, now, 0, 100)).rejects.toThrow("invalid_ai_reservation");
  });

  it("并发预占不会越过上限（条件判断与累加在同一条 UPDATE）", async () => {
    const now = nextDay();
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        reserveNeurons(env.DB, now, AI_DRAFT_RESERVATION, AI_SOFT_DAY),
      ),
    );
    const granted = results.filter((r) => r !== null).length;
    expect(granted).toBe(Math.floor(AI_SOFT_DAY / AI_DRAFT_RESERVATION));
    const usage = await readUsageDay(env.DB, now);
    expect(usage.reserved).toBe(granted * AI_DRAFT_RESERVATION);
    expect(usage.reserved).toBeLessThanOrEqual(AI_SOFT_DAY);
  });
});

describe("A-P3-DRAFT 起草编排", () => {
  it("规则入队的 uncertain 候选生成可用草稿；按平台回报结算，候选本身原封不动", async () => {
    const now = nextDay();
    const { candidateId, versionId } = await seedRuleCandidate("genshin-ann", gachaEntry, {
      nowMs: now,
    });
    const before = await candidateRow(candidateId);
    expect(before).toMatchObject({ review_status: "pending" });
    expect(JSON.parse(before?.proposal_json ?? "{}").classification).toBe("uncertain");
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    expect(await runDraftJob(job({ candidateId, nowMs: now, ai }))).toEqual({
      kind: "done",
      reason: null,
    });
    expect(ai.calls).toHaveLength(1);
    const call = ai.calls[0];
    expect(call.model).toBe(AI_DRAFT_PROFILE.model);
    expect(call.signal).toBe(true);
    expect(call.inputs).toMatchObject({
      max_tokens: AI_DRAFT_PROFILE.maxOutputTokens,
      temperature: AI_DRAFT_PROFILE.temperature,
    });
    const messages = call.inputs.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1].content).toContain("/no_think");
    const draft = await readDraft(env.DB, candidateId);
    expect(draft).toMatchObject({
      status: "ready",
      attempts: 1,
      articleVersionId: versionId,
      profileRef: DRAFT_PROFILE_REF,
      usage: { prompt_tokens: 1219, completion_tokens: 221, neurons: 13, finish_reason: "stop" },
    });
    expect(draft?.proposal?.events[0].event_type).toBe("gacha");
    expect(await readUsageDay(env.DB, now)).toMatchObject({ reserved: 0, settled: 13, calls: 1 });
    expect(await candidateRow(candidateId)).toEqual(before);
    // 已有确定结果的候选不再调用模型。
    expect(await runDraftJob(job({ candidateId, nowMs: now + 1, ai }))).toEqual({
      kind: "done",
      reason: "already_drafted",
    });
    expect(ai.calls).toHaveLength(1);
  });

  it("开关关闭、未配置绑定、不符合资格时都不调用模型、不写草稿", async () => {
    const now = nextDay();
    const { candidateId } = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    expect(await runDraftJob(job({ candidateId, nowMs: now, ai, modelEnabled: false }))).toEqual({
      kind: "done",
      reason: "model_disabled",
    });
    expect(await runDraftJob(job({ candidateId, nowMs: now, ai: undefined }))).toEqual({
      kind: "done",
      reason: "ai_binding_missing",
    });
    // 规则命中的星铁活动公告已自动批准，不是 uncertain 待审候选。
    const hsr = await seedRuleCandidate(
      "hsr-ann",
      fixtureEntry(hsrContent as unknown as FixtureBody, 1392),
      {
        nowMs: now,
      },
    );
    expect((await candidateRow(hsr.candidateId))?.review_status).toBe("approved");
    expect(await runDraftJob(job({ candidateId: hsr.candidateId, nowMs: now, ai }))).toEqual({
      kind: "done",
      reason: "not_eligible",
    });
    expect(ai.calls).toHaveLength(0);
    expect(await readDraft(env.DB, candidateId)).toBeNull();
    expect((await readUsageDay(env.DB, now)).calls).toBe(0);
  });

  it("正文不完整或超过输入上限时记为跳过，不预占、不调用", async () => {
    const now = nextDay();
    const incomplete = await seedRuleCandidate("genshin-ann", gachaEntry, {
      nowMs: now,
      completeness: "gap-body-truncated",
    });
    const huge = await seedRuleCandidate("genshin-ann", gachaEntry, {
      nowMs: now,
      html: `<p>${"超长正文".repeat(AI_DRAFT_PROFILE.maxInputBytes)}</p>`,
    });
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    expect(await runDraftJob(job({ candidateId: incomplete.candidateId, nowMs: now, ai }))).toEqual(
      {
        kind: "done",
        reason: "article_incomplete",
      },
    );
    expect(await runDraftJob(job({ candidateId: huge.candidateId, nowMs: now, ai }))).toEqual({
      kind: "done",
      reason: "input_too_large",
    });
    expect(ai.calls).toHaveLength(0);
    expect(await readDraft(env.DB, huge.candidateId)).toMatchObject({
      status: "skipped",
      attempts: 0,
      reasonCode: "input_too_large",
    });
    expect((await readUsageDay(env.DB, now)).calls).toBe(0);
  });

  it("触到草稿日上限（软线）就停到下一个 UTC 日，不调用模型", async () => {
    const now = nextDay();
    const { candidateId } = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const filler = await reserveNeurons(
      env.DB,
      now,
      AI_SOFT_DAY - AI_DRAFT_RESERVATION + 1,
      AI_SOFT_DAY,
    );
    expect(filler).not.toBeNull();
    const ai = fakeAi(modelResponse(GACHA_21876_OUTPUT));
    expect(await runDraftJob(job({ candidateId, nowMs: now, ai }))).toEqual({
      kind: "later",
      reason: "ai_budget_exhausted",
      dueAt: utcDayPeriod(now).endMsExclusive,
    });
    expect(ai.calls).toHaveLength(0);
  });

  it("调用失败按整笔预占结算并有限次重试；用尽后停止", async () => {
    const now = nextDay();
    const { candidateId } = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const ai = fakeAi(new Error("network"));
    for (let attempt = 1; attempt <= MODEL_NETWORK_RETRIES + 1; attempt++) {
      const at = now + attempt;
      const outcome = await runDraftJob(job({ candidateId, nowMs: at, ai }));
      if (attempt <= MODEL_NETWORK_RETRIES)
        expect(outcome).toEqual({
          kind: "later",
          reason: "model_call_failed",
          dueAt: at + WATCHDOG_INTERVAL * 1000,
        });
      else expect(outcome).toEqual({ kind: "done", reason: "retries_exhausted" });
    }
    expect(ai.calls).toHaveLength(MODEL_NETWORK_RETRIES + 1);
    expect(await readDraft(env.DB, candidateId)).toMatchObject({
      status: "failed",
      attempts: MODEL_NETWORK_RETRIES + 1,
      reasonCode: "model_call_failed",
    });
    expect(await readUsageDay(env.DB, now)).toMatchObject({
      reserved: 0,
      settled: (MODEL_NETWORK_RETRIES + 1) * AI_DRAFT_RESERVATION,
    });
    expect(await runDraftJob(job({ candidateId, nowMs: now + 9, ai }))).toEqual({
      kind: "done",
      reason: "retries_exhausted",
    });
    expect(ai.calls).toHaveLength(MODEL_NETWORK_RETRIES + 1);
  });

  it("无法解析的输出记为 invalid；缺 neurons 时按 token 计，什么都没有时按整笔预占", async () => {
    const now = nextDay();
    const garbled = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const tokens = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    const bare = await seedRuleCandidate("genshin-ann", gachaEntry, { nowMs: now });
    await runDraftJob(
      job({
        candidateId: garbled.candidateId,
        nowMs: now,
        ai: fakeAi(modelResponse("抱歉", undefined, "length")),
      }),
    );
    expect(await readDraft(env.DB, garbled.candidateId)).toMatchObject({
      status: "invalid",
      reasonCode: "unparseable",
      notes: ["模型输出被 max_tokens 截断，无法解析为 JSON，请人工处理。"],
    });
    await runDraftJob(
      job({
        candidateId: tokens.candidateId,
        nowMs: now,
        ai: fakeAi(
          modelResponse(GACHA_21876_OUTPUT, { prompt_tokens: 2000, completion_tokens: 1000 }),
        ),
      }),
    );
    expect((await readDraft(env.DB, tokens.candidateId))?.usage?.neurons).toBe(
      Math.ceil(
        (2000 * AI_DRAFT_PROFILE.inputNeuronsPerMillion +
          1000 * AI_DRAFT_PROFILE.outputNeuronsPerMillion) /
          1e6,
      ),
    );
    await runDraftJob(
      job({
        candidateId: bare.candidateId,
        nowMs: now,
        ai: fakeAi(modelResponse(GACHA_21876_OUTPUT, null)),
      }),
    );
    expect((await readDraft(env.DB, bare.candidateId))?.usage?.neurons).toBe(AI_DRAFT_RESERVATION);
    expect((await readUsageDay(env.DB, now)).reserved).toBe(0);
  });
});
