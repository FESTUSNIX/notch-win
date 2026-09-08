import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Edge = "top" | "bottom" | "left" | "right";

interface Snapshot {
  id: string;
  displayName: string;
  status: { state: string; message?: string };
  windows: { id: string }[];
}

const edges = document.getElementById("edges") as HTMLDivElement;

function markEdge(active: Edge) {
  for (const button of edges.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.edge === active),
    );
  }
}

edges.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-edge]",
  );
  if (!button) return;
  const edge = button.dataset.edge as Edge;
  markEdge(edge);
  await invoke("set_edge", { edge }).catch(() => {});
});

const autostart = document.getElementById("autostart") as HTMLButtonElement;

autostart?.addEventListener("click", async () => {
  const next = autostart.getAttribute("aria-pressed") !== "true";
  try {
    await invoke("set_autostart", { enabled: next });
    autostart.setAttribute("aria-pressed", String(next));
  } catch (error) {
    // The registry write is the only thing here that can fail on its own, so
    // say so rather than silently leaving the button in the wrong state.
    autostart.textContent = `Could not change it: ${error}`;
  }
});

document.getElementById("reset")?.addEventListener("click", () => {
  invoke("reset_position").catch(() => {});
});

document.getElementById("quit")?.addEventListener("click", () => {
  invoke("quit_app").catch(() => {});
});

document.getElementById("close")?.addEventListener("click", () => {
  getCurrentWindow().hide();
});

/* What the notch is actually reading, named rather than counted — "Claude,
   Codex" says more than "2 providers", and a provider that is signed out should
   say so here rather than only be missing from the notch. */
async function describeProviders() {
  const target = document.getElementById("providers");
  if (!target) return;

  const snapshots = await invoke<Snapshot[]>("get_readings").catch(() => []);
  if (snapshots.length === 0) {
    target.textContent =
      "Nothing found yet. Sign in to Claude Code or Codex and it appears on its own.";
    return;
  }
  target.textContent = snapshots
    .map((s) => {
      if (s.status.state === "ok") return `${s.displayName} — reading`;
      if (s.status.state === "needsAuth") return `${s.displayName} — signed out`;
      if (s.status.state === "credentialExpired")
        return `${s.displayName} — token expired`;
      if (s.status.state === "rateLimited")
        return `${s.displayName} — rate limited`;
      return `${s.displayName} — ${s.status.message ?? "unavailable"}`;
    })
    .join(" · ");
}

async function boot() {
  const edge = await invoke<Edge>("get_edge").catch(() => "right" as Edge);
  markEdge(edge);
  const enabled = await invoke<boolean>("get_autostart").catch(() => false);
  autostart?.setAttribute("aria-pressed", String(enabled));
  await describeProviders();
}

boot();
