// P3-11：P5-01 的唯一运行开关读取接入点；本卡不建立存储、不决定缺省值。
import type { PollMode } from "./source-poll";
export interface PipelineControls {
  readonly sources: Readonly<Record<string, { enabled: boolean; mode: PollMode }>>;
  readonly automaticPublication: boolean;
  readonly model: boolean;
}
export type PipelineControlReader = () => Promise<PipelineControls | null>;
/** P5-01 替换此读取实现。null 表示尚未配置，调用方报告并停止扩大，不伪装成开关值。 */
export const readPipelineControls: PipelineControlReader = async () => null;
