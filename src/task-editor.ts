/* The settings window.
 *
 * ⚠️ **The file is still called `task-editor`** and the window is still
 * labelled `task-editor`, because that label is what Rust shows, focuses and
 * types into (`set_task_input`), what the smoke test drives, and what the
 * browser preview opens. Renaming it would touch five files to change a string
 * nobody sees. What it *is* changed: this was a task list with a quick-add
 * form and a stack of settings sections underneath, and the tasks live on the
 * island now, which is where you already are when you want them.
 *
 * ⚠️ **One window for every preference.** There were three: the island's gear
 * popover (edge, clock, task view), this window's sections (connections,
 * shortcuts, position) and a dozen constants in the source. Three places to
 * look is the same as no place to look.
 *
 * The shape is macOS System Settings — the list of pages on the left, the page
 * on the right — because that is the shape everyone already has for "a long
 * list of unrelated switches", and because a flat scroll of nine sections is
 * exactly what this window was before.
 *
 * ⚠️ **Nothing here holds a secret.** The TickTick token and the Google client
 * secret go straight to Rust and are never read back: `google_status` answers
 * with a bare boolean and the task snapshot with `connected`. A settings window
 * that can display a token is a settings window that can leak one.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, native, preview, watchTasks } from "./task-client";
import { emptySnapshot } from "./task-model";
import { element } from "./dom";
import { taskIcon, type TaskIcon } from "./task-icons";
import "./tasks.css";

/* ── What the window is made of ──────────────────────────────────────── */

interface Prefs {
  accent: string;
  weekStartsMonday: boolean;
  fahrenheit: boolean;
  openOnHover: boolean;
  foldDelayMs: number;
  motion: string;
  panelWidth: number;
  railVisible: number;
  railAlways: boolean;
  railGrip: number;
  railSharp: number;
  railFlat: boolean;
  railOrder: string[];
  railHidden: string[];
  railColours: Record<string, string>;
  useEverything: boolean;
  indexApps: boolean;
  notifyRuns: boolean;
  /** ⚠️ MUTED, not enabled. An "enabled" list cannot say "none of them": an
   *  empty list has to mean "all", so switching the last one off would switch
   *  them all back on. */
  mutedModules: string[];
  thresholds: Record<string, number>;
  /** `day` or `all`. What Today counts and what the pill counts down. */
  taskView: string;
}

interface Screen { id: string; name: string; width: number; height: number; primary: boolean }
interface Displays { screens: Screen[]; notch: string | null; tasks: string | null }
interface Reading { displayName: string; status: { state: string; message?: string } }

const PANES = [
  { id: "general", icon: "settings", label: "General", sub: "Startup, displays and what Codenotch is reading." },
  { id: "appearance", icon: "sun", label: "Appearance", sub: "The one colour everything is tinted by, and how numbers are written." },
  { id: "island", icon: "home", label: "Island", sub: "Where the panel lives and what it takes to open it." },
  { id: "pill", icon: "clock", label: "The pill", sub: "What the resting strip is allowed to say beside the time." },
  { id: "search", icon: "search", label: "Search", sub: "What the command palette is allowed to look through." },
  { id: "keys", icon: "keyboard", label: "Shortcuts", sub: "Global, so they work while another app has focus." },
  { id: "accounts", icon: "link", label: "Connections", sub: "TickTick, Google Calendar, Spotify and the forecast." },
] as const;

type PaneId = (typeof PANES)[number]["id"];

/** The pill's modules, in the order they can shout. Ids match `pill-modules.ts`
 *  — ⚠️ they cross the IPC boundary as data, so a rename here with no rename
 *  there is a switch that silently controls nothing. */
const MODULES: { id: string; icon: TaskIcon; title: string; note: string }[] = [
  { id: "disk", icon: "disk", title: "Disk filling up", note: "Only past the threshold below." },
  { id: "cpu", icon: "chip", title: "CPU pinned", note: "A sustained figure, not a spike." },
  { id: "memory", icon: "memory", title: "Memory pressure", note: "" },
  { id: "agents", icon: "agent", title: "Agents running", note: "How many Claude Code sessions are writing." },
  { id: "event", icon: "calendar", title: "Next meeting", note: "Between half an hour and three hours out." },
  { id: "tasks", icon: "today", title: "Tasks left today", note: "" },
  { id: "weather", icon: "wxPartly", title: "Weather", note: "Needs a place under Connections." },
];

/** ⚠️ Defaults duplicated from `pill-modules.ts` so the sliders start where the
 *  code actually starts. They are the *fallback*: `thresholds` overrides. */
const THRESHOLDS = [
  { id: "disk", title: "Disk", fallback: 92 },
  { id: "cpu", title: "CPU", fallback: 90 },
  { id: "memory", title: "Memory", fallback: 90 },
];

const KEYS = [
  { id: "palette", title: "Search & commands", note: "The command palette." },
  { id: "toggle", title: "Open the island", note: "" },
  { id: "capture", title: "Add a task", note: "Opens Today with the caret in the composer." },
  { id: "shelf", title: "Shelve the clipboard", note: "" },
  { id: "display", title: "Next display", note: "Does nothing on one monitor." },
  { id: "hide", title: "Hide everything", note: "Takes both notches off screen." },
] as const;
type KeyId = (typeof KEYS)[number]["id"];
type Shortcuts = Record<KeyId, string>;

/** ⚠️ AltGr IS Ctrl+Alt on Windows, and on a Polish layout these nine letters
 *  are characters. Registering `Ctrl+Alt+N` takes `ń` away — everywhere on the
 *  machine, with nothing to connect the two. See `shortcuts.rs`. */
const ALTGR_LETTERS = "ACELNOSXZ";

const ACCENTS = ["#00ff88", "#5ac8fa", "#a78bfa", "#ff9f0a", "#ff6961", "#f5f5f5"];

/* ── The shell ───────────────────────────────────────────────────────── */

document.body.className = "settings-page";
document.title = "Codenotch Settings";
const row = (title: string, note: string, control: string, extra = "") =>
  `<div class="set-row${extra ? " " + extra : ""}"><div class="set-text"><b>${title}</b>${note ? `<span>${note}</span>` : ""}</div><div class="set-ctl">${control}</div></div>`;

const seg = (name: string, options: [string, string][], label: string) =>
  `<div class="seg" role="group" aria-label="${label}" data-seg="${name}">${
    options.map(([value, text]) => `<button type="button" data-value="${value}" aria-pressed="false">${text}</button>`).join("")
  }</div>`;

