import { defineConfig } from "vite";
import { resolve } from "path";

// Tauri drives the dev server; the fixed port is what `devUrl` points at.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      // Two pages: the notch itself, and the settings panel the orb opens.
      input: {
        notch: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
