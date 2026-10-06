import { controlsAllow, readControl } from "../../shell/observability/controls";
import { SOURCE_REGISTRY } from "../../sources/registry";
import type { PollMode } from "./source-poll";
export interface PipelineControls {
  readonly sources: Readonly<Record<string, { enabled: boolean; mode: PollMode }>>;
  readonly automaticPublication: boolean;
  readonly model: boolean;
  /** P3-25（ADR-0018）：AI 草稿免人工审核；只在草稿可用（model）时有意义。 */
  readonly reviewSkip: boolean;
}
export type PipelineControlReader = () => Promise<PipelineControls | null>;
export async function readPipelineControls(db: D1Database): Promise<PipelineControls> {
  const outbound = await controlsAllow(db, "outbound_enabled");
  const writable = (await readControl(db, "read_only")).value !== true;
  const sources = Object.fromEntries(
    await Promise.all(
      SOURCE_REGISTRY.map(async (entry) => [
        entry.sourceId,
        {
          enabled:
            outbound &&
            writable &&
            (await readControl(db, "source_enabled", entry.sourceId)).value === true,
          mode: "normal" as PollMode,
        },
      ]),
    ),
  );
  const model = outbound && writable && (await controlsAllow(db, "model_enabled"));
  return {
    sources,
    automaticPublication: writable && (await controlsAllow(db, "automatic_publication_enabled")),
    model,
    reviewSkip: model && (await controlsAllow(db, "review_skip_enabled")),
  };
}