const check = (id: string) => `<input type="checkbox" class="switch" id="${id}">`;

const PANE_HTML: Record<PaneId, string> = {
  general: `
    <div><p class="set-label">Startup</p><div class="set-group">
      ${row("Start with Windows", "Launches Codenotch when you sign in.", check("autostart"))}
      ${row("Tell me when a run finishes", "A notification when an agent stops needing you.", check("notify-runs"))}
    </div></div>
    <div id="displays-group" hidden><p class="set-label">Displays</p><div class="set-group">
      ${row("Island", "", `<select id="display-tasks"></select>`)}
      ${row("Usage notch", "", `<select id="display-notch"></select>`)}
    </div></div>
    <div><p class="set-label">Position</p><div class="set-group">
      ${row("Reset position", "Both notches back to the middle of their edge. Drag either one along its edge to move it.", `<button type="button" class="set-btn" id="reset-position">Reset</button>`)}
    </div></div>
    <div><p class="set-label">Codenotch</p><div class="set-group">
      ${row("Reading", "", `<span class="set-value" id="providers" style="min-width:0;text-align:right">…</span>`)}
      ${row("Log", "Everything the app has said to itself today.", `<button type="button" class="set-btn" id="open-log">Open log</button>`)}
      ${row("Quit", "Takes the notches down until you launch it again.", `<button type="button" class="set-btn is-danger" id="quit">Quit Codenotch</button>`)}
    </div></div>`,

  appearance: `
    <div><p class="set-label">Colour</p><div class="set-group">
      ${row("Accent", "Every lit edge, every selected tab and the focus ring take this one colour.",
        `<div class="swatches" id="swatches">${ACCENTS.map(c => `<button type="button" class="swatch" data-accent="${c}" style="background:${c};color:${c}" aria-label="${c}" aria-pressed="false"></button>`).join("")}<input type="color" id="accent-custom" aria-label="Any other colour"></div>`, "stack")}
    </div></div>
    <div><p class="set-label">Clock &amp; units</p><div class="set-group">
      ${row("Clock", "", seg("clock", [["24", "24 h"], ["12", "12 h"]], "Clock format"))}
      ${row("Week starts on", "Home's week strip and the Calendar's grid.", seg("week", [["mon", "Monday"], ["sun", "Sunday"]], "First day of the week"))}
      ${row("Temperature", "", seg("units", [["c", "°C"], ["f", "°F"]], "Temperature units"))}
    </div></div>
    <div><p class="set-label">Motion</p><div class="set-group">
      ${row("Animations", "“System” follows the Windows setting for reduced motion.", seg("motion", [["system", "System"], ["always", "Always"], ["never", "Never"]], "Animation"))}
    </div></div>`,

  island: `
    <div><p class="set-label">Where it lives</p><div class="set-group">
      ${row("Screen edge", "Which edge the island is welded to.", seg("edge", [["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]], "Screen edge"))}
      ${row("Show the island", "Off, only the usage notch remains.", check("notch-visible"))}
    </div></div>
    <div><p class="set-label">Opening</p><div class="set-group">
      ${row("Open on hover", "Off, it takes a click — or the shortcut.", check("open-on-hover"))}
      ${row("Stays open for", "How long the panel waits after the pointer leaves.",
        `<input type="range" id="fold-delay" min="120" max="2000" step="20"><span class="set-value" id="fold-delay-value"></span>`)}
    </div></div>
    <div><p class="set-label">Size</p><div class="set-group">
      ${row("Panel width", "How wide the open panel is along its edge.",
        `<input type="range" id="panel-width" min="0" max="1100" step="20"><span class="set-value" id="panel-width-value"></span>`)}
    </div></div>
    <div><p class="set-label">Screens</p><div class="set-group">
      ${row("Screens on the rail", "How many show at once. The rest blur away either side.",
        `<input type="range" id="rail-visible" min="3" max="7" step="1"><span class="set-value" id="rail-visible-value"></span>`)}
      ${row("Always show them", "Off, the rail is a bare shape until you reach for it — like the two arcs.", check("rail-always"))}
      ${row("Drag strength", "How far you drag for one screen. Higher is heavier.",
        `<input type="range" id="rail-grip" min="50" max="300" step="10"><span class="set-value" id="rail-grip-value"></span>`)}
      ${row("Kept sharp", "How many either side of the middle stay unblurred.",
        `<input type="range" id="rail-sharp" min="0" max="3" step="1"><span class="set-value" id="rail-sharp-value"></span>`)}
      ${row("Show them all", "Every screen laid out and clickable, instead of one in the middle to drag between.", check("rail-flat"))}
    </div>
    <p class="set-label">Which screens, and in what order</p>
    <p class="set-why">Drag to reorder. Switch one off and it leaves the rail — it is still reachable from the palette.</p>
    <div class="set-group" id="rail-screens">
    </div></div>
    <div><p class="set-label">Tasks</p><div class="set-group">
      ${row("Tasks showing", "What Today counts, and what the pill counts down.", seg("view", [["day", "Today"], ["all", "All lists"]], "Task view"))}
    </div></div>`,

  pill: `
    <div><p class="set-label">What it may say</p><div class="set-group" id="modules"></div>
      <p class="set-note">The strip at rest is three slots — the date, the clock and one of these. Everything switched off leaves the third slot empty.</p></div>
    <div><p class="set-label">When it speaks up</p><div class="set-group" id="thresholds"></div>
      <p class="set-note">A disk that lives above 95% is a fact about the machine, not news. Raise the number until the pill only tells you things you did not know.</p></div>
    <div><p class="set-label">Snoozed</p><div class="set-group">
      ${row("Quietened", "Things you told to be quiet from the island.", `<button type="button" class="set-btn" id="unsnooze">Bring back</button>`)}
    </div><p class="set-note" id="snoozed-note"></p></div>`,

  search: `
    <div><p class="set-label">Files</p><div class="set-group">
      ${row("Use Everything", "voidtools Everything answers file searches instantly. Off, the palette never asks it.", check("use-everything"))}
    </div><p class="set-note" id="everything-note"></p></div>
    <div><p class="set-label">Applications</p><div class="set-group">
      ${row("Index the Start Menu", "Off, the palette cannot launch applications — and start-up is about a second and a half quicker.", check("index-apps"))}
    </div></div>`,

  keys: `
    <div><p class="set-label">Global shortcuts</p><div class="set-group" id="keys"></div>
      <p class="set-note">Click a shortcut, then press the combination. Esc cancels. Windows refuses a combination another app already owns, and says so here.</p>
      <p class="set-note is-warn" id="altgr-note" hidden></p></div>
    <div><div class="set-group">
      ${row("Back to the defaults", "", `<button type="button" class="set-btn" id="keys-default">Restore defaults</button>`)}
    </div></div>`,

  accounts: `
    <div><p class="set-label">TickTick</p><div class="set-group">
      ${row("Account", "", `<span class="set-value" id="ticktick-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("API token", "In TickTick on the web: Settings → Account → API Token. Saved in Windows Credential Manager on this PC and never read back.",
        `<input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="2500" placeholder="Paste your token"><button type="button" class="set-btn is-accent" id="ticktick-connect">Connect</button><button type="button" class="set-btn" id="ticktick-disconnect">Disconnect</button>`, "stack")}
    </div></div>
    <div><p class="set-label">Google Calendar</p><div class="set-group">
      ${row("Calendar", "", `<span class="set-value" id="google-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("OAuth client", "In Google Cloud Console create a client of type <strong>Desktop app</strong> and enable the Calendar API. Connecting opens your normal browser — Codenotch never sees your password and asks only to read.",
        `<input id="google-id" autocomplete="off" spellcheck="false" maxlength="400" placeholder="…apps.googleusercontent.com"><input id="google-secret" type="password" autocomplete="off" maxlength="400" placeholder="Client secret"><button type="button" class="set-btn is-accent" id="google-connect">Connect</button><button type="button" class="set-btn" id="google-disconnect">Disconnect</button>`, "stack")}
    </div></div>
    <div><p class="set-label">Spotify</p><div class="set-group">
      ${row("Queue", "", `<span class="set-value" id="spotify-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("Client ID", "Only for “Playing Next”. Everything else the player shows comes from Windows itself, so this is optional. Create an app at developer.spotify.com, and add the redirect URI below to it <strong>exactly</strong>.",
        `<input id="spotify-id" autocomplete="off" spellcheck="false" maxlength="200" placeholder="32 hex characters"><button type="button" class="set-btn is-accent" id="spotify-connect">Connect</button><button type="button" class="set-btn" id="spotify-disconnect">Disconnect</button>`, "stack")}
      ${row("Redirect URI", "Paste this into the app’s settings. Spotify matches it character for character, port included.",
        `<code class="set-code" id="spotify-redirect">…</code><button type="button" class="set-btn" id="spotify-copy">Copy</button>`)}
    </div></div>
    <div><p class="set-label">Weather</p><div class="set-group">
      ${row("Place", "Left empty, nothing is ever requested. This is the one thing here that reaches the network without an account.",
        `<input id="weather-place" autocomplete="off" spellcheck="false" maxlength="120" placeholder="Kraków"><button type="button" class="set-btn is-accent" id="weather-set">Use this place</button><button type="button" class="set-btn" id="weather-clear">Turn off</button>`, "stack")}
      ${row("Now", "", `<span class="set-value" id="weather-state" style="min-width:0;text-align:right">…</span>`)}
    </div></div>`,
};

document.getElementById("task-editor")!.innerHTML = `<div class="settings-shell">
  <aside class="settings-side">
    <div class="settings-brand"><span class="settings-mark" id="brand-mark"></span><span><b>Codenotch</b><small>Settings</small></span></div>
    <nav class="settings-nav" id="panes" role="tablist" aria-label="Settings"></nav>
    <p class="settings-foot">Preferences live beside the app’s own state. Tokens live in Windows Credential Manager.</p>
  </aside>
  <main class="settings-main">
    <header class="settings-bar"><div><h1 id="pane-title"></h1><p id="pane-sub"></p></div></header>
    <p class="set-status" id="settings-status" role="status"></p>
    <div class="settings-scroll">${PANES.map(p => `<section class="settings-pane" id="pane-${p.id}" role="tabpanel" hidden>${PANE_HTML[p.id]}</section>`).join("")}</div>
  </main>
