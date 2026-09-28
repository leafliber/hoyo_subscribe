// P3-04 获准跨卡改动：PipelineDO 将来可调用的事实发布入口；本卡不接 alarm/HTTP 线。
import { type PublishOutcome, publishApprovedCandidate } from "../../publishing/publish";

export function publishExtractedCandidate(
  db: D1Database,
  candidateId: string,
  nowMs: number,
): Promise<PublishOutcome> {
  return publishApprovedCandidate(db, candidateId, nowMs);
}
