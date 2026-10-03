import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDepletionMigration } from "../../apps/worker/src/shell/observability/depletion-sql";

writeFileSync(
  fileURLToPath(new URL("../../migrations/0025_observability_depletion.sql", import.meta.url)),
  buildDepletionMigration(),
);