</div>`;

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = get("settings-status");
get("brand-mark").append(taskIcon("settings"));

/* ── Saying what happened ────────────────────────────────────────────────
 * ⚠️ One line, in one place. The old window had a status line, an inline
 * connection state, a weather state and a "no lists returned" hint, and a
 * failure could land in any of them. */
let clearStatus = 0;
function say(text: string, tone: "" | "error" | "good" = "") {
  status.textContent = text;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-good", tone === "good");
  clearTimeout(clearStatus);
  if (text && tone !== "error") clearStatus = window.setTimeout(() => say(""), 4000);
}

async function run(command: string, args: Record<string, unknown> = {}, good = ""): Promise<boolean> {
  try {
    await call(command, args);
    if (good) say(good, "good");
    return true;
  } catch (error) {
    say(String(error), "error");
    return false;
  }
}

/* ── The pane strip ──────────────────────────────────────────────────── */

function show(id: PaneId, animate = true) {
  const spec = PANES.find(p => p.id === id)!;
  get("pane-title").textContent = spec.label;
  get("pane-sub").textContent = spec.sub;
  for (const p of PANES) {
    const section = get(`pane-${p.id}`);
    section.hidden = p.id !== id;
    section.classList.remove("arriving");
  }
  if (animate) {
    const section = get(`pane-${id}`);
    /* ⚠️ Removed and re-added with a reflow between, or a pane opened twice
     * only animates the first time. */
    void section.offsetWidth;
    section.classList.add("arriving");
  }
  for (const button of get("panes").querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-selected", String(button.dataset.pane === id));
  }
  location.hash = id;
}

for (const spec of PANES) {
  const button = element("button", "", "");
  button.dataset.pane = spec.id;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", "false");
  button.append(taskIcon(spec.icon as TaskIcon), element("span", "", spec.label));
  button.onclick = () => show(spec.id);
  get("panes").append(button);
}

/* ── Preferences ─────────────────────────────────────────────────────────
 * ⚠️ The WHOLE struct, every time. `set_prefs` takes one object and validates
 * it as one; a window with twenty controls sending twenty partial writes is
 * twenty chances to save a stale copy of the other nineteen. */
let prefs: Prefs = {
  accent: "#00ff88", weekStartsMonday: true, fahrenheit: false,
  openOnHover: true, foldDelayMs: 450, motion: "system", panelWidth: 0,
  railVisible: 5, railAlways: true, railGrip: 100, railSharp: 0, railFlat: false, railOrder: [], railHidden: [], railColours: {},
  useEverything: true, indexApps: true, notifyRuns: true,
  mutedModules: [], thresholds: {}, taskView: "day",
};

let saving = 0;
function savePrefs() {
  clearTimeout(saving);
  // Debounced: a slider being dragged is one intention, not forty writes.
  saving = window.setTimeout(async () => {
    try { prefs = await call<Prefs>("set_prefs", { prefs }); }
    catch (error) { say(String(error), "error"); }
  }, 180);
}

function applyAccent(value: string) {
  document.documentElement.style.setProperty("--accent", value);
  for (const swatch of get("swatches").querySelectorAll<HTMLButtonElement>(".swatch")) {
    swatch.setAttribute("aria-pressed", String(swatch.dataset.accent?.toLowerCase() === value.toLowerCase()));
  }
  get<HTMLInputElement>("accent-custom").value = value;
}

/* ── Segmented controls ──────────────────────────────────────────────── */

const segs = new Map<string, (value: string) => void>();

function onSeg(name: string, fn: (value: string) => void) { segs.set(name, fn); }

function markSeg(name: string, value: string) {
  const host = document.querySelector<HTMLElement>(`[data-seg="${name}"]`);
  if (!host) return;
  for (const button of host.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

document.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-seg] button");
  if (!button) return;
  const name = button.closest<HTMLElement>("[data-seg]")!.dataset.seg!;
  markSeg(name, button.dataset.value!);
  segs.get(name)?.(button.dataset.value!);
});

/* ── General ─────────────────────────────────────────────────────────── */

get<HTMLInputElement>("autostart").onchange = async event => {
  const box = event.target as HTMLInputElement;
  // The registry write is the only thing here that can fail on its own, so the
  // switch goes back if it did rather than lying about what is set.
  if (!await run("set_autostart", { enabled: box.checked })) box.checked = !box.checked;
};
get<HTMLInputElement>("notify-runs").onchange = event => {
  prefs.notifyRuns = (event.target as HTMLInputElement).checked;
  savePrefs();
};
get("reset-position").onclick = () => void run("reset_position", {}, "Back to the middle.");
get("open-log").onclick = () => void run("open_log");
get("quit").onclick = () => void run("quit_app");

/* Which screen each notch lives on.
 *
 * ⚠️ Hidden on a single-monitor machine. A picker whose only two entries are
 * "Automatic" and the one screen you have cannot do anything, and offering it
 * invites the question of what it would mean. "Automatic" is a real choice —
 * it is what every install had before this existed, and it means "wherever it
 * already is". */
async function paintDisplays() {
  const displays = await call<Displays>("get_displays").catch(() => null);
  const group = get("displays-group");
  if (!displays || displays.screens.length < 2) { group.hidden = true; return; }
  group.hidden = false;
  for (const label of ["tasks", "notch"] as const) {
    const select = get<HTMLSelectElement>(`display-${label}`);
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
    select.onchange = () => void run("set_display", { label, monitor: select.value || null });
  }
}

/** What the notch is actually reading, named rather than counted — "Claude,
 *  Codex" says more than "2 providers", and a provider that is signed out
 *  should say so here rather than only be missing from the notch. */
async function paintProviders() {
  const readings = await call<Reading[]>("get_readings").catch(() => []);
  get("providers").textContent = readings.length === 0
    ? "Nothing yet — sign in to Claude Code or Codex"
    : readings.map(r =>
        r.status.state === "ok" ? `${r.displayName} — reading`
        : r.status.state === "needsAuth" ? `${r.displayName} — signed out`
        : r.status.state === "credentialExpired" ? `${r.displayName} — token expired`
        : r.status.state === "rateLimited" ? `${r.displayName} — rate limited`
        : `${r.displayName} — ${r.status.message ?? "unavailable"}`).join(" · ");
}

/* ── Appearance ──────────────────────────────────────────────────────── */

get("swatches").addEventListener("click", event => {
  const swatch = (event.target as HTMLElement).closest<HTMLButtonElement>(".swatch");
  if (!swatch) return;
  prefs.accent = swatch.dataset.accent!;
  applyAccent(prefs.accent);
  savePrefs();
});
get<HTMLInputElement>("accent-custom").oninput = event => {
  prefs.accent = (event.target as HTMLInputElement).value;
  applyAccent(prefs.accent);
  savePrefs();
};

onSeg("clock", value => { clock24 = value === "24"; void run("set_clock_format", { clock24 }); });
onSeg("week", value => { prefs.weekStartsMonday = value === "mon"; savePrefs(); });
onSeg("units", value => {
  prefs.fahrenheit = value === "f";
  savePrefs();
  // The Connections pane writes a temperature too, and a unit that only takes
  // effect on the pill is a unit that looks like it did not take.
  if (lastWeather) sayWeather(lastWeather);
});
onSeg("motion", value => { prefs.motion = value; savePrefs(); });

/* ── Island ──────────────────────────────────────────────────────────── */

let clock24 = true;
let edge = "top";
let visible = true;

/** ⚠️ `set_task_placement` takes edge and visibility together, so both are
 *  read from here every time rather than sent one at a time. */
async function sendPlacement(reset = false) {
  if (await run("set_task_placement", { edge, visible, reset })) return;
  const current = await call<{ edge: string; visible: boolean }>("get_task_placement");
  edge = current.edge; visible = current.visible;
  markSeg("edge", edge);
  get<HTMLInputElement>("notch-visible").checked = visible;
}

onSeg("edge", value => { edge = value; void sendPlacement(); });
get<HTMLInputElement>("notch-visible").onchange = event => {
  visible = (event.target as HTMLInputElement).checked;
  void sendPlacement();
};
get<HTMLInputElement>("open-on-hover").onchange = event => {
  prefs.openOnHover = (event.target as HTMLInputElement).checked;
  savePrefs();
};

const foldDelay = get<HTMLInputElement>("fold-delay");
foldDelay.oninput = () => {
  prefs.foldDelayMs = Number(foldDelay.value);
  get("fold-delay-value").textContent = `${(prefs.foldDelayMs / 1000).toFixed(2)}s`;
  savePrefs();
};

const railVisible = get<HTMLInputElement>("rail-visible");
railVisible.oninput = () => {
  prefs.railVisible = Number(railVisible.value);
  get("rail-visible-value").textContent = `${prefs.railVisible}`;
  savePrefs();
};
get<HTMLInputElement>("rail-flat").onchange = event => {
  prefs.railFlat = (event.target as HTMLInputElement).checked;
  savePrefs();
};
get<HTMLInputElement>("rail-always").onchange = event => {
  prefs.railAlways = (event.target as HTMLInputElement).checked;
  savePrefs();
};

/* ── Which screens, and in what order ────────────────────────────────────
 * ⚠️ The list lives HERE, not on the island. The island's own copy is
 * `TABS` in `tasks.ts`, and this one has to agree with it or a screen is
 * reorderable into a place it cannot be shown. They are two constants because
 * the two windows share no module; keeping them in step is the price, and the
 * test at the bottom of `tips.spec.ts` is what notices. */
const SCREENS: { name: string; label: string }[] = [
  { name: "home", label: "Home" },
  { name: "today", label: "Today" },
  { name: "media", label: "Playing" },
  { name: "agents", label: "Agents" },
  { name: "shelf", label: "Shelf" },
  { name: "notes", label: "Notes" },
  { name: "calendar", label: "Calendar" },
  { name: "system", label: "System" },
  { name: "review", label: "Review" },
];

/** The screens in the order the preferences put them.
 *
 * ⚠️ Anything the preferences have not heard of keeps its built-in place at
 * the END rather than disappearing. A file written before a screen existed
 * must not hide it. */
function screenOrder(): { name: string; label: string }[] {
  const rank = (name: string) => {
    const at = prefs.railOrder.indexOf(name);
    return at < 0 ? SCREENS.findIndex(s => s.name === name) + SCREENS.length : at;
  };
  return [...SCREENS].sort((a, b) => rank(a.name) - rank(b.name));
}

/** Ready-made colours, so picking nine that go together is not a design job.
 *
 * ⚠️ Chosen to be TELLABLE APART at 18px, which is the only thing they are
 * for — not to be a harmonious palette. Two blues a shade apart look
 * considered in a swatch row and identical on the rail. */
const TONES = [
  "#00ff88", "#4db4ff", "#c58cff", "#ff5d8f",
  "#ff8a3d", "#ffd23d", "#5ee6c4", "#9aa4b2",
];

/** The accent as a hex string, for a colour input that cannot take anything
 *  else. ⚠️ Read off the element rather than off `prefs.accent`, which may be
 *  any CSS colour; the input only accepts `#rrggbb`. */
