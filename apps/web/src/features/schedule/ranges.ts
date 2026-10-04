import { BROWSE_RANGES, type BrowseRange } from "@hoyo/contracts";

/**
 * 首页提供的时间范围档位。「未来90天」不再单独提供（与「全部」重叠、命名也与其余档位不一致）；
 * 旧链接里的 range=90d 按「全部」读取，保证原先能看到的条目仍然可见。
 */
export const HOME_RANGES = BROWSE_RANGES.filter((range) => range.id !== "90d");

export function homeRange(range: BrowseRange): BrowseRange {
  return range === "90d" ? "all" : range;
}

/** 空范围时「试试更大范围」的下一档；已是最大档时返回 undefined。 */
export function widerRange(range: BrowseRange) {
  return HOME_RANGES[HOME_RANGES.findIndex((item) => item.id === range) + 1];
}
