import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4187",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "PORT=4187 npm run dev --workspace @motion/web",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