function accentNow(): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : "#00ff88";
}

function paintScreens() {
  const host = get("rail-screens");
  host.replaceChildren();
  for (const screen of screenOrder()) {
    const row = document.createElement("div");
    row.className = "set-row screen-row";
    row.dataset.screen = screen.name;

    const grip = document.createElement("span");
    grip.className = "screen-grip";
    grip.textContent = "≡";
    grip.setAttribute("aria-hidden", "true");

    const text = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = screen.label;
    text.append(name);
    /* ⚠️ Home cannot be switched off, and says so rather than simply
     * refusing. It is where the island opens and where a screen that
     * disappears sends you — hidden, neither has anywhere to land. */
    if (screen.name === "home") {
      const why = document.createElement("small");
      why.textContent = "Always on the rail";
      text.append(why);
    }

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "switch";
    box.checked = !prefs.railHidden.includes(screen.name);
    box.disabled = screen.name === "home";
    box.setAttribute("aria-label", `Show ${screen.label} on the rail`);
    box.onchange = () => {
      prefs.railHidden = box.checked
        ? prefs.railHidden.filter(one => one !== screen.name)
        : [...prefs.railHidden.filter(one => one !== screen.name), screen.name];
      savePrefs();
    };

    /* ⚠️ A colour per screen, and its DEFAULT is the accent rather than a
     * stored value. Nothing is written until one is picked, so the palette
     * follows the accent for anybody who never opens this. */
    const dye = document.createElement("input");
    dye.type = "color";
    dye.className = "screen-dye";
    dye.value = prefs.railColours[screen.name] ?? accentNow();
    dye.setAttribute("aria-label", `Colour for ${screen.label}`);
    dye.oninput = () => {
      prefs.railColours = { ...prefs.railColours, [screen.name]: dye.value };
      savePrefs();
    };
    /* Right-click clears it back to the accent — a colour input has no "none",
     * and a reset button per row is nine buttons for a thing done twice. */
    const tones = document.createElement("div");
    tones.className = "screen-tones";
    for (const tone of TONES) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "screen-tone";
      dot.style.background = tone;
      dot.style.color = tone;
      dot.setAttribute("aria-label", `${screen.label}: ${tone}`);
      if ((prefs.railColours[screen.name] ?? "").toLowerCase() === tone) {
        dot.classList.add("is-on");
      }
      dot.onclick = () => {
        prefs.railColours = { ...prefs.railColours, [screen.name]: tone };
        savePrefs();
        paintScreens();
      };
      tones.append(dot);
    }

    dye.oncontextmenu = event => {
      event.preventDefault();
      const rest = { ...prefs.railColours };
      delete rest[screen.name];
      prefs.railColours = rest;
      dye.value = accentNow();
      savePrefs();
    };

    row.append(grip, text, tones, dye, box);
    host.append(row);
  }
}

