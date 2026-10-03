// Read-only deployment handoff. Runtime values and control enumeration stay in contracts.

import { SOURCE_REGISTRY } from "../../apps/worker/src/sources/registry.ts";
import * as C from "../../packages/contracts/src/index.ts";

const names = [
  "ACCOUNT_MAX_STORED",
  "ACCOUNT_IDLE_DAYS",
  "ACCOUNT_GRACE_DAYS",
  "MAIL_SEATS_MAX",
  "MAIL_ROUTINE_SEATS_MAX",
  "MAIL_SEAT_LEASE",
  "MAIL_AUTH_DAY",
  "MAIL_SIGNUP_AUTH_DAY",
  "MAIL_BASE_DAY",
  "MAIL_URGENT_DAY",
  "MAIL_TOTAL_DAY",
  "MAIL_AUTH_FLOOR",
  "MAIL_URGENT_FLOOR",
  "PLATFORM_MAIL_DAY_LIMIT",
  "MAIL_USER_BASE_DAY",
  "MAIL_USER_URGENT_DAY",
  "RECLAIM_QUERY_BUDGET",
  "FEEDBACK_BATCH",
  "FEEDBACK_MAINTENANCE_ROUNDS",
  "EXECUTOR_BATCH_WALL_LIMIT",
  "CALENDAR_PREVIEW_RATE_WINDOW",
  "CALENDAR_PREVIEW_RATE_LIMIT",
  "PUBLIC_CACHE_FRESH",
  "FEED_BASE_NODE_MAX",
  "FEED_PATCH_NODE_MAX",
  "FEED_RESPONSE_MAX_BYTES",
  "BACKUP_INTERVAL",
  "BACKUP_COPIES",
];
console.log(
  JSON.stringify(
    {
      parameters: Object.fromEntries(names.map((n) => [n, C[n]])),
      platformQueryLimit: C.PUBLIC_SNAPSHOT_WRITE_PROFILE.queryLimit,
      closedDeploymentControls: C.OPERATIONAL_CONTROLS.filter((c) => c !== "source_enabled").map(
        (control) => ({ control, enabled: control === "read_only" }),
      ),
      sources: SOURCE_REGISTRY.map((s) => ({
        control: "source_enabled",
        source: s.sourceId,
        enabled: false,
      })),
      mailBindings: "do not attach sending bindings until owner-controlled evidence step",
      finalRelease: "not_decided",
    },
    null,
    2,
  ),
);
