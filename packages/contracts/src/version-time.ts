// 版本相对时间的确定性推导（ADR-0011；主方案 §3.3"确定性推导"与前端 §3"显示结果并给出推导依据"）。
//
// 只认官方写法里明确指向某个版本的两类锚点：
// - "X.Y版本更新后/更新完成后/上线后/开启后"，以及 ADR-0013 增补的"X.Y版更后""自X.Y版本上线起"：
//   只推到更新当天的日期（北京时间）。
//   不推出几点：主方案 §3.3 规定"预计维护五小时"不是实际开服，"更新后开放"不能猜固定时刻。
// - "X.Y版本结束/结束前/结束时"：推到管理员确认过的版本结束时刻。
//   "结束后"不认：用在开始节点时等于"下一版本更新后"，推成时刻就是猜开服时间。
// 输入的版本时间必须是管理员确认过的值；本模块是纯函数，不读库、不调用模型。
import { browseDate } from "./schedule-browse";
import { DateOnlySchema, ExactTimeSchema, type TimeValue } from "./time";

export type VersionAnchorKind = "update" | "end";

export interface VersionAnchor {
  readonly version: string;
  readonly kind: VersionAnchorKind;
}

/** 管理员确认后的版本时间；未确认的字段为 null，不参与推导。 */
export interface ConfirmedVersionWindow {
  readonly version: string;
  readonly updateStartMs: number | null;
  readonly versionEndMs: number | null;
}

const VERSION = String.raw`[「“]?(\d{1,2}\.\d{1,2})[」”]?`;
const UPDATE_ANCHOR = new RegExp(
  `^(?:自)?${VERSION}(?:版本(?:更新后|更新完成后|更新开始后|上线后|开启后|上线起)|版更后)$`,
);
const END_ANCHOR = new RegExp(`^${VERSION}版本(?:结束|结束前|结束时)$`);

/** 原始表达必须整体就是锚点（去掉首尾空白），夹带其他文字的不推导。 */
export function parseVersionAnchor(rawExpression: string): VersionAnchor | null {
  const raw = rawExpression.trim();
  const update = UPDATE_ANCHOR.exec(raw);
  if (update !== null) return { version: update[1], kind: "update" };
  const end = END_ANCHOR.exec(raw);
  if (end !== null) return { version: end[1], kind: "end" };
  return null;
}

/** 公开详情与管理端展示的推导依据（前端 §4.4"详情提供原始表述与推导依据"）；不是版本锚点时为 null。 */
export function versionDerivationBasis(rawExpression: string): string | null {
  const anchor = parseVersionAnchor(rawExpression);
  if (anchor === null) return null;
  return anchor.kind === "update"
    ? `取 ${anchor.version} 版本更新开始当天（北京时间），按官方版本公告核对确认；更新后的具体开放时刻官方未公布，不推出几点。`
    : `取 ${anchor.version} 版本的结束时间，按官方版本公告核对确认。`;
}

/** 版本号按"主.次"数值比较，用于排序。 */
export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return aMajor === bMajor ? aMinor - bMinor : aMajor - bMajor;
}

/** 紧接在 version 之后可能的版本号：同一大版本的下一个小版本（7.1→7.2），或下一个大版本的 .0（4.8→5.0）。 */
export function nextVersionCandidates(version: string): readonly [string, string] {
  const [major, minor] = version.split(".").map(Number);
  return [`${major}.${minor + 1}`, `${major + 1}.0`];
}

/**
 * 在已知版本里取紧接着的下一个版本，小版本优先；两者都未知时为 null。
 * 不跳过未知或未确认的版本去取更远的版本：7.2 还没出现时，7.1 的结束不能取 7.3 的更新开始。
 */
export function nextKnownVersion(version: string, known: Iterable<string>): string | null {
  const set = new Set(known);
  const [minorNext, majorNext] = nextVersionCandidates(version);
  if (set.has(minorNext)) return minorNext;
  return set.has(majorNext) ? majorNext : null;
}

/**
 * 推导结果保留官方原始表达，time_basis 为 deterministic_derived。
 * 锚点无法识别、版本不匹配或所需字段未确认时返回 null（保持"未定时刻"）。
 */
export function deriveVersionTime(
  rawExpression: string,
  window: ConfirmedVersionWindow | undefined,
  sourceTimezone: string,
): TimeValue | null {
  const anchor = parseVersionAnchor(rawExpression);
  if (anchor === null || window === undefined || window.version !== anchor.version) return null;
  if (anchor.kind === "update") {
    if (window.updateStartMs === null) return null;
    return {
      precision: "date",
      date: DateOnlySchema.parse(browseDate(window.updateStartMs)),
      source_timezone: sourceTimezone,
      raw_expression: rawExpression,
      time_basis: "deterministic_derived",
    };
  }
  if (window.versionEndMs === null) return null;
  return {
    precision: "datetime",
    utc_ms: ExactTimeSchema.parse(window.versionEndMs),
    source_timezone: sourceTimezone,
    raw_expression: rawExpression,
    time_basis: "deterministic_derived",
  };
}
