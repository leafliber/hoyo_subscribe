// P4-04 · 预算与公平批准共用一个条件提交；不改 P4-02 的计划生成器。
import { planMailReservation, utcDayPeriod } from "@hoyo/contracts";
import { type ConditionalCommitPlan, conditionalCommit } from "../../storage/cas";
import {
  insertUsageRowStatement,
  mailBudgetCapacityPredicate,
  reserveMailBudgetEffects,
} from "../../storage/ledger/mail-ledger";
import { planDispatchAttempt } from "../dispatch/dispatch";
import type { DispatchProposal } from "../dispatch/types";

export async function planBudgetedDispatch(
  db: D1Database,
  proposal: DispatchProposal,
  now: number,
): Promise<{ outboxId: string; plan: ConditionalCommitPlan } | null> {
  const dispatch = await planDispatchAttempt(db, proposal, now);
  if (!dispatch) return null;
  const period = utcDayPeriod(now);
  const reservation = planMailReservation(proposal.intent);
  const capacity = mailBudgetCapacityPredicate(reservation, period.key, proposal.userId);
  const effects = [...(dispatch.plan.effects ?? [])];
  const deliveries = effects.pop();
  if (!deliveries) throw new Error("missing_dispatch_effect");
  return {
    outboxId: dispatch.outboxId,
    plan: {
      preamble: [
        ...(dispatch.plan.preamble ?? []),
        insertUsageRowStatement(reservation.pool, period, now),
        insertUsageRowStatement(reservation.pool, period, now, proposal.userId),
      ],
      guard: {
        sql: `${dispatch.plan.guard.sql} AND (${capacity.sql})`,
        params: [...(dispatch.plan.guard.params ?? []), ...capacity.params],
      },
      effects: [
        ...effects,
        ...reserveMailBudgetEffects({
          pool: reservation.pool,
          periodKey: period.key,
          userId: proposal.userId,
          now,
        }),
        {
          kind: "update",
          table: "mail_outbox",
          set: { period_key: period.key },
          where: { sql: "id = ?", params: [dispatch.outboxId] },
        },
        deliveries,
      ],
    },
  };
}
export async function approveBudgetedDispatch(
  db: D1Database,
  proposal: DispatchProposal,
  now: number,
) {
  const planned = await planBudgetedDispatch(db, proposal, now);
  if (!planned) return { outcome: "stale" as const };
  const result = await conditionalCommit(db, planned.plan);
  return { ...result, outboxId: result.outcome === "committed" ? planned.outboxId : null };
}
