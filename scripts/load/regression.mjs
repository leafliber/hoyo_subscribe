// Explicit dependency regressions: existing production workerd suites, not copied tests.
import { spawnSync } from "node:child_process";

const files = [
  "src/auth/preauth/admission.test.ts",
  "src/storage/ledger/mail-ledger.test.ts",
  "src/mail/budget/budget.test.ts",
  "src/mail/outbox/outbox.test.ts",
  "src/accounts/reclaim/reclaim.test.ts",
  "src/accounts/reclaim/routes.test.ts",
  "src/accounts/reclaim/combined.test.ts",
  "src/calendar/preview/rate.test.ts",
  "src/mail/channel/channel.test.ts",
];
const r = spawnSync("pnpm", ["--filter", "@hoyo/worker", "exec", "vitest", "run", ...files], {
  stdio: "inherit",
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
});
process.exitCode = r.status ?? 1;
