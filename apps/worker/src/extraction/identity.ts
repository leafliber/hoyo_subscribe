// P3-03 · 发布前的稳定身份计划；P3-04 在原子发布时使用这些键。
import { sha256Hex } from "../sources/snapshot-diff";

/** 日期不参与 Event 身份。 */
export function eventIdentity(
  sourceId: string,
  externalId: string,
  eventKey: string,
): Promise<string> {
  return sha256Hex(`event\n${sourceId}\n${externalId}\n${eventKey}`);
}

/** 日期不参与 Milestone 身份；同类阶段由稳定 milestone_key 区分。 */
export function milestoneIdentity(eventId: string, milestoneKey: string): Promise<string> {
  return sha256Hex(`milestone\n${eventId}\n${milestoneKey}`);
}
