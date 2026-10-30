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
import { withBoards } from "./screens";
import {
  BOARD_ICONS, freshId, normalise as normaliseBoards, DEFAULT_BOARD_CAP, type Board,
} from "./boards";
/* ⚠️ `widgets.ts` is DATA — every import in it is a type, so this pulls no
 * screen into the settings bundle. See the note at the top of it. */
import { widgetsOf } from "./widgets";
import { taskIcon, type TaskIcon } from "./task-icons";
import { ringChoices } from "./ring-geometry";
import "./tasks.css";
import { mountPeeks, PEEKS_PANE_HTML, type PeekQuiet } from "./settings-peeks";

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
  boards: Board[];
  boardCap: number;
  noticeMode: boolean;
  timerSound: string;
  pomodoroPill: string;
  ringStops: string[];
  ringGlass: boolean;
  ringHoldMs: number;
  ringTap: string;
  homeCurrency: string;
  followLive: boolean;
  pomodoroWork: number;
  pomodoroBreak: number;
  pomodoroLong: number;
  callMode: boolean;
  callMuteMic: boolean;
  callOpen: boolean;
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
  /** The sound a Guardian nudge makes. */
  helmSound: string;
  /** The Guardian's replies to a hold to talk, out loud. */
  spokenReplies: boolean;
  /** Batch 13: peek kinds switched off (`false`; missing = on), and quiet hours. */
  peeks: Record<string, boolean>;
  peekQuiet: PeekQuiet | null;
}

interface Screen { id: string; name: string; width: number; height: number; primary: boolean }
interface Displays { screens: Screen[]; notch: string | null; tasks: string | null }
interface Reading { displayName: string; status: { state: string; message?: string } }

