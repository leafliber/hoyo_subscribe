import {
  CalendarPreviewNodeSchema,
  calendarPreviewCandidates,
  REMINDER_RULES,
  SUPPORTED_SCOPE_GAMES,
  SUPPORTED_SCOPE_REGIONS,
} from "@hoyo/contracts";

/** Synthetic fallback only. Every title visibly names the example; no live event is invented. */
export function sampleNodes(asOf: number) {
  return calendarPreviewCandidates(
    SUPPORTED_SCOPE_GAMES.flatMap((game) =>
      REMINDER_RULES.map((rule) =>
        CalendarPreviewNodeSchema.parse({
          game,
          region: SUPPORTED_SCOPE_REGIONS[0],
          projection: {
            event_id: `synthetic-${game}-${rule.event_type}`,
            milestone_id: `synthetic-${game}-${rule.rule_id}`,
            event: {
              event_type: rule.event_type,
              status: "scheduled",
              title: "样例活动（合成，非官方日程）",
              summary: null,
              official_url: null,
            },
            milestone: {
              milestone_key: rule.rule_id,
              node_type: rule.node_type,
              title: "样例节点",
              time: {
                precision: "datetime",
                utc_ms: asOf,
                time_basis: "official_explicit",
                source_timezone: "UTC+8",
                raw_expression: "synthetic example",
              },
            },
          },
          patch: null,
          tombstone: false,
        }),
      ),
    ),
    asOf,
  );
}
