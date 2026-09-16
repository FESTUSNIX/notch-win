import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: "http://127.0.0.1:1421", browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", viewport: {width:1280,height:820} },
  webServer: { command: "npm run build && npm run preview -- --host 127.0.0.1 --port 1421 --strictPort", url: "http://127.0.0.1:1421", reuseExistingServer: false },
  /* ⚠️ ONE worker, and the minute it costs is worth it. A dozen of these
     measure MOTION — a rail drag frame by frame, a fold that must not show the
     panel, a spring that has to have settled — so they fail when frames are
     missed, and three parallel Chrome instances miss frames. Serially two or
     three stop failing; they do not stop entirely, because the other thing
     stealing frames is whatever else the machine is doing (a video call will
     do it). A failure here is only real if it survives being run alone — see
     AGENTS 424, where reading one of these as a regression cost three rounds
     of chasing code that was fine. */
  workers: 1,
  reporter: "list",
});