/* ── Reordering ──────────────────────────────────────────────────────
 * ⚠️ POINTER events, not HTML5 drag and drop. The first version used the
 * platform's own drag — it brings auto-scroll and a drop cursor for free — and
 * it does not work here at all: Tauri intercepts drag events at the window to
 * implement file drop, so `dragstart` never reaches the page and the rows
 * simply do not move. It works perfectly in a browser, which is exactly what
 * makes it the wrong choice: the bug only exists in the app.
 *
 * ⚠️ And the row is reordered LIVE rather than on release, so the list under
 * the pointer is the list you are arranging. A preview that only resolves when
 * you let go is a guess you have to check afterwards. */
let carrying: string | null = null;
let carriedFrom = 0;

function rowUnder(y: number): HTMLElement | null {
  const rows = [...get("rail-screens").querySelectorAll<HTMLElement>(".screen-row")];
  return rows.find(row => {
    const box = row.getBoundingClientRect();
    return y >= box.top && y <= box.bottom;
  }) ?? null;
}

get("rail-screens").addEventListener("pointerdown", event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".screen-row");
  /* ⚠️ Not from the switch. It sits inside the row, and a press on it that
   * moved a pixel would start a drag instead of toggling — which is most
   * presses on a 22px target. */
  if (!row || (event.target as HTMLElement).closest("input")) return;
  carrying = row.dataset.screen ?? null;
  carriedFrom = event.clientY;
});

