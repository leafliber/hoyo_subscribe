import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// F4-01 stays inside its allowed directory; the normal suite remains unchanged.
export default defineConfig({
  testDir: ".",
  testMatch: "email.spec.ts",
  outputDir: "/tmp/f4-01-email-results",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4184", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm --filter @hoyo/web dev --host 127.0.0.1 --port 4184 --ignore-lock",
    cwd: fileURLToPath(new URL("../../../../../../..", import.meta.url)),
    url: "http://127.0.0.1:4184",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
