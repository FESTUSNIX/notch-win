import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: "http://127.0.0.1:1421", browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", viewport: {width:900,height:700} },
  webServer: { command: "npm run build && npm run preview -- --host 127.0.0.1 --port 1421 --strictPort", url: "http://127.0.0.1:1421", reuseExistingServer: false },
  reporter: "list",
});