get("rail-screens").addEventListener("pointermove", event => {
  if (!carrying) return;
  const row = get("rail-screens")
    .querySelector<HTMLElement>(`.screen-row[data-screen="${carrying}"]`);
  /* ⚠️ Four pixels of slop before it counts as carrying, or every press on a
   * row is a one-pixel drag and the list twitches under the finger. */
  if (!row?.classList.contains("is-lifting")) {
    if (Math.abs(event.clientY - carriedFrom) < 4) return;
    row?.classList.add("is-lifting");
    /* Captured only once it IS a drag, so a press that turns out to be a click
     * on the switch still reaches it. */
    get("rail-screens").setPointerCapture(event.pointerId);
  }

  const over = rowUnder(event.clientY);
  if (!over || over.dataset.screen === carrying) return;
  const order = screenOrder().map(one => one.name);
  const from = order.indexOf(carrying);
  const to = order.indexOf(over.dataset.screen ?? "");
  if (from < 0 || to < 0) return;
  order.splice(to, 0, ...order.splice(from, 1));
  prefs.railOrder = order;
  paintScreens();
  // The rows were rebuilt, so the one being carried has to be marked again.
  get("rail-screens")
    .querySelector(`.screen-row[data-screen="${carrying}"]`)?.classList.add("is-lifting");
});

for (const done of ["pointerup", "pointercancel"] as const) {
  get("rail-screens").addEventListener(done, event => {
    if (!carrying) return;
    const moved = get("rail-screens").querySelector(".screen-row.is-lifting");
    carrying = null;
    if (!moved) return;
    moved.classList.remove("is-lifting");
    if (get("rail-screens").hasPointerCapture(event.pointerId)) {
      get("rail-screens").releasePointerCapture(event.pointerId);
    }
    savePrefs();
  });
}

const railGrip = get<HTMLInputElement>("rail-grip");
railGrip.oninput = () => {
  prefs.railGrip = Number(railGrip.value);
  get("rail-grip-value").textContent = `${prefs.railGrip}%`;
  savePrefs();
};
const railSharp = get<HTMLInputElement>("rail-sharp");
railSharp.oninput = () => {
  prefs.railSharp = Number(railSharp.value);
  get("rail-sharp-value").textContent = prefs.railSharp ? `${prefs.railSharp}` : "none";
  savePrefs();
};

const panelWidth = get<HTMLInputElement>("panel-width");
/** ⚠️ 0 is "the default", not "zero pixels" — and the gap between 0 and the
 *  narrowest sensible panel is what stops a drag landing on an island two
 *  pixels wide. Anything under the floor snaps back to the default. */
const WIDTH_FLOOR = 520;
function widthLabel(value: number) {
  return value === 0 ? "Default" : `${value} px`;
}
panelWidth.oninput = () => {
  const raw = Number(panelWidth.value);
  prefs.panelWidth = raw < WIDTH_FLOOR ? 0 : raw;
  get("panel-width-value").textContent = widthLabel(prefs.panelWidth);
  savePrefs();
};

onSeg("view", value => { prefs.taskView = value; savePrefs(); });

/* ── The pill ────────────────────────────────────────────────────────── */

for (const module of MODULES) {
  const host = element("div", "set-row");
  const text = element("div", "");
  text.append(element("b", "", module.title));
  if (module.note) text.append(element("span", "", module.note));
  const left = element("div", "set-text mod-row");
  left.append(taskIcon(module.icon), text);
  const box = document.createElement("input");
  box.type = "checkbox"; box.className = "switch"; box.dataset.module = module.id;
  box.onchange = () => {
    prefs.mutedModules = box.checked
      ? prefs.mutedModules.filter(id => id !== module.id)
      : [...new Set([...prefs.mutedModules, module.id])];
    savePrefs();
  };
  const ctl = element("div", "set-ctl");
  ctl.append(box);
  host.append(left, ctl);
  get("modules").append(host);
}

for (const threshold of THRESHOLDS) {
  const host = element("div", "set-row");
  const text = element("div", "set-text");
  text.append(element("b", "", threshold.title), element("span", "", `Says nothing below this.`));
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = "50"; slider.max = "100"; slider.step = "1";
  slider.dataset.threshold = threshold.id;
  const value = element("span", "set-value");
  slider.oninput = () => {
    prefs.thresholds = { ...prefs.thresholds, [threshold.id]: Number(slider.value) };
    value.textContent = `${slider.value}%`;
    savePrefs();
  };
  const ctl = element("div", "set-ctl");
  ctl.append(slider, value);
  host.append(text, ctl);
  get("thresholds").append(host);
}

async function paintSnoozed() {
  const snoozed = await call<Record<string, number>>("get_snoozed").catch(() => ({}));
  const count = Object.keys(snoozed).length;
  get("snoozed-note").textContent = count
    ? `${count} thing${count === 1 ? "" : "s"} quietened.`
    : "Nothing is quietened.";
  get<HTMLButtonElement>("unsnooze").disabled = count === 0;
}
get("unsnooze").onclick = async () => {
  await run("unsnooze", { key: "" }, "Everything is back.");
  await paintSnoozed();
};

/* ── Search ──────────────────────────────────────────────────────────── */

get<HTMLInputElement>("use-everything").onchange = event => {
  prefs.useEverything = (event.target as HTMLInputElement).checked;
  savePrefs();
};
get<HTMLInputElement>("index-apps").onchange = event => {
  prefs.indexApps = (event.target as HTMLInputElement).checked;
  savePrefs();
};

async function paintEverything() {
  const running = await call<boolean>("everything_running").catch(() => false);
  get("everything-note").textContent = running
    ? "Everything is running on this PC."
    : "Everything is not running. Install it from voidtools.com, or leave this off.";
}

/* ── Shortcuts ───────────────────────────────────────────────────────────
 * ⚠️ Every field, every time. `set_shortcuts` registers the whole set or none
 * of it, so a form sending a subset does not save part of it — it fails
 * outright on a missing argument. This window sent two of six for a while,
 * which meant saving a shortcut silently did nothing at all. */
