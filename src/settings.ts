import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Edge = "top" | "bottom" | "left" | "right";

interface Snapshot {
  id: string;
  displayName: string;
  status: { state: string; message?: string };
  windows: { id: string }[];
}

interface Screen {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

interface Displays {
  screens: Screen[];
  notch: string | null;
  tasks: string | null;
}

const edges = document.getElementById("edges") as HTMLDivElement;
document.getElementById("tasks")?.addEventListener("click", () => {
  invoke("open_task_editor").catch((error) => {
    document.getElementById("tasks")!.textContent = String(error);
  });
});

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

/* Which screen each notch lives on.
 *
 * The section stays hidden on a single-monitor machine: a picker whose only
 * two entries are "Automatic" and the one screen you have cannot do anything,
 * and offering it invites the question of what it would mean.
 *
 * "Automatic" is a real choice, not an empty one — it is what every install
 * had before this existed, and it means "wherever it already is", which on one
 * monitor is the only sane answer. */
async function paintDisplays() {
  const section = document.getElementById("displays-section");
  if (!section) return;

  const displays = await invoke<Displays>("get_displays").catch(() => null);
  if (!displays || displays.screens.length < 2) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  for (const label of ["tasks", "notch"] as const) {
    const select = document.getElementById(`display-${label}`) as HTMLSelectElement | null;
    if (!select) continue;
    const chosen = displays[label];
    select.replaceChildren();

    const auto = new Option("Automatic", "");
    auto.selected = chosen === null;
    select.append(auto);

    for (const screen of displays.screens) {
      // The size disambiguates two panels of the same model, which is exactly
      // the case a name alone cannot answer.
      const option = new Option(
        `${screen.name} · ${screen.width}×${screen.height}${screen.primary ? " · main" : ""}`,
        screen.id,
      );
      option.selected = screen.id === chosen;
      select.append(option);
    }

    select.onchange = () => {
      void invoke("set_display", {
        label,
        monitor: select.value === "" ? null : select.value,
      }).catch(() => {});
    };
  }
}

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
  await paintDisplays();
  // This window is shown rather than reloaded, so it would otherwise keep
  // whatever list it was opened with while monitors came and went behind it.
  await listen("notch:displays", () => {
    void paintDisplays();
  });
}

boot();
