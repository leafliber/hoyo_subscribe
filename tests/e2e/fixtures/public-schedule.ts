import type { Page } from "@playwright/test";
import {
  type BrowseRange,
  browseDate,
  browseWindow,
  EVENT_TYPES,
  NODE_TYPES,
  type PublicCatalogResponse,
  type PublicEventDetailResponse,
  type PublicEventsResponse,
  type PublicScheduleNode,
  type PublicStatusResponse,
  publicCache,
  publicImportantNode,
  SUPPORTED_SCOPE,
} from "../../../packages/contracts/src/index";
import { type DemoScenario, demoEvent, demoSnapshot } from "./schedule-legacy";

export const clock = new Date("2026-09-22T12:30:00+08:00");
const publication = { generation: 7, publishedAt: Date.parse("2026-09-21T19:00:00+08:00") };
const cache = () => publicCache(publication, clock.getTime());
export function catalogFixture(): PublicCatalogResponse {
  return {
    games: [...SUPPORTED_SCOPE.games],
    regions: [...SUPPORTED_SCOPE.regions],
    eventTypes: [...EVENT_TYPES],
    nodeTypes: [...NODE_TYPES],
    publication,
    cache: cache(),
  };
}
function nodeFixture(
  node: ReturnType<typeof demoSnapshot>["nodes"][number],
  eventId = `evt_${node.id}`,
): PublicScheduleNode {
  return {
    ...node,
    eventId,
    change: node.change
      ? {
          ...node.change,
          historicalTime:
            node.change.kind === "rescheduled"
              ? (demoEvent(clock.getTime(), "rescheduled")?.historicalTime ?? null)
              : node.time,
          currentTime:
            node.status === "cancelled" || node.status === "retracted" ? null : node.time,
          evidence: node.evidence,
          retainUntil: clock.getTime(),
        }
      : null,
  };
}
export function eventsFixture(
  params = new URLSearchParams(),
  scenario: DemoScenario = "normal",
): PublicEventsResponse {
  const range = (params.get("range") ?? "3d") as BrowseRange;
  const window = browseWindow(range, clock.getTime());
  const games = params.has("games")
    ? (params.get("games")?.split(",") ?? [])
    : [...SUPPORTED_SCOPE.games];
  const all = demoSnapshot(clock.getTime(), scenario)
    .nodes.map((node) => nodeFixture(node))
    .filter((node) => games.includes(node.game));
  return {
    publication,
    cache:
      scenario === "stale"
        ? {
            generatedAt: Date.parse("2026-09-21T20:00:00+08:00"),
            freshUntil: clock.getTime() - 1,
            stale: false,
          }
        : cache(),
    window,
    nodes: all.filter((node) => {
      if (node.time.precision === "unknown") return true;
      if (node.time.precision === "datetime")
        return (
          node.time.utc_ms >= window.yesterday &&
          (window.end === null || node.time.utc_ms < window.end)
        );
      return (
        node.time.date >= browseDate(window.yesterday) &&
        (window.end === null || node.time.date < browseDate(window.end))
      );
    }),
    recentChanges: all.filter((node) => node.change),
    recentChangesTruncated: false,
    nextCursor: null,
  };
}
export function statusFixture(scenario: DemoScenario = "normal"): PublicStatusResponse {
  return {
    registration_open: true,
    mail_sending_available: true,
    publication,
    cache: cache(),
    sources: SUPPORTED_SCOPE.games.map((game) => ({
      sourceId: `synthetic-${game}`,
      game,
      verifiedAt: Date.parse("2026-09-21T18:00:00+08:00"),
      verificationState: scenario === "source" ? "unavailable" : "verified",
      degradationReasons: scenario === "source" ? ["source_unavailable"] : [],
    })),
    reviewGaps: SUPPORTED_SCOPE.games.map((game) => ({
      game,
      count: scenario === "review" && game === "genshin" ? 2 : 0,
    })),
    capabilities: {
      calendar: "unknown",
      email_seats: "unknown",
      routine_email: "unknown",
      push: "unknown",
    },
    calendarClients: [],
  };
}
export function detailFixture(id: string): PublicEventDetailResponse | null {
  const legacy = demoEvent(clock.getTime(), id.replace(/^evt_/, ""));
  if (!legacy) return null;
  const milestones = legacy.milestones.map((node) => nodeFixture(node, id));
  return {
    publication,
    cache: cache(),
    event: {
      id,
      title: legacy.title,
      game: legacy.game,
      eventType: legacy.eventType,
      status: legacy.status,
      importantNodeId: publicImportantNode(milestones, clock.getTime()),
      milestones,
      changes: milestones.flatMap((node) =>
        node.change ? [{ nodeId: node.id, change: node.change }] : [],
      ),
      official: {
        url: legacy.official.url,
        publisher: null,
        publishedAt: legacy.official.publishedAt,
        updatedAt: null,
        excerpts: [legacy.official.noticeText],
      },
    },
  };
}
export async function mockPublicApi(page: Page) {
  const control = {
    scenario: "normal" as DemoScenario,
    events: eventsFixture,
    status: statusFixture,
    detail: detailFixture,
    calls: [] as { path: string; method: string }[],
  };
  await page.clock.setFixedTime(clock);
  await page.route("**/api/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    control.calls.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/v2/catalog") return route.fulfill({ json: catalogFixture() });
    if (url.pathname === "/api/v2/events")
      return route.fulfill({ json: control.events(url.searchParams, control.scenario) });
    if (url.pathname === "/api/v2/status")
      return route.fulfill({ json: control.status(control.scenario) });
    if (url.pathname.startsWith("/api/v2/events/")) {
      const result = control.detail(
        decodeURIComponent(url.pathname.slice("/api/v2/events/".length)),
      );
      return route.fulfill(result ? { json: result } : { status: 404, json: {} });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return control;
}