let keys: Shortcuts = { palette: "", toggle: "", capture: "", shelf: "", display: "", hide: "" };
let listening: KeyId | null = null;

/** The accelerator Windows will actually take, built from the physical key
 *  rather than from `event.key` — `event.key` on a Polish layout is already
 *  the character the modifiers produced, which is not what gets registered. */
function accelerator(event: KeyboardEvent): string | null {
  const code = event.code;
  let main = "";
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3);
  else if (/^Digit\d$/.test(code)) main = code.slice(5);
  else if (/^Numpad\d$/.test(code)) main = code;
  else if (/^F\d{1,2}$/.test(code)) main = code;
  else if (code === "Space" || code === "Enter" || code === "Tab" || code === "Backspace"
    || code === "Delete" || code === "Insert" || code === "Home" || code === "End"
    || code === "PageUp" || code === "PageDown") main = code;
  else if (code.startsWith("Arrow")) main = code.slice(5);
  if (!main) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  // A bare letter is not a global shortcut, it is a keyboard that has stopped
  // typing that letter.
  if (parts.length === 0) return null;
  parts.push(main);
  return parts.join("+");
}

function altGrWarning(combo: string): string {
  const parts = combo.split("+");
  const letter = parts[parts.length - 1];
  if (!combo.includes("Ctrl") || !combo.includes("Alt") || combo.includes("Shift")) return "";
  if (letter.length !== 1 || !ALTGR_LETTERS.includes(letter)) return "";
  return `Ctrl+Alt+${letter} is AltGr+${letter}. On a Polish layout this takes that character away everywhere on the machine.`;
}

function paintKey(id: KeyId) {
  const button = get<HTMLButtonElement>(`key-${id}`);
  button.replaceChildren();
  button.classList.toggle("is-listening", listening === id);
  button.classList.toggle("is-warn", !!altGrWarning(keys[id]));
  const text = listening === id ? "Press a combination…" : keys[id] || "Not set";
  if (listening === id || !keys[id]) {
    button.append(element("span", "", text));
  } else {
    for (const part of keys[id].split("+")) button.append(element("kbd", "", part));
  }
}

function paintAltGr() {
  const warnings = KEYS.map(k => altGrWarning(keys[k.id])).filter(Boolean);
  const note = get("altgr-note");
  note.hidden = warnings.length === 0;
  note.textContent = warnings[0] ?? "";
}

async function sendKeys() {
  if (await run("set_shortcuts", { ...keys }, "Shortcuts saved.")) { paintAltGr(); return; }
  // A rejected set rolls back in Rust; show what actually stuck.
  await paintKeys();
}

for (const spec of KEYS) {
  const host = element("div", "set-row");
  const text = element("div", "set-text");
  text.append(element("b", "", spec.title));
  if (spec.note) text.append(element("span", "", spec.note));
  const button = element("button", "key-record");
  button.id = `key-${spec.id}`;
  (button as HTMLButtonElement).type = "button";
  button.onclick = () => {
    listening = listening === spec.id ? null : spec.id;
    for (const k of KEYS) paintKey(k.id);
  };
  const ctl = element("div", "set-ctl");
  ctl.append(button);
  host.append(text, ctl);
  get("keys").append(host);
}

/* ⚠️ Captured, not bubbled. A recorder that listens on the button loses every
 * combination the browser handles first — Tab moves focus, Space presses the
 * button again, Ctrl+A selects the page. */
document.addEventListener("keydown", event => {
  if (!listening) {
    if (event.key === "Escape" && native) getCurrentWindow().close();
    return;
  }
  if (event.key === "Escape") {
    listening = null;
    for (const k of KEYS) paintKey(k.id);
    return;
  }
  const combo = accelerator(event);
  if (!combo) { event.preventDefault(); return; }
  event.preventDefault();
  event.stopPropagation();
  const target = listening;
  listening = null;
  keys[target] = combo;
  for (const k of KEYS) paintKey(k.id);
  void sendKeys();
}, true);

async function paintKeys() {
  try {
    const current = await call<Shortcuts>("get_shortcuts");
    for (const spec of KEYS) keys[spec.id] = current[spec.id] ?? "";
  } catch { /* the plugin failed to start; the rows say "Not set" */ }
  for (const spec of KEYS) paintKey(spec.id);
  paintAltGr();
}

get("keys-default").onclick = async () => {
  /* ⚠️ Rust owns the defaults — see the AltGr note in `shortcuts.rs` for why
   * they are the letters they are. Sending an empty set is what asks for
   * them back. */
  if (await run("set_shortcuts", {
    palette: "Ctrl+Alt+K", toggle: "Ctrl+Alt+Space", capture: "Ctrl+Alt+T",
    shelf: "Ctrl+Alt+V", display: "Ctrl+Alt+M", hide: "Ctrl+Alt+H",
  }, "Back to the defaults.")) await paintKeys();
};

/* ── Connections ─────────────────────────────────────────────────────── */

let snapshot = emptySnapshot();

