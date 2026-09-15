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
      /* Three pages: the usage notch, the island, and the settings window.
         ⚠️ `task-editor.html` IS the settings window — the filename is what
         Rust opens and what the smoke test drives, so it kept its name when
         the page stopped being a task editor. `settings.html` was a FOURTH
         place to change a setting and is gone. */
      input: {
        notch: resolve(__dirname, "index.html"),
        tasks: resolve(__dirname, "tasks.html"),
        taskEditor: resolve(__dirname, "task-editor.html"),
        // One window per pinned note, all the same page with a different `?id`.
        note: resolve(__dirname, "note.html"),
      },
    },
  },
});