const PANES = [
  { id: "general", icon: "settings", label: "General", sub: "Startup, displays and what Codenotch is reading." },
  { id: "appearance", icon: "sun", label: "Appearance", sub: "The one colour everything is tinted by, and how numbers are written." },
  { id: "island", icon: "home", label: "Island", sub: "Where the panel lives and what it takes to open it." },
  { id: "pill", icon: "clock", label: "The pill", sub: "What the strip says, and what it does during a call." },
  { id: "peeks", icon: "bell", label: "Peeks", sub: "News that borrows the pill for a few seconds." },
  { id: "timer", icon: "timer", label: "Timer", sub: "How long a pomodoro runs, and what it plays when it ends." },
  { id: "search", icon: "search", label: "Search", sub: "What the command palette is allowed to look through." },
  { id: "keys", icon: "keyboard", label: "Shortcuts", sub: "Global, so they work while another app has focus." },
  { id: "accounts", icon: "link", label: "Connections", sub: "Helm, TickTick, Google Calendar, Spotify and the forecast." },
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

/* ⚠️ TWO, where there were seven. Every global shortcut is a combination
 * taken away from every other application on the machine, and six of the seven
 * were doors into things one key already opens: tap it for the palette, hold
 * it for the ring, and everything that had a key of its own is a wedge or a
 * row away. A list of shortcuts that grows is the problem the ring was built
 * to end — it should not have gone on growing beside it. */
const KEYS = [
  { id: "ring", title: "Search, and the ring",
    note: "Tap it for the palette. Hold it and the ring comes up under the pointer." },
  { id: "hide", title: "Hide everything", note: "Takes both notches off screen." },
  /* ⚠️ The one key added back (28 Oct, his call) — see DEFAULT_CAPTURE in
   * shortcuts.rs on why capture earns a chord of its own. */
  { id: "capture", title: "Tell the Guardian", note: "One line to Helm from anywhere." },
  /* Held, not pressed (29 Oct): see DEFAULT_TALK in shortcuts.rs on why it is
   * two keys and never Ctrl+Alt. */
  { id: "talk", title: "Talk to the Guardian", note: "Hold it in any app and speak, let go to send; tap it to talk hands-free." },
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

/* ── The panes ───────────────────────────────────────────────────────────
 *
 * ⚠️ **A description under every row is a wall nobody reads.** Forty rows each
 * explaining themselves is forty sentences competing with the forty controls
 * they are about — and the ones that actually needed saying were lost among
 * them. A note is kept only where the control cannot say it: where the
 * consequence is invisible (a token leaves the machine, a service matches a
 * string character for character) or where nothing on screen implies it.
 *
 * ⚠️ And the sections are grouped by what somebody came to change, not by
 * which file implements it. The pomodoro's lengths and the call's controls
 * were both under "Island" because the island is where they are drawn, which
 * made that pane a list of fifty switches and the other panes nearly empty.
 */
const PANE_HTML: Record<PaneId, string> = {
  general: `
    <div><p class="set-label">Startup</p><div class="set-group">
      ${row("Start with Windows", "", check("autostart"))}
      ${row("Tell me when a run finishes", "", check("notify-runs"))}
    </div></div>
    <div id="displays-group" hidden><p class="set-label">Displays</p><div class="set-group">
      ${row("Island", "", `<select id="display-tasks"></select>`)}
      ${row("Usage notch", "", `<select id="display-notch"></select>`)}
    </div></div>
    <div><p class="set-label">Tasks</p><div class="set-group">
      ${row("Tasks showing", "", seg("view", [["day", "Today"], ["all", "All lists"]], "Task view"))}
    </div></div>
    <div><p class="set-label">Codenotch</p><div class="set-group">
      ${row("Reading", "", `<span class="set-value" id="providers" style="min-width:0;text-align:right">…</span>`)}
      ${row("Position", "Drag either notch along its edge to move it.", `<button type="button" class="set-btn" id="reset-position">Reset</button>`)}
      ${row("Log", "", `<button type="button" class="set-btn" id="open-log">Open log</button>`)}
      ${row("Quit", "", `<button type="button" class="set-btn is-danger" id="quit">Quit Codenotch</button>`)}
    </div></div>`,

  appearance: `
    <div><p class="set-label">Accent</p><div class="set-group">
      ${row("Colour", "",
        `<div class="swatches" id="swatches">${ACCENTS.map(c => `<button type="button" class="swatch" data-accent="${c}" style="background:${c};color:${c}" aria-label="${c}" aria-pressed="false"></button>`).join("")}<input type="color" id="accent-custom" aria-label="Any other colour"></div>`, "stack")}
    </div></div>
    <div><p class="set-label">Clock and units</p><div class="set-group">
      ${row("Clock", "", seg("clock", [["24", "24 h"], ["12", "12 h"]], "Clock format"))}
      ${row("Week starts on", "", seg("week", [["mon", "Monday"], ["sun", "Sunday"]], "First day of the week"))}
      ${row("Temperature", "", seg("units", [["c", "°C"], ["f", "°F"]], "Temperature units"))}
      ${row("Animations", "", seg("motion", [["system", "System"], ["always", "Always"], ["never", "Never"]], "Animation"))}
    </div></div>`,

  island: `
    <div><p class="set-label">Where it lives</p><div class="set-group">
      ${row("Screen edge", "", seg("edge", [["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]], "Screen edge"))}
      ${row("Show the island", "", check("notch-visible"))}
      ${row("Panel width", "",
        `<input type="range" id="panel-width" min="0" max="1100" step="20"><span class="set-value" id="panel-width-value"></span>`)}
    </div></div>
    <div><p class="set-label">Opening</p><div class="set-group">
      ${row("Open on hover", "", check("open-on-hover"))}
      ${row("Open on what is happening", "A call, an agent waiting, a meeting about to start.", check("follow-live"))}
      ${row("Stays open for", "",
        `<input type="range" id="fold-delay" min="120" max="2000" step="20"><span class="set-value" id="fold-delay-value"></span>`)}
    </div></div>
    <div><p class="set-label">The rail</p><div class="set-group">
      ${row("Screens on the rail", "",
        `<input type="range" id="rail-visible" min="3" max="7" step="1"><span class="set-value" id="rail-visible-value"></span>`)}
      ${row("Kept sharp", "",
        `<input type="range" id="rail-sharp" min="0" max="3" step="1"><span class="set-value" id="rail-sharp-value"></span>`)}
      ${row("Drag strength", "",
        `<input type="range" id="rail-grip" min="50" max="300" step="10"><span class="set-value" id="rail-grip-value"></span>`)}
      ${row("Always show them", "", check("rail-always"))}
      ${row("Show them all", "Every screen at once, instead of one to drag between.", check("rail-flat"))}
    </div></div>
    <div><p class="set-label">Boards</p>
    <p class="set-why">A board is a row of cards, and Home is one of them. To change what is on one, open it and press the grid on the island’s arc.</p>
    <div id="boards"></div>
    <button type="button" class="set-add" id="board-add">New board</button></div>
    <div><p class="set-label">Screens</p>
    <p class="set-why">Drag to reorder. Switched off, a screen leaves the rail and stays in the palette.</p>
    <div class="set-group" id="rail-screens">
    </div></div>
    <div><p class="set-label">The ring</p>
    <p class="set-why">Tap the key for one thing; hold it to bring the ring up, aim, and let go to pick.</p>
    <div class="set-group">
      ${row("A tap does", "", `<select id="ring-tap"></select>`)}
      ${row("Hold to open the ring", "",
        `<input type="range" id="ring-hold" min="120" max="800" step="10"><span class="set-value" id="ring-hold-value"></span>`)}
      ${row("Frosted", "", check("ring-glass"))}
    </div>
    <p class="set-why">Eight at most — nothing chosen means the screens on your rail.</p>
    <div id="ring-stops"></div></div>`,

  pill: `
    <div><p class="set-label">What it may say</p><div class="set-group" id="modules"></div></div>
    <div><p class="set-label">When it speaks up</p><div class="set-group" id="thresholds"></div>
      <p class="set-note">A disk that lives above 95% is a fact about the machine, not news.</p></div>
    <div><p class="set-label">In a call</p><div class="set-group">
      ${row("Watch for calls", "Zoom, Teams, Meet, WhatsApp, Discord, Slack.", check("call-mode"))}
      ${row("Mute the microphone too", "", check("call-mute-mic"))}
      ${row("Go to the call", "", check("call-open"))}
    </div>
    <p class="set-note">Controls are the app’s own shortcuts, so its window comes forward for an instant when you press one.</p></div>
    <div><p class="set-label">Notifications</p><div class="set-group">
      ${row("Mirror the notification centre", "", check("notice-mode"))}
    </div>
    <p class="set-note">Dismissing one here dismisses it in Windows too — Codenotch keeps no copy.</p></div>
    <div><p class="set-label">Snoozed</p><div class="set-group">
      ${row("Quietened", "", `<button type="button" class="set-btn" id="unsnooze">Bring back</button>`)}
    </div><p class="set-note" id="snoozed-note"></p></div>`,

  peeks: PEEKS_PANE_HTML,

  timer: `
    <div><p class="set-label">Pomodoro</p><div class="set-group">
      ${row("Focus", "",
        `<input type="range" id="pom-work" min="5" max="90" step="5"><span class="set-value" id="pom-work-value"></span>`)}
      ${row("Break", "",
        `<input type="range" id="pom-break" min="1" max="30" step="1"><span class="set-value" id="pom-break-value"></span>`)}
      ${row("Long break", "After every fourth one.",
        `<input type="range" id="pom-long" min="5" max="60" step="5"><span class="set-value" id="pom-long-value"></span>`)}
    </div></div>
    <div><p class="set-label">While it runs</p><div class="set-group">
      ${row("On the notch", "",
        seg("pompill", [["bar", "A line"], ["time", "The time"]], "Pomodoro on the pill"))}
      ${row("Sound", "",
        seg("sound", [["", "None"], ["Notification.Default", "Chime"],
          ["Notification.Reminder", "Calendar"], ["Notification.Looping.Alarm", "Alarm"]],
          "Timer sound"))}
    </div>
    <p class="set-note">Windows’ own sounds — nothing is shipped. A finished pomodoro starts its break; a finished break waits for you.</p></div>`,

  search: `
    <div><p class="set-label">Files</p><div class="set-group">
      ${row("Use Everything", "", check("use-everything"))}
    </div><p class="set-note" id="everything-note"></p></div>
    <div><p class="set-label">Applications</p><div class="set-group">
      ${row("Index the Start Menu", "", check("index-apps"))}
    </div>
    <p class="set-note">Off, the palette cannot launch applications — and start-up is a second and a half quicker.</p></div>
    <div><p class="set-label">Money</p><div class="set-group">
      ${row("Your currency", "So `120 usd` on its own has an answer. Two named currencies never need it.",
        `<input id="home-currency" autocomplete="off" spellcheck="false" maxlength="3"
          placeholder="PLN" style="text-transform:uppercase;width:5.5rem">`)}
    </div></div>`,

  keys: `
    <div><p class="set-label">Global shortcuts</p><div class="set-group" id="keys"></div>
      <p class="set-note">Click one, then press the combination. Esc cancels. Windows refuses what another app already owns.</p>
      <p class="set-note is-warn" id="altgr-note" hidden></p></div>
    <div><div class="set-group">
      ${row("Back to the defaults", "", `<button type="button" class="set-btn" id="keys-default">Restore defaults</button>`)}
    </div></div>`,

  accounts: `
    <div><p class="set-label">Helm</p><div class="set-group">
      ${row("Now", "", `<span class="set-value" id="helm-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("Sign in", "Helm emails you a code. The session and this PC's key are kept in Windows Credential Manager and never read back.",
        `<input id="helm-url" autocomplete="off" spellcheck="false" maxlength="200" placeholder="https://crm.hadastudios.com" value="https://crm.hadastudios.com"><input id="helm-email" type="email" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Your email"><button type="button" class="set-btn is-accent" id="helm-send">Send code</button>`, "stack")}
      ${row("Code", "The digits from the email.",
        `<input id="helm-code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="Code"><button type="button" class="set-btn is-accent" id="helm-sign-in">Sign in</button><button type="button" class="set-btn" id="helm-disconnect">Disconnect</button>`, "stack")}
      ${row("Nudge sound", "Plays when the Guardian nudges, and once more three minutes later if it is still unread.",
        seg("helmsound", [["", "None"], ["Notification.Default", "Chime"],
          ["Notification.Reminder", "Calendar"], ["Notification.Looping.Alarm", "Alarm"]], "Guardian nudge sound"))}
      ${row("Spoken replies", "The Guardian answers out loud when you hold to talk. Never in a call, a meeting or while presenting.", check("spoken-replies"))}
    </div><p class="set-note">While Helm is connected, Today is Helm’s day and the Guardian lives on the island: its nudges, which stay up over full-screen apps until answered, and the chat.</p></div>
    <div><p class="set-label">TickTick</p><div class="set-group">
      ${row("Account", "", `<span class="set-value" id="ticktick-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("API token", "Settings → Account → API Token on the web. Kept in Windows Credential Manager and never read back.",
        `<input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="2500" placeholder="Paste your token"><button type="button" class="set-btn is-accent" id="ticktick-connect">Connect</button><button type="button" class="set-btn" id="ticktick-disconnect">Disconnect</button>`, "stack")}
    </div></div>
    <div><p class="set-label">Google Calendar</p><div class="set-group">
      ${row("Calendar", "", `<span class="set-value" id="google-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("OAuth client", "A <strong>Desktop app</strong> client with the Calendar API on. Connecting opens your browser; Codenotch asks only to read.",
        `<input id="google-id" autocomplete="off" spellcheck="false" maxlength="400" placeholder="…apps.googleusercontent.com"><input id="google-secret" type="password" autocomplete="off" maxlength="400" placeholder="Client secret"><button type="button" class="set-btn is-accent" id="google-connect">Connect</button><button type="button" class="set-btn" id="google-disconnect">Disconnect</button>`, "stack")}
    </div></div>
    <div><p class="set-label">Spotify</p><div class="set-group">
      ${row("Queue", "", `<span class="set-value" id="spotify-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("Client ID", "Only for “Playing next” — everything else comes from Windows.",
        `<input id="spotify-id" autocomplete="off" spellcheck="false" maxlength="200" placeholder="32 hex characters"><button type="button" class="set-btn is-accent" id="spotify-connect">Connect</button><button type="button" class="set-btn" id="spotify-disconnect">Disconnect</button>`, "stack")}
      ${row("Redirect URI", "Spotify matches this character for character, port included.",
        `<code class="set-code" id="spotify-redirect">…</code><button type="button" class="set-btn" id="spotify-copy">Copy</button>`)}
    </div></div>
    <div><p class="set-label">Ambient mode</p><div class="set-group">
      ${row("Your scenes", "Videos and stills from one folder, offered beside the generated rooms. Nothing outside it is ever read.",
        `<span class="set-value" id="ambient-folder" style="min-width:0;text-align:right">…</span><button type="button" class="set-btn is-accent" id="ambient-pick">Choose folder…</button><button type="button" class="set-btn" id="ambient-clear">Clear</button>`, "stack")}
    </div></div>
    <div><p class="set-label">Weather</p><div class="set-group">
      ${row("Place", "Left empty, nothing is ever requested.",
        `<input id="weather-place" autocomplete="off" spellcheck="false" maxlength="120" placeholder="Kraków"><button type="button" class="set-btn is-accent" id="weather-set">Use this place</button><button type="button" class="set-btn" id="weather-clear">Turn off</button>`, "stack")}
      ${row("Now", "", `<span class="set-value" id="weather-state" style="min-width:0;text-align:right">…</span>`)}
    </div></div>
    <div><p class="set-label">Crypto</p><div class="set-group">
      ${row("Symbol", "A Binance pair, like BTCUSDT. Left empty, nothing is ever requested.",
        `<input id="crypto-symbol" autocomplete="off" spellcheck="false" maxlength="20" placeholder="BTCUSDT"><button type="button" class="set-btn is-accent" id="crypto-set">Follow this</button><button type="button" class="set-btn" id="crypto-clear">Turn off</button>`, "stack")}
      ${row("Now", "", `<span class="set-value" id="crypto-state" style="min-width:0;text-align:right">…</span>`)}
      ${row("Wallet", "Read-only API keys only. Make one in Binance under API Management with just <b>Enable Reading</b> ticked, and restrict it to this machine's IP. Codenotch never calls an endpoint that can trade or withdraw.",
        `<input id="binance-key" autocomplete="off" spellcheck="false" maxlength="128" placeholder="API key"><input id="binance-secret" type="password" autocomplete="off" spellcheck="false" maxlength="128" placeholder="Secret"><button type="button" class="set-btn is-accent" id="binance-connect">Connect</button><button type="button" class="set-btn" id="binance-disconnect">Disconnect</button>`, "stack")}
      ${row("Show in", "A currency Binance quotes — PLN, EUR, USDT. Everything is valued in USDT and converted once.",
        `<input id="wallet-quote" autocomplete="off" spellcheck="false" maxlength="8" placeholder="USDT"><button type="button" class="set-btn" id="wallet-quote-set">Use this</button>`, "stack")}
      ${row("Balance", "", `<span class="set-value" id="binance-state" style="min-width:0;text-align:right">…</span>`)}
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
  railVisible: 5, railAlways: true, railGrip: 100, railSharp: 0, railFlat: false, railOrder: [], railHidden: [], railColours: {}, boards: [], boardCap: DEFAULT_BOARD_CAP,
  useEverything: true, callMode: true, callMuteMic: true, callOpen: true,
  noticeMode: true, pomodoroWork: 25, pomodoroBreak: 5, pomodoroLong: 15,
  timerSound: "Notification.Reminder",
  pomodoroPill: "bar", ringStops: [], ringGlass: true, followLive: true,
  ringHoldMs: 250, ringTap: "@search", homeCurrency: "",
  indexApps: true, notifyRuns: true,
  mutedModules: [], thresholds: {}, taskView: "day",
  helmSound: "Notification.Reminder",
  spokenReplies: true,
  peeks: {}, peekQuiet: null,
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

/* ── Peeks (batch 13): settings-peeks.ts builds the pane ──────────────── */
const paintPeeks = mountPeeks(() => prefs, patch => { prefs = { ...prefs, ...patch } as Prefs; savePrefs(); });

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

/* How long the ring's key has to be held before the ring is drawn. Under it,
 * the press is a tap and does something else entirely. */
/* ⚠️ Three letters, upper-cased, or nothing. A half-typed code would have
 * the converter answering in "P" for as long as it took to type the rest. */
const homeCurrency = get<HTMLInputElement>("home-currency");
homeCurrency.oninput = () => {
  const said = homeCurrency.value.toUpperCase().replace(/[^A-Z]/g, "");
  homeCurrency.value = said;
  prefs.homeCurrency = said.length === 3 ? said : "";
  savePrefs();
};

const ringHold = get<HTMLInputElement>("ring-hold");
ringHold.oninput = () => {
  prefs.ringHoldMs = Number(ringHold.value);
  get("ring-hold-value").textContent = `${(prefs.ringHoldMs / 1000).toFixed(2)}s`;
  savePrefs();
};

const POMODORO = [
  ["pom-work", "pomodoroWork"], ["pom-break", "pomodoroBreak"], ["pom-long", "pomodoroLong"],
] as const;
for (const [id, key] of POMODORO) {
  const slider = get<HTMLInputElement>(id);
  slider.oninput = () => {
    prefs[key] = Number(slider.value);
    get(`${id}-value`).textContent = `${prefs[key]}m`;
    savePrefs();
  };
}

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

/* ⚠️ Three switches, one loop. They are the same shape and the same write,
 * and three copies of four lines is three places for one of them to save a
 * stale copy of the other two — the trap `set_prefs` is built around, one
 * layer up. */
for (const [id, key] of [
  ["call-mode", "callMode"], ["call-mute-mic", "callMuteMic"], ["call-open", "callOpen"],
  ["notice-mode", "noticeMode"], ["follow-live", "followLive"],
  ["ring-glass", "ringGlass"], ["spoken-replies", "spokenReplies"],
] as const) {
  get<HTMLInputElement>(id).onchange = event => {
    prefs[key] = (event.target as HTMLInputElement).checked;
    savePrefs();
  };
}

/* ── Which screens, and in what order ────────────────────────
 * ⚠️ The list is in `screens.ts` and is shared with the island and the ring.
 * It was a second hand-kept copy here, which meant a screen could be reordered
 * into a place it could not be shown. */

/** The screens in the order the preferences put them.
 *
 * ⚠️ Anything the preferences have not heard of keeps its built-in place at
 * the END rather than disappearing. A file written before a screen existed
 * must not hide it. */
function screenOrder(): { name: string; label: string }[] {
  /* ⚠️ Boards are in this list too, and have to be: a board is a screen — it
   * takes a rail stop, a colour and a switch exactly like a built-in one, and
   * all three come free the moment it is here. `withBoards` is the same splice
   * the island's rail and the ring read, so the three cannot disagree. */
  const all = [...withBoards(theBoards())];
  const rank = (name: string) => {
    const at = prefs.railOrder.indexOf(name);
    return at < 0 ? all.findIndex(s => s.name === name) + all.length : at;
  };
  return all.sort((a, b) => rank(a.name) - rank(b.name));
}

/* ── Boards ──────────────────────────────────────────────────────────────
 * A board is a row of widget cards. Home is the first of them and is not a
 * special case here either — it can be rearranged like any other; the only
 * thing it cannot do is be deleted, because it is where the island opens.
 *
 * ⚠️ Read through `theBoards()`, never `prefs.boards` directly. An empty list
 * on disk means "the built-in board", not "no boards" — see `normalise`. */
function theBoards(): Board[] {
  return normaliseBoards(prefs.boards);
}

/** Write the boards back, and redraw everything that shows them.
 *
 * ⚠️ The SCREENS list too. A board renamed, added or deleted changes a row in
 * the list below it, and redrawing only the board editor leaves a stale name
 * sitting in a list four rows further down the same pane. */
function setBoards(next: Board[]) {
  prefs.boards = next;
  savePrefs();
  paintBoards();
  paintScreens();
  paintRing();
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

/** What a TAP of the ring's key does.
 *
 * ⚠️ The same list the ring itself holds, plus the palette — a tap is the
 * ring's middle without the ring, so anything the ring can do it can do. The
 * palette leads because it is what most presses of that key were going to
 * anyway, which is the whole reason a tap stopped drawing a menu first.
 */
function paintTap() {
  const select = get<HTMLSelectElement>("ring-tap");
  select.replaceChildren();
  const add = (value: string, label: string) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  };
  add("@search", "Command palette");
  for (const stop of ringChoices(withBoards(theBoards()))) add(stop.id, stop.label);
  select.value = prefs.ringTap || "@search";
  select.onchange = () => {
    prefs.ringTap = select.value;
    savePrefs();
  };
}

/** What the ring holds.
 *
 * ⚠️ CHIPS, not sixteen rows with a switch each. The list is the whole
 * vocabulary of the ring — every screen and every verb — and as a column it
 * was two thirds of this pane: a wall of identical switches where the only
 * thing that varies is a word. As chips the same sixteen choices are four
 * lines, and which eight are lit can be read without reading anything.
 *
 * ⚠️ The ORDER is the list's own, not the order they were chosen. A ring
 * whose wedges move about is one where aiming stops working, which is the only
 * reason it exists.
 */
function paintRing() {
  const host = get("ring-stops");
  host.replaceChildren();
  const chosen = prefs.ringStops;
  const all = ringChoices(withBoards(theBoards()));

  const make = (stops: typeof all, title: string) => {
    if (!stops.length) return;
    const label = document.createElement("p");
    label.className = "set-sub";
    label.textContent = title;
    const grid = document.createElement("div");
    grid.className = "ring-chips";
    for (const stop of stops) {
      const chip = document.createElement("button");
      chip.type = "button";
      const on = chosen.includes(stop.id);
      /* ⚠️ A ninth cannot be lit, and the chip says so by going flat rather
       * than by accepting the press and dropping it somewhere else. */
      const full = !on && chosen.length >= 8;
      chip.className = `ring-chip${on ? " is-on" : ""}${full ? " is-full" : ""}`;
      chip.disabled = full;
      chip.setAttribute("aria-pressed", String(on));
      chip.append(taskIcon(stop.icon as TaskIcon));
      const name = document.createElement("span");
      name.textContent = stop.label;
      chip.append(name);
      chip.onclick = () => {
        const next = on
          ? prefs.ringStops.filter(one => one !== stop.id)
          : [...prefs.ringStops, stop.id];
        const order = all.map(one => one.id);
        prefs.ringStops = next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        savePrefs();
        paintRing();
      };
      grid.append(chip);
    }
    host.append(label, grid);
  };

  make(all.filter(stop => !stop.id.startsWith("act:")), "Screens");
  /* The verbs are what stop the ring being a navigation menu: each one is a
   * keystroke that would otherwise want a global shortcut of its own. */
  make(all.filter(stop => stop.id.startsWith("act:")), "Does it there and then");
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

/** The board editor: one card per board, its widgets as chips inside it.
 *
 * ⚠️ Rebuilt whole on every change rather than patched. The lists are four
 * rows of five chips; a diffing renderer here would be more code than the
 * thing it renders, and every bug in it would look like a board that forgot
 * what was on it. */
function paintBoards() {
  const host = get("boards");
  const boards = theBoards();
  host.replaceChildren();

  for (const board of boards) {
    const card = element("div", "board-card");
    card.dataset.board = board.id;

    const head = element("div", "board-head");

    /* ── Which glyph it wears ────────────────────────────────────────────
     * ⚠️ Every board used to be drawn with `home`, so a second one was a rail
     * stop, a ring wedge and a palette row identical to the first — the only
     * thing telling them apart was a name the rail does not always have room
     * for. The picker is a popover rather than sixteen buttons in the card:
     * this is a row you glance at, and a grid of glyphs on every card is more
     * of the settings window spent on boards than on everything else.
     *
     * ⚠️ HOME TOO. It is a board like any other and there is no reason it
     * cannot be a star — the exception `screenOf` makes is about its screen
     * NAME, not about what it looks like. */
    const pick = element("button", "board-icon");
    (pick as HTMLButtonElement).type = "button";
    pick.setAttribute("aria-label", `Icon for ${board.name}`);
    pick.setAttribute("aria-expanded", "false");
    pick.dataset.tip = "Icon";
    pick.append(taskIcon(board.icon));

    const sheet = element("div", "board-icons");
    sheet.hidden = true;
    for (const one of BOARD_ICONS) {
      const choice = element("button", `board-icon-one${one === board.icon ? " is-on" : ""}`);
      (choice as HTMLButtonElement).type = "button";
      choice.setAttribute("aria-label", one);
      choice.setAttribute("aria-pressed", String(one === board.icon));
      choice.append(taskIcon(one));
      choice.onclick = () => {
        setBoards(boards.map(held => (held.id === board.id ? { ...held, icon: one } : held)));
      };
      sheet.append(choice);
    }
    pick.onclick = () => {
      const open = sheet.hidden;
      /* ⚠️ Shuts every OTHER one first. Two open sheets on two cards is two
       * answers to one question, and the second one you open is over the card
       * below it — which is where the first one's rows are. */
      host.querySelectorAll<HTMLElement>(".board-icons").forEach(el => { el.hidden = true; });
      host.querySelectorAll(".board-icon").forEach(el => el.setAttribute("aria-expanded", "false"));
      sheet.hidden = !open;
      pick.setAttribute("aria-expanded", String(open));
    };
    head.append(pick);

    /* The name is an INPUT, not a label with a rename button. Renaming a board
     * is the commonest thing anybody does to one after making it, and a button
     * that swaps a label for a field is two presses for one edit. */
    const name = document.createElement("input");
    name.type = "text";
    name.className = "board-name";
    name.value = board.name;
    name.maxLength = 24;
    name.setAttribute("aria-label", `Name of ${board.name}`);
    name.onchange = () => {
      const said = name.value.trim();
      /* ⚠️ An empty name is REFUSED, not stored. A board with no name is a
       * blank rail stop and a blank palette row — unreachable except by
       * counting positions. */
      if (!said) { name.value = board.name; return; }
      setBoards(boards.map(one => (one.id === board.id ? { ...one, name: said } : one)));
    };
    head.append(name);

    if (board.id !== "home") {
      const drop = element("button", "board-drop");
      (drop as HTMLButtonElement).type = "button";
      drop.textContent = "Remove";
      drop.setAttribute("aria-label", `Remove ${board.name}`);
      /* ⚠️ Asks twice, like deleting a note. A board is minutes of arranging
       * and there is no undo; the second press disarms itself after 4s. */
      let armed = 0;
      drop.onclick = () => {
        if (!armed) {
          armed = window.setTimeout(() => {
            armed = 0;
            drop.textContent = "Remove";
            drop.classList.remove("is-armed");
          }, 4000);
          drop.textContent = "Sure?";
          drop.classList.add("is-armed");
          return;
        }
        clearTimeout(armed);
        setBoards(boards.filter(one => one.id !== board.id));
      };
      head.append(drop);
    } else {
      head.append(element("small", "board-why", "Where the island opens"));
    }
    card.append(head, sheet);

    /* ── What is on it ──────────────────────────────────────────────────
     * ⚠️ READ ONLY, and that is the decision rather than an omission. Adding,
     * moving and removing a card happens ON the board — you press the grid on
     * the island's arc and drag the things themselves, against the layout they
     * will actually have. A second editor here would be a list of chips
     * standing in for cards, which is the thing that replaced. What settings
     * still owns is the BOARDS: making one, naming it, throwing it away. */
    const rail = element("div", "board-widgets");
    const on = widgetsOf(board.widgets);
    for (const placed of on) {
      const chip = element("div", "board-chip");
      chip.title = placed.def.about;
      const mark = element("span", "board-chip-mark");
      mark.append(taskIcon(placed.def.icon));
      chip.append(mark, element("span", "board-chip-name", placed.def.label));
      /* ⚠️ The SIZE too, because settings is where you see a board's shape
       * without opening it — and a widget that is two cells wide is a different
       * thing on a board from the same widget at one. */
      chip.append(element("span", "board-chip-size", `${placed.w}×${placed.h}`));
      rail.append(chip);
    }
    if (!on.length) rail.append(element("span", "board-none", "Nothing on it yet"));
    card.append(rail);

    host.append(card);
  }

  /* ── How many more there may be ────────────────────────────────────────
   * ⚠️ The CAP IS READ, never compared against a constant here. It is a number
   * in `prefs.rs` so that a build or a plan could set it without this file
   * learning a second rule — and the button says what the limit is rather than
   * simply refusing, which is the difference between a rule and a fault. */
  const cap = Math.max(1, prefs.boardCap || DEFAULT_BOARD_CAP);
  const add = get<HTMLButtonElement>("board-add");
  add.disabled = boards.length >= cap;
  add.textContent = add.disabled ? `${cap} boards is the limit` : "New board";
  add.onclick = () => {
    if (boards.length >= cap) return;
    const id = freshId(boards);
    /* ⚠️ The first glyph nobody is using, not `home`. Two boards wearing one
     * icon is the state this picker exists to fix, and making every new board
     * start there would mean everybody meets the bug before they find the
     * cure. Falls back to `grid` once all sixteen are taken, which needs more
     * boards than the cap allows. */
    const taken = new Set(boards.map(one => one.icon));
    const icon = BOARD_ICONS.find(one => !taken.has(one)) ?? "grid";
    setBoards([...boards, { id, name: `Board ${boards.length + 1}`, icon, widgets: [] }]);
  };
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
  paintRing();
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

/* ⚠️ The four ids here have to match `sound::CHOICES` in Rust, which is the
 * VALIDATOR: anything it does not know is replaced with the default on the
 * way in, so a typo here is a setting that silently will not stick rather
 * than one that plays the wrong noise. */
onSeg("sound", value => { prefs.timerSound = value; savePrefs(); });
onSeg("helmsound", value => { prefs.helmSound = value; savePrefs(); void call("play_sound", { alias: value }).catch(() => {}); });
onSeg("pompill", value => { prefs.pomodoroPill = value; savePrefs(); });
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
 * which meant saving a shortcut silently did nothing at all. Two is now the
 * whole set, which is one fewer way to get that wrong. */
let keys: Shortcuts = { hide: "", ring: "", capture: "", talk: "" };
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
  /* ⚠️ These three MATCH the Rust defaults and the command's arguments. This
   * button sent the six keys of an older build for a while — and
   * `set_shortcuts` takes exactly its own arguments, so it failed on the
   * missing `ring` every time and "Back to the defaults" did nothing. */
  if (await run("set_shortcuts", {
    hide: "Ctrl+Alt+H", ring: "Alt+W", capture: "Ctrl+Alt+J", talk: "Alt+Q",
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
/* ⚠️ The SYMBOL, not a balance. See the note at the top of `crypto.rs`: a
 * wallet needs a key this app would then be holding, and its credentials go in
 * Windows Credential Manager through the native editor. */
interface Coin { symbol: string; name: string; price: number; changePct: number }

function sayCoin(reading: Coin | null) {
  const said = get("crypto-state");
  said.textContent = reading && reading.symbol
    ? `${reading.name} ${reading.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "Off";
  if (reading?.symbol) get<HTMLInputElement>("crypto-symbol").value = reading.symbol;
}

get("crypto-set").onclick = async () => {
  get("crypto-state").textContent = "…";
  try {
    sayCoin(await call<Coin>("set_crypto_symbol",
      { symbol: get<HTMLInputElement>("crypto-symbol").value }));
  } catch (error) {
    /* ⚠️ The MESSAGE, which for a bad pair is "No such symbol: DOGEMOON".
     * "Failed" would leave somebody retyping a symbol that does not exist. */
    get("crypto-state").textContent = String(error).replace(/^.*?: /, "");
  }
};
/* ── Helm ─────────────────────────────────────────────────────────────────
 * Two steps, like signing in to Helm itself: the address and email send a
 * code, the code signs in. ⚠️ What comes back — his session and this PC's
 * device key — goes ONE WAY into Credential Manager (Rust), like Binance's
 * secret; nothing here ever holds it. */
interface HelmReading { connected: boolean; signedIn: boolean; error: string | null; today: { nudges: unknown[] } | null; queue: { items: unknown[] } | null }

function sayHelm(helm: HelmReading | null) {
  const said = get("helm-state");
  if (!helm?.connected) { said.textContent = "Not connected"; return; }
  if (helm.error) { said.textContent = helm.error; return; }
  const queued = helm.queue?.items.length ?? 0;
  const nudges = helm.today?.nudges.length ?? 0;
  // Counts, never what's in the queue: this window can be on a shared screen.
  said.textContent = helm.signedIn
    ? `Signed in · ${queued} in the queue${nudges ? ` · ${nudges} unread` : ""}`
    : `Connected, sign in for the queue and the chat${nudges ? ` · ${nudges} unread` : ""}`;
}

get("helm-send").onclick = async () => {
  get("helm-state").textContent = "…";
  try {
    await call("helm_send_code", { url: get<HTMLInputElement>("helm-url").value, email: get<HTMLInputElement>("helm-email").value });
    get("helm-state").textContent = "Code sent. Check your email.";
    get<HTMLInputElement>("helm-code").focus();
  } catch (error) {
    get("helm-state").textContent = String(error).replace(/^.*?: /, "");
  }
};
get("helm-sign-in").onclick = async () => {
  const code = get<HTMLInputElement>("helm-code");
  get("helm-state").textContent = "…";
  try {
    sayHelm(await call<HelmReading>("helm_sign_in", { code: code.value }));
    code.value = "";
  } catch (error) {
    get("helm-state").textContent = String(error).replace(/^.*?: /, "");
  }
};
get("helm-disconnect").onclick = async () => {
  get<HTMLInputElement>("helm-code").value = "";
  if (await run("disconnect_helm", {})) sayHelm(null);
};

/* ── Binance ──────────────────────────────────────────────────────────────
 * ⚠️ The secret goes ONE WAY. It is sent once, stored in Windows Credential
 * Manager by Rust, and never read back — `binance_connected` answers with a
 * boolean, because a command that returned the key would be putting it in a
 * WebView, which is the one place it must not be.
 *
 * ⚠️ And it is cleared from the FIELD the moment it is sent. A password input
 * that still holds the secret is a secret sitting in the DOM of a window that
 * stays open all day. */
interface Wallet { connected: boolean; total: number; quote: string }

function sayWallet(held: Wallet | null) {
  const said = get("binance-state");
  said.textContent = held?.connected
    ? `${held.quote} ${held.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "Not connected";
}

get("binance-connect").onclick = async () => {
  const key = get<HTMLInputElement>("binance-key");
  const secret = get<HTMLInputElement>("binance-secret");
  get("binance-state").textContent = "…";
  try {
    const held = await call<Wallet>("connect_binance",
      { key: key.value, secret: secret.value });
    secret.value = "";
    sayWallet(held);
  } catch (error) {
    secret.value = "";
    /* ⚠️ The message, which for a bad key is our own sentence about what to
     * check — see `crypto.rs`. Never the raw error: a signed request carries
     * its signature in the query string. */
    get("binance-state").textContent = String(error).replace(/^.*?: /, "");
  }
};
get("wallet-quote-set").onclick = async () => {
  get("binance-state").textContent = "…";
  try {
    sayWallet(await call<Wallet>("set_wallet_quote",
      { quote: get<HTMLInputElement>("wallet-quote").value }));
  } catch (error) {
    get("binance-state").textContent = String(error).replace(/^.*?: /, "");
  }
};
get("binance-disconnect").onclick = async () => {
  get<HTMLInputElement>("binance-key").value = "";
  get<HTMLInputElement>("binance-secret").value = "";
  if (await run("disconnect_binance", {})) sayWallet(null);
};

get("crypto-clear").onclick = async () => {
  get<HTMLInputElement>("crypto-symbol").value = "";
  if (await run("set_crypto_symbol", { symbol: "" })) sayCoin(null);
};

/* ── Ambient mode's own folder ─────────────────────────────────────── */
interface Scenes { folder: string; files: unknown[] }
function sayScenes(s: Scenes | null) {
  const n = s?.files.length ?? 0;
  get("ambient-folder").textContent = s?.folder
    ? `${s.folder} · ${n} scene${n === 1 ? "" : "s"}`
    : "None — the generated rooms only";
  (get("ambient-clear") as HTMLButtonElement).disabled = !s?.folder;
}
get("ambient-pick").onclick = async () => {
  try {
    // The system's own folder picker; null when it was cancelled.
    const picked = await call<Scenes | null>("ambient_pick_folder");
    if (picked) sayScenes(picked);
  } catch (error) { say(String(error), "error"); }
};
get("ambient-clear").onclick = async () => {
  try { sayScenes(await call<Scenes>("ambient_set_folder", { folder: "" })); } catch (error) { say(String(error), "error"); }
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
  get<HTMLInputElement>("call-mode").checked = prefs.callMode;
  get<HTMLInputElement>("notice-mode").checked = prefs.noticeMode;
  markSeg("sound", prefs.timerSound);
  markSeg("helmsound", prefs.helmSound);
  markSeg("pompill", prefs.pomodoroPill === "time" ? "time" : "bar");
  for (const [id, key] of POMODORO) {
    const slider = get<HTMLInputElement>(id);
    slider.value = String(prefs[key]);
    get(`${id}-value`).textContent = `${prefs[key]}m`;
  }
  get<HTMLInputElement>("call-mute-mic").checked = prefs.callMuteMic;
  get<HTMLInputElement>("call-open").checked = prefs.callOpen;
  get<HTMLInputElement>("follow-live").checked = prefs.followLive;
  get<HTMLInputElement>("ring-glass").checked = prefs.ringGlass;
  get<HTMLInputElement>("spoken-replies").checked = prefs.spokenReplies;
  paintPeeks();
  get<HTMLInputElement>("home-currency").value = prefs.homeCurrency;
  get<HTMLInputElement>("ring-hold").value = String(prefs.ringHoldMs);
  get("ring-hold-value").textContent = `${(prefs.ringHoldMs / 1000).toFixed(2)}s`;
  paintTap();
  paintBoards();
  paintScreens();
  paintRing();
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
  try { sayScenes(await call<Scenes>("ambient_scenes")); } catch { sayScenes(null); }
  try { sayCoin(await call<Coin>("get_crypto")); } catch { sayCoin(null); }
  try {
    const helm = await call<HelmReading>("get_helm");
    sayHelm(helm);
    // Saved but not read yet must not read as "not connected"; see the wallet below.
    if (!helm.connected && await call<boolean>("helm_connected")) get("helm-state").textContent = "Connected, reading…";
  } catch { sayHelm(null); }
  try {
    /* ⚠️ Two questions, because they have two answers: whether a key is stored
     * at all, and what it last reported. A key that is saved but has not polled
     * yet must not read as "not connected". */
    const held = await call<Wallet | null>("get_wallet");
    if (held) {
      sayWallet(held);
      get<HTMLInputElement>("wallet-quote").value = held.quote;
    }
    else {
      sayWallet(null);
      if (await call<boolean>("binance_connected")) {
        get("binance-state").textContent = "Connected, reading…";
      }
    }
  } catch { sayWallet(null); }

  if (preview) say("Interactive preview · nothing here is saved.");
}

boot().catch(error => say(String(error), "error"));