function paintTickTick() {
  get("ticktick-state").textContent = snapshot.demo
    ? "Sample tasks · not connected"
    : snapshot.connected
      ? `Connected${snapshot.updatedAt ? ` · synced ${new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · loading…"}`
      : "Not connected";
  get<HTMLButtonElement>("ticktick-disconnect").disabled = !snapshot.connected;
  if (snapshot.error) say(snapshot.error, "error");
}

get("ticktick-connect").onclick = async () => {
  const field = get<HTMLInputElement>("token");
  const value = field.value;
  // Cleared before the await: the field must not hold a token while a slow
  // request is in flight, and it must not hold one afterwards either.
  field.value = "";
  if (!value.trim()) { say("Paste a token first.", "error"); return; }
  await run("connect_ticktick", { token: value }, "TickTick connected.");
};
get("ticktick-disconnect").onclick = () => void run("disconnect_ticktick", {}, "TickTick disconnected.");

async function paintSpotify() {
  const connected = await call<boolean>("spotify_status").catch(() => false);
  get("spotify-state").textContent = connected
    ? "Connected · the player shows what is next"
    : "Not connected · the player has no queue";
  get<HTMLButtonElement>("spotify-disconnect").disabled = !connected;
  get("spotify-redirect").textContent = await call<string>("spotify_redirect").catch(() => "");
}

get("spotify-connect").onclick = async () => {
  say("Waiting for Spotify in your browser…");
  if (await run("connect_spotify", { clientId: get<HTMLInputElement>("spotify-id").value })) {
    say("Spotify connected.", "good");
  }
  await paintSpotify();
};
get("spotify-disconnect").onclick = async () => {
  await run("disconnect_spotify", {}, "Spotify disconnected.");
  await paintSpotify();
};
get("spotify-copy").onclick = async () => {
  /* ⚠️ Through Rust, not `navigator.clipboard`. The settings window can lose
   * focus between the press and the write, and the browser API rejects on an
   * unfocused document — silently, in a way that looks like the button doing
   * nothing. Same reason the shelf copies this way. */
  await run("copy_text", { text: get("spotify-redirect").textContent ?? "" }, "Redirect URI copied.");
};

async function paintGoogle() {
  const connected = await call<boolean>("google_status").catch(() => false);
  get("google-state").textContent = connected
    ? "Connected · events refresh every five minutes"
    : "Not connected · the Calendar screen is empty";
  get<HTMLButtonElement>("google-disconnect").disabled = !connected;
}

get("google-connect").onclick = async () => {
  const id = get<HTMLInputElement>("google-id"), secret = get<HTMLInputElement>("google-secret");
  say("Waiting for Google in your browser…");
  if (await run("connect_google", { clientId: id.value, clientSecret: secret.value })) {
    // Only the secret is cleared: leaving the ID makes a re-connect one field.
    secret.value = "";
    say("Google Calendar connected.", "good");
  }
  await paintGoogle();
};
get("google-disconnect").onclick = async () => {
  await run("disconnect_google", {}, "Google Calendar disconnected.");
  await paintGoogle();
};

type Weather = { place: string; celsius: number; summary: string } | null;

/** Kept so changing the unit can rewrite the line without asking again — the
 *  lookup is a network call, and a unit switch is not a reason to make one. */
let lastWeather: Weather = null;

function sayWeather(reading: Weather) {
  lastWeather = reading;
  // The same unit the pill uses, converted the same way — see pill-modules.ts
  // on why Celsius is what is stored.
  const degrees = reading && (prefs.fahrenheit
    ? Math.round(reading.celsius * 9 / 5 + 32)
    : reading.celsius);
  get("weather-state").textContent = reading
    ? `${reading.place} · ${degrees}° ${reading.summary.toLowerCase()}`
    : "Off — nothing is requested";
  // The resolved spelling, not what was typed: "krakow" comes back "Kraków",
  // which is how you can tell it found the right place and not a same-named
  // town somewhere else.
  if (reading) get<HTMLInputElement>("weather-place").value = reading.place;
}

get("weather-set").onclick = async () => {
  say("Looking it up…");
  try {
    sayWeather(await call<Weather>("set_weather_place", { place: get<HTMLInputElement>("weather-place").value }));
    say("");
  } catch (error) { say(String(error), "error"); }
};
get("weather-clear").onclick = async () => {
  get<HTMLInputElement>("weather-place").value = "";
  if (await run("set_weather_place", { place: "" })) sayWeather(null);
};

/* ── Boot ────────────────────────────────────────────────────────────── */

function paintPrefs() {
  applyAccent(prefs.accent);
  markSeg("units", prefs.fahrenheit ? "f" : "c");
  markSeg("week", prefs.weekStartsMonday ? "mon" : "sun");
  markSeg("motion", prefs.motion);
  markSeg("view", prefs.taskView === "all" ? "all" : "day");
  get<HTMLInputElement>("open-on-hover").checked = prefs.openOnHover;
  get<HTMLInputElement>("rail-always").checked = prefs.railAlways;
  get<HTMLInputElement>("rail-flat").checked = prefs.railFlat;
  paintScreens();
  get<HTMLInputElement>("notify-runs").checked = prefs.notifyRuns;
  get<HTMLInputElement>("use-everything").checked = prefs.useEverything;
  get<HTMLInputElement>("index-apps").checked = prefs.indexApps;
  foldDelay.value = String(prefs.foldDelayMs);
  get("fold-delay-value").textContent = `${(prefs.foldDelayMs / 1000).toFixed(2)}s`;
  railGrip.value = String(prefs.railGrip || 100);
  get("rail-grip-value").textContent = `${prefs.railGrip || 100}%`;
  railSharp.value = String(prefs.railSharp || 0);
  get("rail-sharp-value").textContent = prefs.railSharp ? `${prefs.railSharp}` : "none";
  railVisible.value = String(prefs.railVisible || 5);
  get("rail-visible-value").textContent = `${prefs.railVisible || 5}`;
  panelWidth.value = String(prefs.panelWidth || 0);
  get("panel-width-value").textContent = widthLabel(prefs.panelWidth);
  for (const box of document.querySelectorAll<HTMLInputElement>("[data-module]")) {
    box.checked = !prefs.mutedModules.includes(box.dataset.module!);
  }
  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-threshold]")) {
    const id = slider.dataset.threshold!;
    const value = prefs.thresholds[id] ?? THRESHOLDS.find(t => t.id === id)!.fallback;
    slider.value = String(value);
    slider.nextElementSibling!.textContent = `${value}%`;
  }
}

async function boot() {
  const wanted = location.hash.slice(1) as PaneId;
  show(PANES.some(p => p.id === wanted) ? wanted : "general", false);

  try { prefs = await call<Prefs>("get_prefs"); } catch { /* the defaults above */ }
  paintPrefs();

  const placement = await call<{ edge: string; visible: boolean; clock24?: boolean }>("get_task_placement")
    .catch(() => ({ edge: "top", visible: true } as { edge: string; visible: boolean; clock24?: boolean }));
  edge = placement.edge; visible = placement.visible;
  clock24 = placement.clock24 ?? true;
  markSeg("edge", edge);
  markSeg("clock", clock24 ? "24" : "12");
  get<HTMLInputElement>("notch-visible").checked = visible;

  get<HTMLInputElement>("autostart").checked = await call<boolean>("get_autostart").catch(() => false);

  await watchTasks(value => { snapshot = value; paintTickTick(); });
  await Promise.all([paintDisplays(), paintProviders(), paintGoogle(), paintSpotify(),
    paintKeys(), paintSnoozed(), paintEverything()]);
  try { sayWeather(await call<Weather>("get_weather")); } catch { sayWeather(null); }

  if (preview) say("Interactive preview · nothing here is saved.");
}

boot().catch(error => say(String(error), "error"));
