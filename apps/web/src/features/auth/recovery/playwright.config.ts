/// <reference types="node" />
import { defineConfig } from "@playwright/test";
import base from "../../../../../../tests/e2e/playwright.config";

// Keep this card's tests inside its authorized directory; share the standard two viewports/server.
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "recovery.spec.ts",
  outputDir: "../../../../../../tests/e2e/test-results/recovery",
  use: { ...base.use, trace: "off", screenshot: "off", video: "off" },
});
