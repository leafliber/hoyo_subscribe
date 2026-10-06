import type { Page } from "@playwright/test";
import {
  type BrowseRange,
  browseDate,
  browseWindow,
  EVENT_TYPES,
  NODE_TYPES,
  type PublicArticleBlock,
  type PublicCatalogResponse,
  type PublicEventArticlesResponse,
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
/**
 * P3-22：按官方公告正文的真实结构（带样式的段落、转义时间标签、表格合并单元格、折叠段、
 * 游戏内链接写法）合成的原文；文字为隔离样例。另含脚本、事件属性、javascript: 链接等不应生效的内容。
 */
export const ARTICLE_FIXTURE_BLOCKS: PublicArticleBlock[] = [
  { kind: "title", text: "「巡游拾光」城市探索挑战活动说明" },
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap; text-align: center;"><img src="https://example.com/banner.jpg" href="" onerror="window.__articleExecuted=1" style="vertical-align: middle;"></p>',
  },
  { kind: "html", html: '<p style="white-space: pre-wrap; min-height: 1.5em;"></p>' },
  { kind: "html", html: '<h1 style="">活动说明</h1>' },
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap;"><span style="color: rgb(85, 85, 85);">〓活动时间〓</span></p>',
  },
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap;"><span style="color: rgb(204, 146, 85);">&lt;t class="t_gl" contenteditable="false"&gt;2026/09/22 10:00&lt;/t&gt;</span> - <span>&lt;t class="t_gl"&gt;2026/09/29 03:59&lt;/t&gt;</span></p>',
  },
  // 线上原神公告的另一种写法：转义标签里的时间再包一层元素，解析后开、合标签分在不同文字节点。
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap; text-align: left;"><span style="color: rgb(236, 73, 35);">※&lt;t class="t_lc" contenteditable="false"&gt;<span style="color: rgb(236, 73, 35);">2026/09/29 02:59</span>&lt;/t&gt;将关闭奖励兑换，请留意时间。</span></p>',
  },
  { kind: "html", html: '<p style="white-space: pre-wrap;"><strong>■参与条件</strong></p>' },
  {
    kind: "html",
    html: '<ul><li><p style="white-space: pre-wrap;">冒险等阶达到 20 级</p></li><li><p style="white-space: pre-wrap;">完成序章任务</p></li></ul>',
  },
  {
    kind: "html",
    html: '<div class="table-wrapper"><table class="" border="1" cellspacing="0" style="width: 100%;"><colgroup><col style="width: 30%;"><col style="width: 70%;"></colgroup><tbody><tr><td colspan="2" data-colwidth="130,307" style="background-color: rgb(254, 245, 231);"><p style="text-align: center;">阶段安排</p></td></tr><tr><td rowspan="2"><p>第一阶段</p></td><td><p>城市探索</p></td></tr><tr><td><p>奖励领取截止 &lt;t class="t_gl"&gt;2026/09/30 23:59&lt;/t&gt;</p></td></tr></tbody></table></div>',
  },
  {
    kind: "html",
    html: '<details><summary><span style="color: rgb(53, 150, 151);">奖励一览</span></summary><div class="expansion-content"><p style="white-space: pre-wrap;">◇原石×60</p><p style="white-space: pre-wrap;">◇摩拉×20000</p></div></details>',
  },
  {
    kind: "html",
    html: '<p style="white-space: pre-wrap;"><a href="javascript:miHoYoGameJSSDK.openInBrowser(\'https://example.com/event?a=1&amp;b=2\');" data-type="a" link-type="game_outer" rel="noopener noreferrer nofollow">&gt;&gt;点击前往活动页面&lt;&lt;</a></p>',
  },
  {
    kind: "html",
    html: '<p><a href="javascript:alert(1)">不安全的链接文字</a><script>window.__articleExecuted=1</script><iframe src="https://example.com/frame"></iframe><style>body{display:none}</style></p>',
  },
  { kind: "text", text: "注：活动规则以游戏内说明为准 &amp; 解释权归官方所有" },
];
export function articlesFixture(id: string): PublicEventArticlesResponse | null {
  if (!detailFixture(id)) return null;
  return {
    publication,
    cache: cache(),
    eventId: id,
    articles: [
      {
        officialUrl: "https://example.com/official-api",
        versionNo: 2,
        fetchedAt: Date.parse("2026-09-21T18:30:00+08:00"),
        publishedAt: null,
        completeness: "complete",
        blocks: ARTICLE_FIXTURE_BLOCKS,
      },
    ],
  };
}
export async function mockPublicApi(page: Page) {
  const control = {
    scenario: "normal" as DemoScenario,
    events: eventsFixture,
    status: statusFixture,
    detail: detailFixture,
    articles: articlesFixture,
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
    const articles = /^\/api\/v2\/events\/([^/]+)\/articles$/.exec(url.pathname);
    if (articles?.[1]) {
      const result = control.articles(decodeURIComponent(articles[1]));
      return route.fulfill(result ? { json: result } : { status: 404, json: {} });
    }
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
