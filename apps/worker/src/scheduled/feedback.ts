import { EXECUTOR_BATCH_WALL_LIMIT, FEEDBACK_MAINTENANCE_ROUNDS } from "@hoyo/contracts";
import {
  type FeedbackKeys,
  pruneFeedbackPage,
  reconcileFeedbackPage,
} from "../mail/feedback/store";
import { observeFeedbackGrowth } from "../shell/observability/feedback";
import { recordMetric } from "../shell/observability/metrics";
export async function maintainFeedback(
  db: D1Database,
  keys: () => Promise<FeedbackKeys>,
  clock: () => number = Date.now,
  steps = { prune: pruneFeedbackPage, reconcile: reconcileFeedbackPage },
): Promise<void> {
  const now = clock();
  const deadline = now + EXECUTOR_BATCH_WALL_LIMIT * 1000;
  let prune = true,
    reconcile = true;
  for (
    let round = 0;
    round < FEEDBACK_MAINTENANCE_ROUNDS && clock() < deadline && (prune || reconcile);
    round++
  ) {
    if (prune)
      try {
        prune = (await steps.prune(db, clock())) > 0;
      } catch {
        prune = false;
        await recordMetric(db, "feedback_maintenance_failed", clock());
      }
    if (reconcile && clock() < deadline)
      try {
        reconcile = (await steps.reconcile(db, keys, clock())) > 0;
      } catch {
        reconcile = false;
        await recordMetric(db, "feedback_maintenance_failed", clock());
      }
  }
  await observeFeedbackGrowth(db, clock());
}
