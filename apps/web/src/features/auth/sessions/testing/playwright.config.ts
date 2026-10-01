/// <reference types="node" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseline from "../../../../../../../tests/e2e/playwright.config";

// Keep F3-03 tests inside the authorized directory; reuse both baseline browser projects.
export default defineConfig({
  ...baseline,
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  outputDir: fileURLToPath(
    new URL("../../../../../../../tests/e2e/test-results/f3-03", import.meta.url),
  ),
});
